import { useCallback, useEffect, useState } from "react";

import { listApplications, listCustomers, listDevices, listLicenses } from "./api";
import { EmptyState, LoadingRows, StatusBadge, type ErrorHandler } from "./components";
import { AppIcon, MonitorIcon, RefreshIcon, TicketIcon, UsersIcon } from "./icons";
import type { License } from "./types";
import { formatExpiry } from "./ui";

export function DashboardPage({ onError }: { onError: ErrorHandler }) {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ applications: 0, customers: 0, licenses: 0, activeLicenses: 0, devices: 0, activeDevices: 0 });
  const [recent, setRecent] = useState<License[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [apps, customers, licenses, activeLicenses, devices, activeDevices, latest] = await Promise.all([
        listApplications({ limit: 1 }),
        listCustomers({ limit: 1 }),
        listLicenses({ limit: 1 }),
        listLicenses({ status: "ACTIVE", limit: 1 }),
        listDevices({ limit: 1 }),
        listDevices({ status: "ACTIVE", limit: 1 }),
        listLicenses({ limit: 6 }),
      ]);
      setStats({
        applications: apps.pagination.total,
        customers: customers.pagination.total,
        licenses: licenses.pagination.total,
        activeLicenses: activeLicenses.pagination.total,
        devices: devices.pagination.total,
        activeDevices: activeDevices.pagination.total,
      });
      setRecent(latest.licenses);
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => { void load(); }, [load]);

  const cards = [
    { label: "Tổng license", value: stats.licenses, meta: `${stats.activeLicenses} đang hoạt động`, icon: <TicketIcon />, tone: "violet" },
    { label: "Thiết bị", value: stats.devices, meta: `${stats.activeDevices} đang active`, icon: <MonitorIcon />, tone: "blue" },
    { label: "Khách hàng", value: stats.customers, meta: "Hồ sơ đã lưu", icon: <UsersIcon />, tone: "green" },
    { label: "Ứng dụng", value: stats.applications, meta: "Desktop App đã cấu hình", icon: <AppIcon />, tone: "amber" },
  ];

  return (
    <div className="page dashboard-page">
      <div className="page-heading dashboard-heading">
        <div><span className="eyebrow dark">OVERVIEW</span><h1>Trung tâm điều khiển</h1><p>Theo dõi tình trạng license và thiết bị trên toàn hệ thống.</p></div>
        <button className="button secondary" type="button" onClick={() => void load()} disabled={loading}><RefreshIcon size={17} /> Làm mới</button>
      </div>
      <section className="stat-grid">
        {cards.map((card) => (
          <article className="stat-card" key={card.label}>
            <div className={`stat-icon ${card.tone}`}>{card.icon}</div>
            <div><span>{card.label}</span><strong>{loading ? "—" : card.value.toLocaleString("vi-VN")}</strong><small>{card.meta}</small></div>
          </article>
        ))}
      </section>
      <section className="panel recent-panel">
        <header className="panel-header"><div><h2>License cập nhật gần đây</h2><p>6 license mới hoặc vừa được thay đổi.</p></div></header>
        <div className="table-wrap">
          <table>
            <thead><tr><th>License</th><th>Ứng dụng</th><th>Khách hàng</th><th>Loại</th><th>Hết hạn</th><th>Trạng thái</th></tr></thead>
            <tbody>
              {loading ? <LoadingRows columns={6} /> : recent.map((item) => (
                <tr key={item.id}>
                  <td><span className="mono strong">{item.licenseKeyPreview}</span></td>
                  <td><div className="cell-title"><span className="app-avatar">{item.appCode.slice(0, 2)}</span><div><strong>{item.applicationName}</strong><small>{item.appCode}</small></div></div></td>
                  <td>{item.customerName || <span className="muted">Chưa gán</span>}</td>
                  <td>{item.licenseType === "LIFETIME" ? "Vĩnh viễn" : "Có hạn"}</td>
                  <td>{formatExpiry(item.expiresAt)}</td>
                  <td><StatusBadge status={item.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && recent.length === 0 ? <EmptyState title="Chưa có license" body="Tạo license đầu tiên từ mục Licenses." /> : null}
        </div>
      </section>
    </div>
  );
}
