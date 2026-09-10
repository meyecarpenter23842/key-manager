import { useEffect, useState, type FormEvent } from "react";

import { ensureAdminApiRuntime } from "./adminApiRuntime";
import { ApiError, apiBaseUrl, health, login } from "./api";
import { Field } from "./components";
import { AlertIcon, KeyIcon, ShieldIcon } from "./icons";
import type { AdminIdentity } from "./types";

export function LoginScreen({ onLogin }: { onLogin: (admin: AdminIdentity) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);
  const [apiManaged, setApiManaged] = useState(false);
  const [apiDetail, setApiDetail] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void ensureAdminApiRuntime()
      .then(async (runtime) => {
        if (!active) return;
        setApiManaged(runtime.managed);
        setApiDetail(runtime.detail);
        setApiOnline(runtime.online || (await health()));
      })
      .catch(async (caught) => {
        if (!active) return;
        setApiDetail(caught instanceof Error ? caught.message : String(caught));
        setApiOnline(await health());
      });
    return () => {
      active = false;
    };
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
      <section className="login-panel">
        <div className="login-card">
          <div className="login-brand-inline">
            <span className="brand-mark"><KeyIcon size={20} /></span>
            <div>
              <strong>Key Manager</strong>
              <small>License Administration</small>
            </div>
          </div>
          <div className="login-title">
            <h1>Đăng nhập Admin</h1>
            <p>Đăng nhập để quản lý license, thiết bị và các ứng dụng đã kết nối.</p>
          </div>
          <form onSubmit={submit} className="form-stack">
            <Field label="Email">
              <input name="email" type="email" autoComplete="username" placeholder="owner@example.com" required autoFocus />
            </Field>
            <Field label="Mật khẩu">
              <input name="password" type="password" autoComplete="current-password" placeholder="••••••••••••" required />
            </Field>
            {error ? <div className="form-error"><AlertIcon size={17} /><span><strong>{error.message}</strong>{error.detail ? <small>{error.detail}</small> : null}</span></div> : null}
            <button className="button primary full" type="submit" disabled={busy || apiOnline === false}>
              {busy ? <span className="spinner" /> : <ShieldIcon size={18} />}
              {busy ? "Đang xác thực..." : "Đăng nhập"}
            </button>
          </form>
          <footer className="login-footer">
            <span className={`connection-dot ${apiOnline === true ? "online" : apiOnline === false ? "offline" : "checking"}`} />
            <div>
              <strong>{apiOnline === true ? `Admin API sẵn sàng${apiManaged ? " · tự chạy" : ""}` : apiOnline === false ? "Admin API chưa kết nối" : "Đang khởi động Admin API"}</strong>
              <small title={apiDetail || apiBaseUrl()}>{apiDetail || apiBaseUrl()}</small>
            </div>
          </footer>
        </div>
      </section>
    </main>
  );
}
