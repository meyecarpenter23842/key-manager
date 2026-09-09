# Key Manager API

The server hosts both the authenticated Admin API and the Public License API. It is the only component allowed to receive `DATABASE_URL`; Desktop Apps never connect to PostgreSQL directly.

## Security model

- Admin passwords are hashed with Node.js `scrypt` using a random per-password salt. Plaintext passwords are never stored.
- Login returns a cryptographically random opaque bearer token. PostgreSQL stores only its SHA-256 hash.
- Sessions expire server-side and can be revoked immediately on logout.
- A disabled admin cannot authenticate even when an unexpired session row still exists.
- Every `/api/admin/v1/*` route except login authenticates the session on the server.
- RBAC is enforced in the API, not by hiding desktop buttons.
- OWNER can manage admin accounts. ADMIN can manage applications/licenses/customers/devices but not admin accounts. STAFF can read applications, read/write customers, create licenses and renew licenses; revoke/archive/device-limit changes remain restricted.
- Important auth, application, customer, license and device changes are written to `audit_logs`.
- Raw license keys are generated with 128 bits of cryptographic randomness and returned only by the create-license response. PostgreSQL stores only a SHA-256 digest plus a masked preview.
- License list/detail/customer-detail responses never include `license_key_hash`. Public License API responses and structured request logs never include the raw key or hash.
- Expired subscriptions are rejected using server time; Desktop Apps do not decide validity from the local clock.
- Device activation serializes on the owning license row before counting active devices, so concurrent requests cannot exceed `max_devices`.
- Client deactivation uses `INACTIVE`; administrative device revocation uses `REVOKED`. An inactive device may activate again if a slot is available, while a revoked device cannot self-reactivate.

## Local setup

Run the ordered database migrations first. Phase 6 adds `0006_device_inactive_status.sql` and `0007_device_inactive_constraint.sql`, in that order.

```powershell
$env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/key_manager_dev"
pnpm run db:migrate
$env:ADMIN_API_HOST="127.0.0.1"
$env:ADMIN_API_PORT="3001"
$env:LICENSE_API_RATE_LIMIT_MAX="120"
$env:LICENSE_API_RATE_LIMIT_WINDOW_SECONDS="60"
```

Bootstrap the first OWNER without putting the password in source code:

```powershell
$env:KEY_MANAGER_OWNER_EMAIL="owner@example.com"
$env:KEY_MANAGER_OWNER_PASSWORD="replace-with-a-long-password"
pnpm admin:create-owner
Remove-Item Env:KEY_MANAGER_OWNER_EMAIL
Remove-Item Env:KEY_MANAGER_OWNER_PASSWORD
```

Start the API:

```powershell
pnpm server:start
```

