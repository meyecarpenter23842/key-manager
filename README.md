# Key Manager

Centralized License Management System cho nhiều Desktop App.

## Nền tảng

Key Manager Admin là **desktop app**, không phải web app:

- Tauri 2
- React 19
- TypeScript
- Vite
- Rust
- pnpm 10.34.4

Admin API / License API và PostgreSQL/Supabase là backend online riêng. Key Manager Desktop và các Desktop App khách chỉ giao tiếp với backend qua HTTPS; không truy cập database trực tiếp.

## Yêu cầu Windows

1. Node.js 22+
2. pnpm 10.34.4
3. Rust stable MSVC
4. Microsoft C++ Build Tools / Visual Studio Build Tools với workload **Desktop development with C++**
5. WebView2 Runtime (Windows 10/11 thường đã có)
6. PostgreSQL 16 + `psql` nếu chạy migration/backend local

Kiểm tra nhanh:

```powershell
node -v
pnpm -v
rustc -V
cargo -V
psql --version
```

Nếu chưa có Rust:

```powershell
winget install --id Rustlang.Rustup
rustup default stable-msvc
```

## Chạy desktop app

```powershell
pnpm install
pnpm tauri dev
```

Lệnh trên phải mở cửa sổ native **Key Manager**.

## Quality checks

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

## Database schema / migrations

PostgreSQL schema nằm trong `database/`. Migration chạy từ trusted developer/CI/backend environment, không chạy từ Desktop App.

```powershell
$env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/key_manager_dev"
pnpm db:check
pnpm db:migrate
Remove-Item Env:DATABASE_URL
```

`pnpm db:test` dành cho CI/schema verification; khi local database đã có dữ liệu phát triển thì không cần chạy lặp lại.

Xem `database/README.md` để biết quy tắc migration forward-only/checksum.

## Admin API authentication / RBAC

Phase 2 backend nằm trong `server/`. Admin API giữ database credential và thực thi authentication/RBAC ở server; Desktop App chỉ được gọi API qua HTTPS.

```powershell
$env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/key_manager_dev"
$env:KEY_MANAGER_OWNER_EMAIL="owner@example.com"
$env:KEY_MANAGER_OWNER_PASSWORD="replace-with-a-long-password"
pnpm admin:create-owner
Remove-Item Env:KEY_MANAGER_OWNER_EMAIL
Remove-Item Env:KEY_MANAGER_OWNER_PASSWORD
pnpm server:start
```

Xem `server/README.md` để biết auth endpoints, session model và role permissions.

## Build desktop

```powershell
pnpm tauri build
```

## Cấu trúc

```text
src/                  React desktop UI
src-tauri/            Tauri/Rust native shell
src-tauri/src/        Native commands và desktop integration
server/src/           Admin API server, auth, RBAC, PostgreSQL repository
server/scripts/       Trusted server/bootstrap tooling
server/tests/         Admin API integration tests
database/migrations/  Ordered PostgreSQL migrations
database/tests/       Database schema/constraint tests
scripts/database.mjs  Migration/test runner dùng psql
tests/                Unit/frontend tests
.github/workflows/    CI
```

## Nguyên tắc kiến trúc

- Không đưa database credentials vào desktop app.
- Không đưa license signing private key vào desktop app.
- Không để Desktop App truy cập PostgreSQL/Supabase trực tiếp.
- Public License API và Admin API là backend online riêng.
- UI desktop chỉ gọi Admin API qua HTTPS.
- Authentication và RBAC được enforce ở Admin API, không tin quyền do UI gửi lên.
- `VITE_*` chỉ được dùng cho dữ liệu public/config không nhạy cảm.
- `DATABASE_URL`/`PG*` chỉ dành cho migration tooling hoặc backend trusted environment, không được đổi thành biến `VITE_*`.

Ảnh `12.jpg` ở root chỉ là UI reference.
