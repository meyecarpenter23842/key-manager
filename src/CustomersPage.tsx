import { useCallback, useEffect, useState, type FormEvent } from "react";

import { createCustomer, getCustomer, listCustomers, updateCustomer } from "./api";
import { ApplicationAvatar } from "./ApplicationAvatar";
import {
  EmptyState,
  Field,
  LoadingRows,
  Modal,
  PAGE_SIZE,
  Pager,
  SearchBox,
  StatusBadge,
  emptyPagination,
  useDebouncedValue,
  type ErrorHandler,
  type Notify,
} from "./components";
import { EditIcon, KeyIcon, MonitorIcon, PlusIcon } from "./icons";
import { LicenseDetailModal } from "./LicenseModals";
import type { AdminRole, Customer, CustomerDetail } from "./types";
import { can, formatDateTime, formatExpiry } from "./ui";

export function CustomerFormModal({
  customer,
  onClose,
  onSaved,
  onError,
}: {
  customer?: Customer;
  onClose: () => void;
  onSaved: () => void;
  onError: ErrorHandler;
}) {
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    const payload = {
      name: String(data.get("name") || ""),
      phone: String(data.get("phone") || "").trim() || null,
      email: String(data.get("email") || "").trim() || null,
      company: String(data.get("company") || "").trim() || null,
      note: String(data.get("note") || "").trim() || null,
    };
    try {
      if (customer) await updateCustomer(customer.id, payload);
      else await createCustomer(payload);
      onSaved();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={customer ? "Chỉnh sửa khách hàng" : "Thêm khách hàng"}
      subtitle="Thông tin dùng để tìm kiếm và gắn với license."
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={submit}>
        <Field label="Tên khách hàng">
          <input name="name" defaultValue={customer?.name || ""} required autoFocus />
        </Field>
        <div className="form-grid two">
          <Field label="Email">
            <input name="email" type="email" defaultValue={customer?.email || ""} />
          </Field>
          <Field label="Số điện thoại">
            <input name="phone" defaultValue={customer?.phone || ""} />
          </Field>
        </div>
        <Field label="Công ty">
          <input name="company" defaultValue={customer?.company || ""} />
        </Field>
        <Field label="Ghi chú">
          <textarea name="note" rows={3} defaultValue={customer?.note || ""} />
        </Field>
        <div className="modal-actions">
          <button className="button ghost" type="button" onClick={onClose}>Hủy</button>
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? <span className="spinner" /> : null} Lưu
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CustomerDetailModal({
  id,
  refreshKey,
  onClose,
  onOpenLicense,
  onError,
}: {
  id: string;
  refreshKey: number;
  onClose: () => void;
  onOpenLicense: (licenseId: string) => void;
  onError: ErrorHandler;
}) {
  const [detail, setDetail] = useState<CustomerDetail | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await getCustomer(id));
    } catch (error) {
      onError(error);
    }
  }, [id, onError]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (!detail) {
    return (
      <Modal title="Đang tải khách hàng..." onClose={onClose} wide>
        <div className="detail-loading"><span className="spinner dark" /> Đang đọc dữ liệu</div>
      </Modal>
    );
  }

  const activeLicenses = detail.licenses.filter((license) => license.status === "ACTIVE").length;
  const appCount = new Set(detail.licenses.map((license) => license.application.id)).size;
  const activeDevices = detail.licenses.reduce((sum, license) => sum + license.activeDeviceCount, 0);

  return (
    <Modal
      title={detail.name}
      subtitle={[detail.company, detail.email, detail.phone].filter(Boolean).join(" · ") || "Hồ sơ khách hàng"}
      onClose={onClose}
      wide
    >
      <div className="customer-detail">
        <div className="detail-summary-grid">
          <div><span>License</span><strong>{detail.licenses.length}</strong></div>
          <div><span>Đang active</span><strong>{activeLicenses}</strong></div>
          <div><span>Ứng dụng</span><strong>{appCount}</strong></div>
          <div><span>Thiết bị active</span><strong>{activeDevices}</strong></div>
        </div>

        <div className="detail-card-grid">
          <article className="detail-card">
            <span>Liên hệ</span>
            <strong>{detail.email || "Chưa có email"}</strong>
            <small>{detail.phone || "Chưa có số điện thoại"}</small>
          </article>
          <article className="detail-card">
            <span>Công ty</span>
            <strong>{detail.company || "—"}</strong>
            <small>Cập nhật {formatDateTime(detail.updatedAt)}</small>
          </article>
        </div>

        {detail.note ? (
          <div className="note-box">
            <span>Ghi chú</span>
            <p>{detail.note}</p>
          </div>
        ) : null}

        <section className="detail-section">
          <header className="customer-license-header">
            <div>
              <h3>License / Key ({detail.licenses.length})</h3>
              <p>Bấm vào license để xem full key, gia hạn, device limit và lịch sử đầy đủ.</p>
            </div>
          </header>

          {detail.licenses.length ? (
            <div className="customer-license-list">
              {detail.licenses.map((license) => (
                <button
                  className="customer-license-card"
                  type="button"
                  key={license.id}
                  onClick={() => onOpenLicense(license.id)}
                >
                  <div className="customer-license-main">
                    <ApplicationAvatar
                      appCode={license.application.appCode}
                      iconDataUrl={license.application.iconDataUrl}
                      large
                    />
                    <div>
                      <strong>{license.application.name}</strong>
                      <small>{license.application.appCode}</small>
                    </div>
                  </div>

                  <div className="customer-license-key">
                    <span><KeyIcon size={13} /> Key</span>
                    <strong className="mono">{license.licenseKeyPreview}</strong>
                    <small>{license.licenseType === "LIFETIME" ? "Vĩnh viễn" : formatExpiry(license.expiresAt)}</small>
                  </div>

                  <div className="customer-license-devices">
                    <span><MonitorIcon size={13} /> Thiết bị</span>
                    <strong>{license.activeDeviceCount}/{license.maxDevices} active</strong>
                    <small>
                      {license.devices.length
                        ? license.devices.slice(0, 2).map((device) => device.deviceName || device.deviceId).join(" · ")
                        : "Chưa kích hoạt"}
                    </small>
                  </div>

                  <div className="customer-license-status">
                    <StatusBadge status={license.status} />
                    <small>{license.renewalHistory.length} lần gia hạn/chuyển lifetime</small>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <p className="muted">Khách hàng này chưa được gán license nào.</p>
          )}
        </section>
      </div>
    </Modal>
  );
}

export function CustomersPage({
  role,
  onError,
  notify,
}: {
  role: AdminRole;
  onError: ErrorHandler;
  notify: Notify;
}) {
  const [items, setItems] = useState<Customer[]>([]);
  const [pagination, setPagination] = useState(emptyPagination);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Customer | "new" | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<string | null>(null);
  const [selectedLicense, setSelectedLicense] = useState<string | null>(null);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const debouncedSearch = useDebouncedValue(search);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listCustomers({ q: debouncedSearch, limit: PAGE_SIZE, offset });
      setItems(result.customers);
      setPagination(result.pagination);
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, offset, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => setOffset(0), [debouncedSearch]);

  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow dark">CUSTOMERS</span>
          <h1>Khách hàng</h1>
          <p>Đối chiếu khách hàng với license, ứng dụng, thiết bị và lịch sử key.</p>
        </div>
        {can(role, "customer:write") ? (
          <button className="button primary" type="button" onClick={() => setEditing("new")}>
            <PlusIcon size={18} /> Thêm khách hàng
          </button>
        ) : null}
      </div>

      <section className="panel">
        <div className="toolbar">
          <SearchBox value={search} onChange={setSearch} placeholder="Tên, email, điện thoại, công ty..." />
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Khách hàng</th>
                <th>Liên hệ</th>
                <th>Công ty</th>
                <th>Cập nhật</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <LoadingRows columns={5} />
              ) : (
                items.map((item) => (
                  <tr key={item.id} className="clickable-row" onClick={() => setSelectedCustomer(item.id)}>
                    <td>
                      <div className="cell-title">
                        <span className="customer-avatar">{item.name.slice(0, 1).toUpperCase()}</span>
                        <div>
                          <strong>{item.name}</strong>
                          <small>{item.note ? item.note.slice(0, 52) : "Bấm để xem license và thiết bị"}</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="cell-stack">
                        <strong>{item.email || "—"}</strong>
                        <small>{item.phone || "Chưa có số điện thoại"}</small>
                      </div>
                    </td>
                    <td>{item.company || <span className="muted">—</span>}</td>
                    <td>{formatDateTime(item.updatedAt)}</td>
                    <td>
                      {can(role, "customer:write") ? (
                        <button
                          className="icon-button small"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setEditing(item);
                          }}
                          aria-label="Sửa"
                        >
                          <EditIcon size={16} />
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {!loading && items.length === 0 ? (
            <EmptyState title="Chưa có khách hàng" body="Thêm khách hàng để gắn license và tìm kiếm nhanh hơn." />
          ) : null}
        </div>
        <Pager pagination={pagination} onOffset={setOffset} />
      </section>

      {editing ? (
        <CustomerFormModal
          customer={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onError={onError}
          onSaved={() => {
            notify(editing === "new" ? "Đã tạo khách hàng" : "Đã cập nhật khách hàng");
            setEditing(null);
            setDetailRefresh((value) => value + 1);
            void load();
          }}
        />
      ) : null}

      {selectedCustomer ? (
        <CustomerDetailModal
          id={selectedCustomer}
          refreshKey={detailRefresh}
          onClose={() => {
            setSelectedLicense(null);
            setSelectedCustomer(null);
          }}
          onOpenLicense={setSelectedLicense}
          onError={onError}
        />
      ) : null}

      {selectedLicense ? (
        <LicenseDetailModal
          id={selectedLicense}
          role={role}
          onClose={() => setSelectedLicense(null)}
          onChanged={() => {
            setDetailRefresh((value) => value + 1);
            void load();
          }}
          onError={onError}
          notify={notify}
        />
      ) : null}
    </div>
  );
}