Check it from another terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:3001/health
```

For production, terminate TLS at a trusted reverse proxy/load balancer or equivalent HTTPS endpoint. Do not expose the plain HTTP listener directly to the internet. Database credentials and future private signing keys stay server-side.

## Public License API v1

Desktop Apps call these endpoints over HTTPS:

- `POST /api/v1/license/activate`
- `POST /api/v1/license/validate`
- `POST /api/v1/license/heartbeat`
- `POST /api/v1/license/deactivate`

Activate/heartbeat payload:

```json
{
  "appCode": "DESKTOP_PRO",
  "licenseKey": "DESKTOP_PRO-01234567-89ABCDEF-01234567-89ABCDEF",
  "deviceId": "stable-device-fingerprint",
  "deviceName": "Office PC",
  "os": "Windows 11",
  "appVersion": "2.1.0"
}
```

Validate requires `appCode`, `licenseKey`, `deviceId`, and `appVersion`. Deactivate requires `appCode`, `licenseKey`, and `deviceId`; `appVersion` is optional because deactivation should not be blocked by a minimum-version policy.

Successful responses contain only public operational data:

```json
{
  "status": "ACTIVE",
  "serverTime": "2026-09-09T14:00:00.000Z",
  "application": {
    "id": "uuid",
    "appCode": "DESKTOP_PRO",
    "currentVersion": "2.5.0",
    "minimumVersion": "2.0.0",
    "offlineGraceSeconds": 86400
  },
  "license": {
    "id": "uuid",
    "type": "SUBSCRIPTION",
    "expiresAt": "2026-10-09T00:00:00.000Z",
    "maxDevices": 2
  },
  "device": {
    "id": "uuid",
    "deviceId": "stable-device-fingerprint",
    "status": "ACTIVE",
    "activatedAt": "...",
    "lastSeenAt": "..."
  },
  "requestId": "correlation-id"
}
```

Validation order for activate/validate/heartbeat is: requested application exists and is active, key exists, key belongs to that application, license is not archived/revoked/expired, app version meets the configured minimum, device is not revoked, then device-limit enforcement for activation. License status/expiry and device state are rechecked while the owning license row is locked before mutating device state.

Public error codes:

- `INVALID_REQUEST`
- `INVALID_LICENSE`
- `LICENSE_EXPIRED`
- `LICENSE_REVOKED`
- `WRONG_APPLICATION`
- `DEVICE_LIMIT_REACHED`
- `DEVICE_REVOKED`
- `APPLICATION_DISABLED`
- `UPDATE_REQUIRED`
- `RATE_LIMITED`
- `SERVER_ERROR`

Every public response includes `x-request-id`; the JSON body also includes `requestId`. A caller-supplied `x-request-id` is preserved up to the server limit. Public routes use a fixed-window per-client-IP rate limit configured by `LICENSE_API_RATE_LIMIT_MAX` and `LICENSE_API_RATE_LIMIT_WINDOW_SECONDS`. A limited request returns HTTP 429, `RATE_LIMITED`, `Retry-After`, and rate-limit headers.

Structured public request logs are one JSON object per line with correlation id, method, route, status, duration and client IP. Request bodies, raw license keys and key hashes are never logged.

### Device lifecycle

- First activation creates an ACTIVE device and consumes one slot.
- Repeating activation for the same ACTIVE `deviceId` is idempotent and refreshes metadata/`last_seen_at`.
- `deactivate` changes the device to `INACTIVE`, releases its slot, and writes `DEVICE_DEACTIVATED` event/audit records.
- An INACTIVE device may activate again later if the device limit permits it.
- Admin revoke changes the device to `REVOKED`; that device cannot self-reactivate and receives `DEVICE_REVOKED`.
- `heartbeat` refreshes metadata and `last_seen_at` only for an ACTIVE, valid device.
- `validate` checks validity without changing `last_seen_at`.

## Auth/admin endpoints

- `POST /api/admin/v1/auth/login`
- `GET /api/admin/v1/auth/me`
- `POST /api/admin/v1/auth/logout`
- `GET /api/admin/v1/admins` — OWNER only
- `POST /api/admin/v1/admins` — OWNER only

## Applications

- `GET /api/admin/v1/applications?q=&status=&limit=&offset=` — OWNER/ADMIN/STAFF
- `POST /api/admin/v1/applications` — OWNER/ADMIN
- `GET /api/admin/v1/applications/:id` — OWNER/ADMIN/STAFF
- `PATCH /api/admin/v1/applications/:id` — OWNER/ADMIN

Application create/update supports `name`, `appCode`, `description`, `currentVersion`, `minimumVersion`, `status`, `offlineGraceSeconds`, `defaultDeviceLimit`, `defaultDurationDays`, and `allowLifetime`. `appCode` is normalized to uppercase and remains protected by the database unique constraint.

## Customers

- `GET /api/admin/v1/customers?q=&limit=&offset=` — OWNER/ADMIN/STAFF
- `POST /api/admin/v1/customers` — OWNER/ADMIN/STAFF
- `GET /api/admin/v1/customers/:id` — OWNER/ADMIN/STAFF
- `PATCH /api/admin/v1/customers/:id` — OWNER/ADMIN/STAFF

Customer search covers name, phone, email and company. Customer detail includes associated licenses, application identity, device rows/counts, effective expiry/status and renewal history events already stored in `license_events`.

## Licenses

- `GET /api/admin/v1/licenses?q=&applicationId=&customerId=&licenseType=&status=&expiringWithinDays=&limit=&offset=` — OWNER/ADMIN/STAFF
- `POST /api/admin/v1/licenses` — OWNER/ADMIN/STAFF
- `GET /api/admin/v1/licenses/:id` — OWNER/ADMIN/STAFF
- `POST /api/admin/v1/licenses/:id/renew` — OWNER/ADMIN/STAFF
- `POST /api/admin/v1/licenses/:id/revoke` — OWNER/ADMIN
- `POST /api/admin/v1/licenses/:id/reactivate` — OWNER/ADMIN
- `POST /api/admin/v1/licenses/:id/archive` — OWNER/ADMIN
- `PATCH /api/admin/v1/licenses/:id/device-limit` — OWNER/ADMIN

Create payload:

```json
{
  "applicationId": "uuid",
  "customerId": "uuid-or-null",
  "licenseType": "SUBSCRIPTION",
  "durationDays": 30,
  "maxDevices": 2,
  "note": "optional"
}
```

For `SUBSCRIPTION`, omitted `durationDays` and `maxDevices` use the application's defaults. For `LIFETIME`, `expiresAt` is null and `durationDays` must be omitted; creation/conversion is rejected when the application has `allowLifetime=false`.

The create response is the only response that contains the raw key:

```json
{
  "license": { "id": "...", "licenseKeyPreview": "****-****-89ABCDEF" },
  "licenseKey": "APP_CODE-01234567-89ABCDEF-01234567-89ABCDEF"
}
```

Exact raw-key search is supported without storing plaintext: the server hashes the search candidate and compares it with `license_key_hash`. General search also covers masked preview, application name/code and customer name/phone/email/company.

A subscription that is still valid extends from its current expiry. An expired subscription extends from server `now()` and becomes active immediately unless it is revoked. Renewing a revoked license preserves `REVOKED`. Reactivating a revoked but already expired subscription yields `EXPIRED`, so it still requires renewal. Archived licenses cannot be renewed, revoked or have their device limit changed.

Device-limit changes cannot lower `maxDevices` below the current number of active devices.

## Admin devices

- `GET /api/admin/v1/devices?q=&licenseId=&status=&limit=&offset=` — OWNER/ADMIN/STAFF; status supports `ACTIVE`, `INACTIVE`, `REVOKED`
- `POST /api/admin/v1/devices/:id/revoke` — OWNER/ADMIN

Activate, deactivate and admin revoke all serialize on the owning license row, preserving a consistent lock order around device-limit decisions. Device events include `DEVICE_ACTIVATED`, `DEVICE_DEACTIVATED`, and `DEVICE_REVOKED`, with matching audit records for state-changing operations.
