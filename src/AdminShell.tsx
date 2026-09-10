import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, apiBaseUrl, clearSession, health, logout } from "./api";
import { type ErrorHandler, type Notify } from "./components";
import { DashboardPage } from "./DashboardPage";
import { ApplicationsPage } from "./ApplicationsPage";
import { CustomersPage } from "./CustomersPage";
import { DevicesPage } from "./DevicesPage";
import { LicensesPage } from "./LicensesPage";
import { ReleaseManagerPage } from "./ReleaseManagerPage";
import { TeamPage } from "./TeamPage";
import { AlertIcon, AppIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, GridIcon, KeyIcon, LogOutIcon, MonitorIcon, ShieldIcon, TicketIcon, UsersIcon, XIcon } from "./icons";
import { PackageIcon } from "./releaseIcons";
import type { AdminIdentity } from "./types";

type Page = "dashboard" | "licenses" | "customers" | "applications" | "releases" | "devices" | "team";
type Toast = { id: number; tone: "success" | "danger"; title: string; detail?: string };

export function AdminShell({ admin, onSignedOut }: { admin: AdminIdentity; onSignedOut: () => void }) {
  const [page, setPage] = useState<Page>("dashboard");
  const [sidebarCompact, setSidebarCompact] = useState(false);
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback<Notify>((title, detail) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, tone: "success", title, detail }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 3500);
  }, []);

  const onError = useCallback<ErrorHandler>((error) => {
    if (error instanceof ApiError && error.status === 401) {
      clearSession();
      onSignedOut();
      return;
    }
    const id = Date.now() + Math.random();
    const title = error instanceof ApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : "Có lỗi xảy ra";
    const detail = error instanceof ApiError
      ? [error.code, error.requestId ? `requestId: ${error.requestId}` : null].filter(Boolean).join(" · ")
      : undefined;
    setToasts((current) => [...current, { id, tone: "danger", title, detail }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 5500);
  }, [onSignedOut]);

  useEffect(() => {
    let alive = true;
    const check = () => void health().then((result) => {
      if (alive) setApiOnline(result);
    });
    check();
    const timer = window.setInterval(check, 30_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const nav = useMemo(() => [
    { id: "dashboard" as const, label: "Tổng quan", icon: <GridIcon /> },
    { id: "licenses" as const, label: "Licenses", icon: <TicketIcon /> },
    { id: "customers" as const, label: "Khách hàng", icon: <UsersIcon /> },
    { id: "applications" as const, label: "Ứng dụng", icon: <AppIcon /> },
    ...(admin.role === "OWNER" ? [{ id: "releases" as const, label: "Build & Update", icon: <PackageIcon /> }] : []),
    { id: "devices" as const, label: "Thiết bị", icon: <MonitorIcon /> },
    ...(admin.role === "OWNER" ? [{ id: "team" as const, label: "Quản trị viên", icon: <ShieldIcon /> }] : []),
  ], [admin.role]);

  const titles: Record<Page, string> = {
    dashboard: "Tổng quan",
    licenses: "Licenses",
    customers: "Khách hàng",
    applications: "Ứng dụng",
    releases: "Build & Update",
    devices: "Thiết bị",
    team: "Quản trị viên",
  };

  async function signOut() {
    try {
      await logout();
    } catch {
      clearSession();
    }
    onSignedOut();
  }

  return (
    <div className={`admin-shell ${sidebarCompact ? "sidebar-compact" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark"><KeyIcon size={23} /></div>
          <div><strong>Key Manager</strong><span>License Admin</span></div>
        </div>
        <nav>
          {nav.map((item) => (
            <button key={item.id} type="button" className={page === item.id ? "active" : ""} onClick={() => setPage(item.id)}>
              {item.icon}<span>{item.label}</span>{page === item.id ? <i /> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="api-status-card">
            <span className={`connection-dot ${apiOnline === true ? "online" : apiOnline === false ? "offline" : "checking"}`} />
            <div><strong>{apiOnline ? "API Online" : apiOnline === false ? "API Offline" : "Checking"}</strong><small>{apiBaseUrl().replace(/^https?:\/\//, "")}</small></div>
          </div>
          <button className="collapse-button" type="button" onClick={() => setSidebarCompact((value) => !value)}>
            <ChevronLeftIcon size={17} /><span>Thu gọn menu</span>
          </button>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar-title"><span>Key Manager</span><ChevronRightIcon size={14} /><strong>{titles[page]}</strong></div>
          <div className="topbar-actions">
            <div className="admin-chip">
              <span className="admin-initial">{admin.email[0].toUpperCase()}</span>
              <div><strong>{admin.email}</strong><small>{admin.role}</small></div>
            </div>
            <button className="icon-button logout-button" type="button" onClick={() => void signOut()} title="Đăng xuất">
              <LogOutIcon size={18} />
            </button>
          </div>
        </header>

        <div className="content-area">
          {page === "dashboard" ? <DashboardPage onError={onError} /> : null}
          {page === "licenses" ? <LicensesPage role={admin.role} onError={onError} notify={notify} /> : null}
          {page === "customers" ? <CustomersPage role={admin.role} onError={onError} notify={notify} /> : null}
          {page === "applications" ? <ApplicationsPage role={admin.role} onError={onError} notify={notify} /> : null}
          {page === "releases" && admin.role === "OWNER" ? <ReleaseManagerPage onError={onError} notify={notify} /> : null}
          {page === "devices" ? <DevicesPage role={admin.role} onError={onError} notify={notify} /> : null}
          {page === "team" && admin.role === "OWNER" ? <TeamPage onError={onError} notify={notify} /> : null}
        </div>
      </div>

      <div className="toast-stack">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`}>
            {toast.tone === "success" ? <CheckIcon size={18} /> : <AlertIcon size={18} />}
            <div><strong>{toast.title}</strong>{toast.detail ? <small>{toast.detail}</small> : null}</div>
            <button type="button" onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}><XIcon size={14} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}
