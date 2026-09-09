# Database migrations

Phase 1 uses ordered, forward-only PostgreSQL migrations. The database is server infrastructure; Key Manager Desktop and customer Desktop Apps must never receive database credentials or a private signing key.

## Layout

- `migrations/NNNN_name.sql`: immutable ordered migrations.
- `tests/NNNN_name.sql`: schema/constraint tests.
- `../scripts/database.mjs`: migration runner using the local `psql` client.

The runner creates `public.schema_migrations`, stores a SHA-256 checksum for every applied migration, and rejects edits/renames of an already-applied version. Production fixes should be a new forward migration instead of rewriting migration history.

## Local PostgreSQL on Windows

Requirements: Node.js 22+, pnpm, Docker Desktop (or another PostgreSQL 16 server), and `psql` available on `PATH`.

```powershell
docker run --name key-manager-postgres `
  -e POSTGRES_PASSWORD=postgres `
  -e POSTGRES_DB=key_manager_dev `
  -p 5432:5432 `
  -d postgres:16

$env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/key_manager_dev"
pnpm db:check
pnpm db:migrate
pnpm db:test
Remove-Item Env:DATABASE_URL
```

`DATABASE_URL` is for developer/CI migration tooling only. Do not rename it to `VITE_DATABASE_URL`, do not read it from React/Tauri code, and do not package it with the desktop application.

To prove migrations against another empty database, create a fresh database and run `pnpm db:test` again. `db:test` applies any pending migrations before executing the SQL tests.

## Current invariants

- `applications.app_code` is unique and normalized to uppercase-style codes.
- Raw license keys are not persisted; `licenses` stores a cryptographic binary hash and a masked preview.
- License key hashes are globally unique so one raw key cannot represent licenses for two applications.
- `SUBSCRIPTION` requires `expires_at`; `LIFETIME` requires `expires_at IS NULL`.
- License statuses are `ACTIVE`, `EXPIRED`, `REVOKED`, `ARCHIVED`.
- A `(license_id, device_id)` pair is unique, preventing duplicate device rows for one license.
- Admin email lookup is case-insensitive unique.
- License events and system audit logs retain actor/request metadata.

## Supabase / production

These migrations are standard PostgreSQL and only require `pgcrypto`, which provides `gen_random_uuid()`. Run migrations from trusted backend/CI infrastructure with server-only credentials. Desktop applications continue to communicate only with the HTTPS License/Admin API.
