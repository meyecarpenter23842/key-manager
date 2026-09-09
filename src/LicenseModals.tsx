import { useCallback, useEffect, useState, type FormEvent } from "react";

import {
  archiveLicense, createLicense, getLicense, listApplications, listCustomers,
  reactivateLicense, renewLicense, revokeLicense, setLicenseDeviceLimit,
} from "./api";
import { Field, Modal, StatusBadge, copyTextToClipboard, type ErrorHandler, type Notify } from "./components";
import { AlertIcon, CheckIcon, CopyIcon, MonitorIcon, PlusIcon, ShieldIcon, TrashIcon, XIcon } from "./icons";
import type { AdminRole, Application, Customer, License, LicenseDetail } from "./types";
import { can, formatDateTime, formatExpiry } from "./ui";

export function LicenseCreateModal({ onClose, onCreated, onError }: { onClose: () => void; onCreated: (license: License, key: string) => void; onError: ErrorHandler }) {
  const [apps, setApps] = useState<Application[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [applicationId, setApplicationId] = useState("");
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState<"SUBSCRIPTION" | "LIFETIME">("SUBSCRIPTION");

  useEffect(() => {
    void Promise.all([listApplications({ status: "ACTIVE", limit: 100 }), listCustomers({ limit: 100 })])
      .then(([appResult, customerResult]) => {
        setApps(appResult.applications);
        setCustomers(customerResult.customers);
        setApplicationId((current) => current || appResult.applications[0]?.id || "");
      })
      .catch(onError);
  }, [onError]);

  const selectedApp = apps.find((item) => item.id === applicationId) ?? null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (!applicationId || !selectedApp) return;
    setBusy(true);
    try {
      const durationText = String(data.get("durationDays") || "").trim();
      const maxDevicesText = String(data.get("maxDevices") || "").trim();
      const result = await createLicense({
        applicationId,
        customerId: String(data.get("customerId") || "") || null,
        licenseType: type,
        ...(type === "SUBSCRIPTION" && durationText ? { durationDays: Number(durationText) } : {}),
        ...(maxDevicesText ? { maxDevices: Number(maxDevicesText) } : {}),
        note: String(data.get("note") || "").trim() || null,
      });
      onCreated(result.license, result.licenseKey);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }

  function selectApplication(nextId: string) {
    setApplicationId(nextId);
    const app = apps.find((item) => item.id === nextId);
    if (app && !app.allowLifetime) setType("SUBSCRIPTION");
  }

  return (
    <Modal title="Tạo license mới" subtitle="Key đầy đủ chỉ được hiển thị một lần sau khi tạo." onClose={onClose} wide>
      <form className="modal-form" onSubmit={submit}>
        <div className="form-grid two">
          <Field label="Ứng dụng">
            <select name="applicationId" required value={applicationId} onChange={(event) => selectApplication(event.target.value)}>
              <option value="" disabled>Chọn ứng dụng</option>
              {apps.map((app) => <option key={app.id} value={app.id}>{app.name} · {app.appCode}</option>)}
            </select>
          </Field>
          <Field label="Khách hàng">
            <select name="customerId" defaultValue=""><option value="">Không gán khách hàng</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}{customer.company ? ` · ${customer.company}` : ""}</option>)}</select>
          </Field>
        </div>
        <div className="field"><span className="field-label">Loại license</span><div className="segmented"><button type="button" className={type === "SUBSCRIPTION" ? "active" : ""} onClick={() => setType("SUBSCRIPTION")}>Có thời hạn</button><button type="button" disabled={!selectedApp?.allowLifetime} className={type === "LIFETIME" ? "active" : ""} onClick={() => setType("LIFETIME")} title={!selectedApp?.allowLifetime ? "Application này không cho phép lifetime" : undefined}>Vĩnh viễn</button></div></div>
        <div className="form-grid two">
          {type === "SUBSCRIPTION" ? <Field label="Số ngày" hint={`Để trống để dùng mặc định${selectedApp ? `: ${selectedApp.defaultDurationDays} ngày` : " của application"}.`}><input name="durationDays" type="number" min="1" max="36500" placeholder={String(selectedApp?.defaultDurationDays ?? 30)} /></Field> : <div className="lifetime-callout"><ShieldIcon size={19} /><span>License vĩnh viễn không hết hạn online; offline token vẫn bị giới hạn bởi offline grace.</span></div>}
          <Field label="Giới hạn thiết bị" hint={`Để trống để dùng mặc định${selectedApp ? `: ${selectedApp.defaultDeviceLimit}` : " của application"}.`}><input name="maxDevices" type="number" min="1" max="32767" placeholder={String(selectedApp?.defaultDeviceLimit ?? 1)} /></Field>
        </div>
        <Field label="Ghi chú"><textarea name="note" rows={3} placeholder="Ghi chú nội bộ, đơn hàng, gói dịch vụ..." /></Field>
        <div className="modal-actions"><button className="button ghost" type="button" onClick={onClose}>Hủy</button><button className="button primary" type="submit" disabled={busy || apps.length === 0}>{busy ? <span className="spinner" /> : <PlusIcon size={18} />} Tạo license</button></div>
      </form>
    </Modal>
  );
}
export function CreatedKeyModal({ license, licenseKey, onClose }: { license: License; licenseKey: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await copyTextToClipboard(licenseKey);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }
  return (
    <Modal title="License đã được tạo" subtitle={`${license.applicationName} · ${license.licenseType === "LIFETIME" ? "Vĩnh viễn" : "Có thời hạn"}`} onClose={onClose}>
      <div className="key-success">
        <div className="success-icon"><CheckIcon size={28} /></div>
        <div className="key-warning"><AlertIcon size={17} /><span>Hãy sao chép key ngay. Server không lưu raw license key và màn hình này sẽ không thể hiển thị lại.</span></div>
        <div className="license-key-box"><code>{licenseKey}</code><button className="button secondary" type="button" onClick={() => void copy()}>{copied ? <CheckIcon size={17} /> : <CopyIcon size={17} />}{copied ? "Đã copy" : "Copy key"}</button></div>
        <button className="button primary full" type="button" onClick={onClose}>Hoàn tất</button>
      </div>
    </Modal>
  );
}

