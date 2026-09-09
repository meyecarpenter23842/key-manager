# Admin API

The Admin API is server infrastructure. It is not bundled into the Tauri desktop app and it is the only component allowed to receive `DATABASE_URL`.

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
- License list/detail/customer-detail responses never include `license_key_hash`. Audit/event metadata never stores raw keys or hashes.
- Expired subscriptions are projected as `EXPIRED` by the Admin API even if their stored operational status was still `ACTIVE`; revoke/archive take precedence over expiry.
- Device activation serializes on the owning license row before counting active devices, so concurrent requests cannot exceed `max_devices`.

## Local setup

Run the ordered database migrations first. Then configure server-only environment values in the shell:

```powershell
$env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/key_manager_dev"
$env:ADMIN_API_HOST="127.0.0.1"
$env:ADMIN_API_PORT="3001"
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

For production, terminate TLS at a trusted reverse proxy/load balancer or equivalent HTTPS endpoint before exposing the Admin API. Do not expose this plain HTTP listener directly to the internet.

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

Renew payloads use exactly one of:

```json
{ "durationDays": 30 }
```

or:

```json
{ "toLifetime": true }
```

A subscription that is still valid extends from its current expiry. An expired subscription extends from server `now()` and becomes active immediately unless it is revoked. Renewing a revoked license preserves `REVOKED`. Reactivating a revoked but already expired subscription yields `EXPIRED`, so it still requires renewal. Archived licenses cannot be renewed, revoked or have their device limit changed.

Device-limit changes cannot lower `maxDevices` below the current number of active devices.

## Devices

- `GET /api/admin/v1/devices?q=&licenseId=&status=&limit=&offset=` — OWNER/ADMIN/STAFF
- `POST /api/admin/v1/devices/:id/revoke` — OWNER/ADMIN

Phase 5 keeps device activation in the server-side device domain instead of exposing a Desktop endpoint early. The public `POST /api/v1/license/activate` contract remains Phase 6 and will call the same device service only after application/key/version/license checks are complete.

Activation behavior:

- The license row is locked with `FOR UPDATE` before the active-device count is read.
- An already-active identical `device_id` is idempotent: it updates `last_seen_at` and supplied metadata without consuming another slot.
- A previously revoked `device_id` returns `DEVICE_REVOKED` and is not silently reactivated.
- A new device is rejected with `DEVICE_LIMIT_REACHED` when the active count is already at `max_devices`.
- Revoke changes the device to `REVOKED`, sets `revoked_at`, and immediately releases that slot for another device.
- Device metadata includes `device_name`, `os`, `app_version`, `activated_at`, and `last_seen_at`.
- `DEVICE_ACTIVATED` and `DEVICE_REVOKED` are written to `license_events`; matching audit records are written in the same transaction.

Because activate and revoke both take the same license-row lock first, concurrent activation/revoke operations for one license use a consistent lock order and cannot race the device-limit count.

Every license mutation writes `license_events` and `audit_logs` in the same database transaction as the license update. Events include `LICENSE_CREATED`, `LICENSE_RENEWED`, `LICENSE_CHANGED_TO_LIFETIME`, `LICENSE_REVOKED`, `LICENSE_REACTIVATED`, `LICENSE_ARCHIVED`, `DEVICE_LIMIT_CHANGED`, `DEVICE_ACTIVATED`, and `DEVICE_REVOKED`.

The desktop app may receive only the public Admin API URL plus an authenticated session token for administration. Database credentials and future private signing keys stay on the server. Desktop license validation remains a separate public License API phase and must go through HTTPS rather than direct PostgreSQL access.
