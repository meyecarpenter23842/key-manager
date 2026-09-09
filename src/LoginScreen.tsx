import { useEffect, useState, type FormEvent } from "react";

import { ApiError, apiBaseUrl, health, login } from "./api";
import { Field } from "./components";
import { AlertIcon, CheckIcon, KeyIcon, ShieldIcon } from "./icons";
import type { AdminIdentity } from "./types";

export function LoginScreen({ onLogin }: { onLogin: (admin: AdminIdentity) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);

  useEffect(() => {
    void health().then(setApiOnline);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    try {
      const result = await login(String(data.get("email") || ""), String(data.get("password") || ""));
      onLogin(result.admin);
    } catch (caught) {
      setError(caught instanceof ApiError
        ? { message: caught.message, detail: [caught.code, caught.requestId ? `requestId: ${caught.requestId}` : null].filter(Boolean).join(" · ") }
        : { message: "Đăng nhập thất bại" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <div className="login-decoration login-decoration-a" />
      <div className="login-decoration login-decoration-b" />
      <section className="login-brand">
        <div className="brand-mark large"><KeyIcon size={31} /></div>
        <div className="login-copy">
          <span className="eyebrow">LICENSE OPERATIONS</span>
          <h1>Quản lý license<br />gọn trong một nơi.</h1>
          <p>Tạo key, gia hạn, khóa license, quản lý thiết bị và nhiều Desktop App trên cùng một hệ thống.</p>
        </div>
        <div className="login-feature-list">
          <span><CheckIcon size={16} /> License có hạn & vĩnh viễn</span>
          <span><CheckIcon size={16} /> Device limit & revoke</span>
          <span><CheckIcon size={16} /> Ed25519 offline entitlement</span>
        </div>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <div className="login-title">
            <span className="mobile-brand"><KeyIcon size={20} /> Key Manager</span>
            <h2>Đăng nhập Admin</h2>
            <p>Dùng tài khoản quản trị đã tạo trên Admin API.</p>
          </div>
          <form onSubmit={submit} className="form-stack">
            <Field label="Email">
              <input name="email" type="email" autoComplete="username" placeholder="owner@example.com" required autoFocus />
            </Field>
            <Field label="Mật khẩu">
              <input name="password" type="password" autoComplete="current-password" placeholder="••••••••••••" required />
            </Field>
            {error ? <div className="form-error"><AlertIcon size={17} /><span><strong>{error.message}</strong>{error.detail ? <small>{error.detail}</small> : null}</span></div> : null}
            <button className="button primary full" type="submit" disabled={busy}>
              {busy ? <span className="spinner" /> : <ShieldIcon size={18} />}
              {busy ? "Đang xác thực..." : "Đăng nhập"}
            </button>
          </form>
          <footer className="login-footer">
            <span className={`connection-dot ${apiOnline === true ? "online" : apiOnline === false ? "offline" : "checking"}`} />
            <div>
              <strong>{apiOnline === true ? "Admin API sẵn sàng" : apiOnline === false ? "Admin API chưa kết nối" : "Đang kiểm tra API"}</strong>
              <small>{apiBaseUrl()}</small>
            </div>
          </footer>
        </div>
      </section>
    </main>
  );
}
