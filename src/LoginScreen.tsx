import { useEffect, useState, type FormEvent } from "react";

import { configureAdminApi, ensureAdminApiRuntime } from "./adminApiRuntime";
import { ApiError, apiBaseUrl, health, login } from "./api";
import { Field } from "./components";
import { AlertIcon, KeyIcon, ShieldIcon } from "./icons";
import type { AdminIdentity } from "./types";

export function LoginScreen({ onLogin }: { onLogin: (admin: AdminIdentity) => void }) {
  const [busy, setBusy] = useState(false);
  const [configBusy, setConfigBusy] = useState(false);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);
  const [apiManaged, setApiManaged] = useState(false);
  const [apiDetail, setApiDetail] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let checking = false;

    async function refreshRuntime() {
      if (checking) return;
      checking = true;
      try {
        const runtime = await ensureAdminApiRuntime();
        const online = runtime.online || (await health());
        if (!active) return;
        setApiManaged(runtime.managed);
        setApiDetail(runtime.detail);
        setApiOnline(online);
      } catch (caught) {
        const online = await health();
        if (!active) return;
        setApiManaged(false);
        setApiDetail(caught instanceof Error ? caught.message : String(caught));
        setApiOnline(online);
      } finally {
        checking = false;
      }
    }

    void refreshRuntime();
    const timer = window.setInterval(() => void refreshRuntime(), 5_000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const needsApiConfig = apiDetail?.startsWith("ADMIN_API_CONFIG_MISSING") ?? false;

  async function submitApiConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setConfigBusy(true);
    setConfigError(null);
    const data = new FormData(event.currentTarget);
    try {
      await configureAdminApi(String(data.get("databaseUrl") || ""));
      const runtime = await ensureAdminApiRuntime();
      const online = runtime.online || (await health());
      setApiManaged(runtime.managed);
      setApiDetail(runtime.detail);
      setApiOnline(online);
      if (!online) {
        setConfigError(runtime.detail || "Admin API chưa sẵn sàng sau khi lưu cấu hình.");
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setApiDetail(message);
      setApiOnline(false);
      setConfigError(message);
    } finally {
      setConfigBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") || "");
    const password = String(data.get("password") || "");

    try {
      let result;
      try {
        result = await login(email, password);
      } catch (caught) {
        if (!(caught instanceof ApiError) || caught.code !== "NETWORK_ERROR") throw caught;

        const runtime = await ensureAdminApiRuntime();
        const online = runtime.online || (await health());
        setApiManaged(runtime.managed);
        setApiDetail(runtime.detail);
        setApiOnline(online);
        if (!online) throw caught;

        result = await login(email, password);
      }
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
            <h1>{needsApiConfig ? "Cấu hình Admin API" : "Đăng nhập Admin"}</h1>
            <p>{needsApiConfig
              ? "Thiết lập kết nối backend một lần trên máy này. DATABASE_URL được lưu trong cấu hình server-only và không được đưa vào frontend."
              : "Đăng nhập để quản lý license, thiết bị và các ứng dụng đã kết nối."}</p>
          </div>

          {needsApiConfig ? (
            <form onSubmit={submitApiConfig} className="form-stack api-bootstrap">
              <Field label="DATABASE_URL">
                <input
                  name="databaseUrl"
                  type="password"
                  autoComplete="off"
                  placeholder="postgresql://user:password@host:5432/database"
                  required
                  autoFocus
                />
              </Field>
              {configError ? <div className="form-error"><AlertIcon size={17} /><span><strong>Không thể khởi động Admin API</strong><small>{configError}</small></span></div> : null}
              <button className="button primary full" type="submit" disabled={configBusy}>
                {configBusy ? <span className="spinner" /> : <ShieldIcon size={18} />}
                {configBusy ? "Đang lưu và khởi động..." : "Lưu và khởi động Admin API"}
              </button>
              <small className="api-bootstrap-note">Chỉ lưu cấu hình server trên máy này. Key Manager vẫn giao tiếp với database thông qua Admin API.</small>
            </form>
          ) : (
            <form onSubmit={submit} className="form-stack">
              <Field label="Email">
                <input name="email" type="email" autoComplete="username" placeholder="owner@example.com" required autoFocus />
              </Field>
              <Field label="Mật khẩu">
                <input name="password" type="password" autoComplete="current-password" placeholder="••••••••••••" required />
              </Field>
              {error ? <div className="form-error"><AlertIcon size={17} /><span><strong>{error.message}</strong>{error.detail ? <small>{error.detail}</small> : null}</span></div> : null}
              <button className="button primary full" type="submit" disabled={busy || apiOnline !== true}>
                {busy ? <span className="spinner" /> : <ShieldIcon size={18} />}
                {busy ? "Đang xác thực..." : "Đăng nhập"}
              </button>
            </form>
          )}

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