export function LicenseDetailModal({ id, role, onClose, onChanged, onError, notify }: { id: string; role: AdminRole; onClose: () => void; onChanged: () => void; onError: ErrorHandler; notify: Notify }) {
  const [detail, setDetail] = useState<LicenseDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<"renew" | "limit" | null>(null);

  const load = useCallback(async () => {
    try { setDetail(await getLicense(id)); } catch (error) { onError(error); }
  }, [id, onError]);
  useEffect(() => { void load(); }, [load]);

  async function perform(label: string, operation: () => Promise<unknown>) {
    setBusy(true);
    try { await operation(); notify(label); await load(); onChanged(); }
    catch (error) { onError(error); }
    finally { setBusy(false); }
  }

  if (!detail) return <Modal title="Đang tải license..." onClose={onClose}><div className="detail-loading"><span className="spinner dark" /> Đang đọc dữ liệu</div></Modal>;

  return (
    <Modal title={detail.licenseKeyPreview} subtitle={`${detail.applicationName} · ${detail.appCode}`} onClose={onClose} wide>
      <div className="license-detail">
        <div className="detail-summary-grid">
          <div><span>Trạng thái</span><StatusBadge status={detail.status} /></div>
          <div><span>Loại</span><strong>{detail.licenseType === "LIFETIME" ? "Vĩnh viễn" : "Có hạn"}</strong></div>
          <div><span>Hết hạn</span><strong>{formatExpiry(detail.expiresAt)}</strong></div>
          <div><span>Thiết bị</span><strong>{detail.activeDeviceCount}/{detail.maxDevices} active</strong></div>
        </div>
        <div className="detail-card-grid">
          <article className="detail-card"><span>Khách hàng</span><strong>{detail.customer?.name || "Chưa gán"}</strong><small>{detail.customer?.email || detail.customer?.phone || "—"}</small></article>
          <article className="detail-card"><span>Ngày tạo</span><strong>{formatDateTime(detail.createdAt)}</strong><small>Cập nhật {formatDateTime(detail.updatedAt)}</small></article>
        </div>
        {detail.note ? <div className="note-box"><span>Ghi chú</span><p>{detail.note}</p></div> : null}
        <div className="action-strip">
          {can(role, "license:renew") && detail.licenseType === "SUBSCRIPTION" && detail.status !== "ARCHIVED" ? <button className="button secondary" type="button" onClick={() => setAction("renew")}>Gia hạn</button> : null}
          {can(role, "license:device-limit") && detail.status !== "ARCHIVED" ? <button className="button secondary" type="button" onClick={() => setAction("limit")}>Đổi device limit</button> : null}
          {can(role, "license:revoke") && detail.status !== "REVOKED" && detail.status !== "ARCHIVED" ? <button className="button danger-soft" type="button" disabled={busy} onClick={() => window.confirm("Revoke license này? Client sẽ bị từ chối ở lần online tiếp theo.") && void perform("Đã revoke license", () => revokeLicense(detail.id))}>Revoke</button> : null}
          {can(role, "license:revoke") && detail.status === "REVOKED" ? <button className="button success-soft" type="button" disabled={busy} onClick={() => void perform("Đã kích hoạt lại license", () => reactivateLicense(detail.id))}>Reactivate</button> : null}
          {can(role, "license:archive") && detail.status !== "ARCHIVED" ? <button className="button ghost danger-text" type="button" disabled={busy} onClick={() => window.confirm("Archive license này? Thao tác không thể hoàn tác qua API hiện tại.") && void perform("Đã archive license", () => archiveLicense(detail.id))}><TrashIcon size={16} /> Archive</button> : null}
        </div>
        {action === "renew" ? <form className="inline-action" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); const mode = String(data.get("mode")); const days = Number(data.get("days") || 0); void perform("Gia hạn license thành công", () => renewLicense(detail.id, mode === "lifetime" ? { toLifetime: true } : { durationDays: days })).then(() => setAction(null)); }}><div><strong>Gia hạn license</strong><span>Thêm số ngày hoặc chuyển sang vĩnh viễn.</span></div><select name="mode" defaultValue="days"><option value="days">Thêm ngày</option>{detail.licenseType === "SUBSCRIPTION" ? <option value="lifetime">Chuyển vĩnh viễn</option> : null}</select><input name="days" type="number" min="1" defaultValue="30" /><button className="button primary small-button" type="submit" disabled={busy}>Lưu</button><button className="icon-button small" type="button" onClick={() => setAction(null)}><XIcon size={16} /></button></form> : null}
        {action === "limit" ? <form className="inline-action" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void perform("Đã cập nhật device limit", () => setLicenseDeviceLimit(detail.id, Number(data.get("maxDevices")))).then(() => setAction(null)); }}><div><strong>Device limit</strong><span>Không thể thấp hơn số thiết bị active hiện tại.</span></div><input name="maxDevices" type="number" min={detail.activeDeviceCount || 1} max="32767" defaultValue={detail.maxDevices} /><button className="button primary small-button" type="submit" disabled={busy}>Lưu</button><button className="icon-button small" type="button" onClick={() => setAction(null)}><XIcon size={16} /></button></form> : null}
        <section className="detail-section"><header><h3>Thiết bị ({detail.devices.length})</h3></header>{detail.devices.length ? <div className="mini-list">{detail.devices.map((device) => <div key={device.id}><div className="mini-icon"><MonitorIcon size={17} /></div><div><strong>{device.deviceName || device.deviceId}</strong><small>{device.os || "Unknown OS"} · {device.appVersion || "Unknown version"}</small></div><StatusBadge status={device.status} /></div>)}</div> : <p className="muted">Chưa có thiết bị nào kích hoạt.</p>}</section>
        <section className="detail-section"><header><h3>Lịch sử</h3></header>{detail.events.length ? <div className="timeline">{detail.events.slice(0, 20).map((event) => <div key={event.id}><span className="timeline-dot" /><div><strong>{event.eventType.replaceAll("_", " ")}</strong><small>{event.actorEmail || event.actorType} · {formatDateTime(event.createdAt)}</small></div></div>)}</div> : <p className="muted">Chưa có event.</p>}</section>
      </div>
    </Modal>
  );
}
