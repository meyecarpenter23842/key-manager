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

License API và PostgreSQL/Supabase sẽ là backend online riêng. Key Manager Desktop và các Desktop App khách chỉ giao tiếp với backend qua HTTPS; không truy cập database trực tiếp.

## Yêu cầu Windows

1. Node.js 22+
2. pnpm 10.34.4
3. Rust stable MSVC
4. Microsoft C++ Build Tools / Visual Studio Build Tools với workload **Desktop development with C++**
5. WebView2 Runtime (Windows 10/11 thường đã có)

Kiểm tra nhanh:

```powershell
node -v
pnpm -v
rustc -V
cargo -V
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

## Build desktop

```powershell
pnpm tauri build
```

## Cấu trúc

```text
src/                  React desktop UI
src-tauri/            Tauri/Rust native shell
src-tauri/src/        Native commands và desktop integration
tests/                Frontend tests
.github/workflows/    CI
```

## Nguyên tắc kiến trúc

- Không đưa database credentials vào desktop app.
- Không đưa license signing private key vào desktop app.
- Không để Desktop App truy cập PostgreSQL/Supabase trực tiếp.
- Public License API và Admin API sẽ được triển khai thành backend online riêng.
- UI desktop chỉ gọi Admin API qua HTTPS.
- `VITE_*` chỉ được dùng cho dữ liệu public/config không nhạy cảm.

Ảnh `12.jpg` ở root chỉ là UI reference.
