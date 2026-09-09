# Key Manager

Centralized License Management System for multiple Desktop Applications.

This repository is being built from scratch. The original UI image in the repository is reference material only; it is not an implementation dependency.

## Stack

- Next.js 16 App Router
- React 19
- TypeScript
- pnpm
- Vitest
- ESLint + Prettier
- PostgreSQL/Supabase will be wired in Phase 1

## Requirements

- Node.js 22+
- pnpm 12.3.4 (declared in `packageManager`)

With Corepack:

```bash
corepack enable
corepack prepare pnpm@12.3.4 --activate
```

## Local setup

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

Open `http://localhost:3000`.

## Quality commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Run all required CI checks locally:

```bash
pnpm ci
```

## Project boundaries

```text
src/
  app/                 Next.js App Router, UI and HTTP route handlers
    api/admin/          Authenticated Admin API routes (future phases)
    api/v1/license/     Public Desktop License API routes (future phases)
  domain/              License/application/customer/device business rules
  server/
    admin/              Admin-only services and authorization boundary
    license/            Public License API orchestration boundary
  lib/                  Shared infrastructure helpers
```

Architecture rules:

- Desktop Apps never access the database directly.
- Public License API and Admin API stay as separate trust boundaries.
- License business rules belong in the domain/service layer, not React components or route handlers.
- A license must always be scoped to its application.
- Secrets and signing private keys are server-only.

## API health check

`GET /api/health` returns a minimal service health response and is safe for deployment verification.

## CI

GitHub Actions runs the required Phase 0 checks on pull requests and pushes to `main`:

1. install dependencies
2. lint
3. typecheck
4. tests
5. production build

## Phase status

Phase 0 establishes only the project foundation. Database schema, authentication, license rules, device rules and License API behavior are intentionally implemented in later phases from the master execution plan in Issue #1.
