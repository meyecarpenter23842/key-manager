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

## Chạy Admin Desktop UI local

Admin UI Phase 8 gọi **Admin API thật**, không dùng mock data và không truy cập PostgreSQL trực tiếp. Vì vậy cần chạy backend và desktop ở hai terminal.

Terminal 1 — Admin API:

```powershell
cd F:\1_A_Disk_D\key-manager
$env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/key_manager_dev"
$env:ADMIN_API_ALLOWED_ORIGINS="http://localhost:1420"
pnpm server:start
```

Terminal 2 — Tauri desktop:

```powershell
cd F:\1_A_Disk_D\key-manager
$env:VITE_ADMIN_API_URL="http://127.0.0.1:3001"
pnpm tauri dev
```

Lệnh trên mở cửa sổ native **Key Manager** với login, dashboard, Applications, Customers, Licenses, Devices và quản trị admin theo RBAC. Session token chỉ được giữ trong session storage của WebView; server vẫn là nơi enforce authentication và permission.

Nếu database phát triển chưa có OWNER, bootstrap một lần trước khi login:

```powershell
$env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/key_manager_dev"
$env:KEY_MANAGER_OWNER_EMAIL="owner@example.com"
$env:KEY_MANAGER_OWNER_PASSWORD="replace-with-a-long-password"
pnpm admin:create-owner
Remove-Item Env:KEY_MANAGER_OWNER_EMAIL
Remove-Item Env:KEY_MANAGER_OWNER_PASSWORD
```

`admin:create-owner` chỉ dùng để bootstrap OWNER đầu tiên; không chạy lại nếu đã có active OWNER.

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

Admin API giữ database credential và thực thi authentication/RBAC ở server; Desktop App chỉ được gọi API qua HTTP(S). Local development dùng `http://127.0.0.1:3001`; production phải dùng endpoint HTTPS tin cậy và CORS origin rõ ràng.

Xem `server/README.md` để biết auth endpoints, session model và role permissions.

## Admin Desktop UI

UI quản trị được thiết kế desktop-first và nối trực tiếp vào các contract đã có:

- Dashboard tổng quan applications, customers, licenses và devices.
- Applications: tạo/sửa app code, version, offline grace, device/duration defaults và lifetime policy.
- Customers: tìm kiếm, tạo và sửa hồ sơ.
- Licenses: tìm/filter, tạo key, copy raw key đúng một lần, xem lịch sử, gia hạn, chuyển lifetime, revoke/reactivate/archive và đổi device limit.
- Devices: tìm/filter trạng thái và revoke theo quyền.
- Admin team: OWNER có thể xem và tạo tài khoản theo role.
- API error hiển thị error code và `requestId` để đối chiếu log.

Frontend chỉ ẩn/hiện action theo role để UX rõ hơn; **RBAC quyết định cuối cùng luôn ở Admin API**.

## Offline license signing

Phase 7 dùng Ed25519 để server phát signed offline entitlement sau online `activate`, `validate` hoặc `heartbeat`. Private signing key chỉ tồn tại ở server; Desktop Apps chỉ embed public key và luôn bị giới hạn bởi `offline_valid_until`, kể cả license lifetime.

Xem `docs/offline-license-v1.md` để biết token contract, key rotation, refresh/revoke behavior và chiến lược trusted server time chống clock rollback ở mức MVP.

## Build desktop

```powershell
pnpm tauri build
```

Khi build/deploy production, đặt `VITE_ADMIN_API_URL` thành Admin API HTTPS public trước bước frontend build. Không đưa `DATABASE_URL`, signing private key hoặc secret backend vào `VITE_*`.

## Cấu trúc

```text
src/                  React desktop Admin UI + API client
src-tauri/            Tauri/Rust native shell
src-tauri/src/        Native commands và desktop integration
server/src/           Admin API server, auth, RBAC, PostgreSQL repository
server/scripts/       Trusted server/bootstrap tooling
server/tests/         Admin API integration tests
docs/                 Security/contract documentation
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
- UI desktop chỉ gọi Admin API qua HTTPS ở production.
- Authentication và RBAC được enforce ở Admin API, không tin quyền do UI gửi lên.
- Raw license key chỉ tồn tại trong response tạo key và state tạm thời của màn hình copy một lần; không persist vào storage.
- `VITE_*` chỉ được dùng cho dữ liệu public/config không nhạy cảm.
- `DATABASE_URL`/`PG*` chỉ dành cho migration tooling hoặc backend trusted environment, không được đổi thành biến `VITE_*`.

Ảnh `12.jpg` ở root chỉ là UI reference.
