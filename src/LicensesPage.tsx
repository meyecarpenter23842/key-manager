import { useCallback, useEffect, useState } from "react";

import { listLicenses } from "./api";
import { EmptyState, LoadingRows, PAGE_SIZE, Pager, SearchBox, StatusBadge, emptyPagination, useDebouncedValue, type ErrorHandler, type Notify } from "./components";
import { MonitorIcon, MoreIcon, PlusIcon } from "./icons";
import { CreatedKeyModal, LicenseCreateModal, LicenseDetailModal } from "./LicenseModals";
import type { AdminRole, License } from "./types";
import { can, formatExpiry } from "./ui";

export function LicensesPage({ role, onError, notify }: { role: AdminRole; onError: ErrorHandler; notify: Notify }) {
  const [items, setItems] = useState<License[]>([]);
  const [pagination, setPagination] = useState(emptyPagination);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<{ license: License; key: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const debouncedSearch = useDebouncedValue(search);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listLicenses({ q: debouncedSearch, status, licenseType: type, limit: PAGE_SIZE, offset });
      setItems(result.licenses); setPagination(result.pagination);
    } catch (error) { onError(error); }
    finally { setLoading(false); }
  }, [debouncedSearch, offset, onError, status, type]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setOffset(0); }, [debouncedSearch, status, type]);

  return (
    <div className="page">
      <div className="page-heading"><div><span className="eyebrow dark">LICENSES</span><h1>License keys</h1><p>Tạo, tìm kiếm, gia hạn và kiểm soát vòng đời key.</p></div>{can(role, "license:create") ? <button className="button primary" type="button" onClick={() => setCreateOpen(true)}><PlusIcon size={18} /> Tạo license</button> : null}</div>
      <section className="panel">
        <div className="toolbar"><SearchBox value={search} onChange={setSearch} placeholder="Tìm key, app, khách hàng..." /><div className="filter-group"><select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Trạng thái"><option value="">Mọi trạng thái</option><option value="ACTIVE">ACTIVE</option><option value="EXPIRED">EXPIRED</option><option value="REVOKED">REVOKED</option><option value="ARCHIVED">ARCHIVED</option></select><select value={type} onChange={(event) => setType(event.target.value)} aria-label="Loại license"><option value="">Mọi loại</option><option value="SUBSCRIPTION">Có hạn</option><option value="LIFETIME">Vĩnh viễn</option></select></div></div>
        <div className="table-wrap">
          <table><thead><tr><th>License</th><th>Ứng dụng</th><th>Khách hàng</th><th>Thiết bị</th><th>Hết hạn</th><th>Trạng thái</th><th /></tr></thead><tbody>{loading ? <LoadingRows columns={7} /> : items.map((item) => <tr key={item.id} className="clickable-row" onClick={() => setSelected(item.id)}><td><div className="cell-stack"><strong className="mono">{item.licenseKeyPreview}</strong><small>{item.licenseType === "LIFETIME" ? "Vĩnh viễn" : "Có thời hạn"}</small></div></td><td><div className="cell-title"><span className="app-avatar">{item.appCode.slice(0, 2)}</span><div><strong>{item.applicationName}</strong><small>{item.appCode}</small></div></div></td><td><div className="cell-stack"><strong>{item.customerName || "—"}</strong><small>{item.customerCompany || item.customerEmail || "Chưa gán khách"}</small></div></td><td><span className="device-count"><MonitorIcon size={15} /> {item.activeDeviceCount}/{item.maxDevices}</span></td><td>{formatExpiry(item.expiresAt)}</td><td><StatusBadge status={item.status} /></td><td><button className="icon-button small" type="button" aria-label="Chi tiết"><MoreIcon size={17} /></button></td></tr>)}</tbody></table>
          {!loading && items.length === 0 ? <EmptyState title="Không có license phù hợp" body="Thử thay đổi bộ lọc hoặc tạo license mới." /> : null}
        </div>
        <Pager pagination={pagination} onOffset={setOffset} />
      </section>
      {createOpen ? <LicenseCreateModal onClose={() => setCreateOpen(false)} onError={onError} onCreated={(license, key) => { setCreateOpen(false); setCreated({ license, key }); void load(); }} /> : null}
      {created ? <CreatedKeyModal license={created.license} licenseKey={created.key} onClose={() => setCreated(null)} /> : null}
      {selected ? <LicenseDetailModal id={selected} role={role} onClose={() => setSelected(null)} onChanged={() => void load()} onError={onError} notify={notify} /> : null}
    </div>
  );
}
