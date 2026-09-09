# Admin API authentication and RBAC

The Admin API is server infrastructure. It is not bundled into the Tauri desktop app and it is the only component allowed to receive `DATABASE_URL`.

## Security model

- Admin passwords are hashed with Node.js `scrypt` using a random per-password salt. Plaintext passwords are never stored.
- Login returns a cryptographically random opaque bearer token. PostgreSQL stores only its SHA-256 hash.
- Sessions expire server-side and can be revoked immediately on logout.
- A disabled admin cannot authenticate even when an unexpired session row still exists.
- Every `/api/admin/v1/*` route except login authenticates the session on the server.
- RBAC is enforced in the API, not by hiding desktop buttons.
- OWNER can manage admin accounts. ADMIN can manage applications/licenses/customers/devices but not admin accounts. STAFF can view, create and renew licenses but cannot revoke/archive licenses or manage admins.
- Login success/failure, logout, owner bootstrap and admin creation are written to `audit_logs`.

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

## Auth endpoints

- `POST /api/admin/v1/auth/login`
- `GET /api/admin/v1/auth/me`
- `POST /api/admin/v1/auth/logout`
- `GET /api/admin/v1/admins` — OWNER only
- `POST /api/admin/v1/admins` — OWNER only

The desktop app may receive only the public Admin API URL plus an authenticated session token. Database credentials and future private signing keys stay on the server.
