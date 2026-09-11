import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from "react";

import { createApplication, listApplications, updateApplication } from "./api";
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
import { CheckIcon, EditIcon, PlusIcon, TrashIcon } from "./icons";
import type { AdminRole, Application } from "./types";
import { can, formatDuration } from "./ui";

async function normalizeApplicationIcon(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Ảnh ứng dụng phải là file PNG, JPEG hoặc WebP.");
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const next = new Image();
      next.onload = () => resolve(next);
      next.onerror = () => reject(new Error("Không đọc được file ảnh."));
      next.src = objectUrl;
    });

    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Không thể xử lý ảnh ứng dụng.");

    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) throw new Error("Ảnh ứng dụng không hợp lệ.");

    const scale = Math.min(size / width, size / height);
    const drawWidth = Math.max(1, Math.round(width * scale));
    const drawHeight = Math.max(1, Math.round(height * scale));
    const x = Math.round((size - drawWidth) / 2);
    const y = Math.round((size - drawHeight) / 2);
    context.clearRect(0, 0, size, size);
    context.drawImage(image, x, y, drawWidth, drawHeight);

    const dataUrl = canvas.toDataURL("image/png");
    if (new TextEncoder().encode(dataUrl).byteLength > 262144) {
      throw new Error("Ảnh ứng dụng sau khi xử lý vẫn quá lớn.");
    }
    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function ApplicationFormModal({
  application,
  onClose,
  onSaved,
  onError,
}: {
  application?: Application;
  onClose: () => void;
  onSaved: () => void;
  onError: ErrorHandler;
}) {
  const [busy, setBusy] = useState(false);
  const [iconBusy, setIconBusy] = useState(false);
  const [iconDataUrl, setIconDataUrl] = useState<string | null>(application?.iconDataUrl ?? null);

  async function chooseIcon(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setIconBusy(true);
    try {
      setIconDataUrl(await normalizeApplicationIcon(file));
    } catch (error) {
      onError(error);
    } finally {
      setIconBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const payload: Omit<Application, "id" | "createdAt" | "updatedAt"> = {
      name: String(data.get("name") || ""),
      appCode: String(data.get("appCode") || "").toUpperCase(),
      description: String(data.get("description") || "").trim() || null,
      currentVersion: String(data.get("currentVersion") || "").trim() || null,
      minimumVersion: String(data.get("minimumVersion") || "").trim() || null,
      status: String(data.get("status") || "ACTIVE") as "ACTIVE" | "DISABLED",
      offlineGraceSeconds: Number(data.get("offlineGraceSeconds")),
      defaultDeviceLimit: Number(data.get("defaultDeviceLimit")),
      defaultDurationDays: Number(data.get("defaultDurationDays")),
      allowLifetime: data.get("allowLifetime") === "on",
      iconDataUrl,
    };

    setBusy(true);
    try {
      if (application) await updateApplication(application.id, payload);
      else await createApplication(payload);
      onSaved();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }

  const previewCode = application?.appCode || "APP";

  return (
    <Modal
      title={application ? "Cấu hình ứng dụng" : "Thêm ứng dụng"}
      subtitle="Mỗi license chỉ hợp lệ cho đúng application được cấp."
      onClose={onClose}
      wide
    >
      <form className="modal-form" onSubmit={submit}>
        <div className="application-icon-picker">
          <ApplicationAvatar appCode={previewCode} iconDataUrl={iconDataUrl} large />
          <div>
            <strong>Ảnh ứng dụng</strong>
            <small>Chọn PNG, JPEG hoặc WebP. Ảnh được thu về 128×128 trước khi lưu.</small>
          </div>
          <label className="button secondary small-button">
            {iconBusy ? <span className="spinner dark" /> : null}
            {iconBusy ? "Đang xử lý" : "Chọn ảnh"}
            <input
              className="visually-hidden"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => void chooseIcon(event)}
              disabled={iconBusy}
            />
          </label>
          {iconDataUrl ? (
            <button className="button ghost small-button danger-text" type="button" onClick={() => setIconDataUrl(null)}>
              <TrashIcon size={14} /> Bỏ ảnh
            </button>
          ) : null}
        </div>

        <div className="form-grid two">
          <Field label="Tên ứng dụng">
            <input name="name" defaultValue={application?.name || ""} required />
          </Field>
          <Field label="App code" hint="2–32 ký tự A-Z, 0-9, _ hoặc -">
            <input name="appCode" defaultValue={application?.appCode || ""} required />
          </Field>
        </div>

        <Field label="Mô tả">
          <textarea name="description" rows={2} defaultValue={application?.description || ""} />
        </Field>

        <div className="form-grid three">
          <Field label="Current version">
            <input name="currentVersion" defaultValue={application?.currentVersion || ""} placeholder="1.0.0" />
          </Field>
          <Field label="Minimum version">
            <input name="minimumVersion" defaultValue={application?.minimumVersion || ""} placeholder="1.0.0" />
          </Field>
          <Field label="Trạng thái">
            <select name="status" defaultValue={application?.status || "ACTIVE"}>
              <option value="ACTIVE">ACTIVE</option>
              <option value="DISABLED">DISABLED</option>
            </select>
          </Field>
        </div>

        <div className="form-grid three">
          <Field label="Offline grace (giây)">
            <input
              name="offlineGraceSeconds"
              type="number"
              min="0"
              max="2592000"
              defaultValue={application?.offlineGraceSeconds ?? 86400}
              required
            />
          </Field>
          <Field label="Device mặc định">
            <input
              name="defaultDeviceLimit"
              type="number"
              min="1"
              max="32767"
              defaultValue={application?.defaultDeviceLimit ?? 1}
              required
            />
          </Field>
          <Field label="Thời hạn mặc định (ngày)">
            <input
              name="defaultDurationDays"
              type="number"
              min="1"
              max="36500"
              defaultValue={application?.defaultDurationDays ?? 30}
              required
            />
          </Field>
        </div>

        <label className="checkbox-row">
          <input name="allowLifetime" type="checkbox" defaultChecked={application?.allowLifetime ?? true} />
          <span>
            <strong>Cho phép license vĩnh viễn</strong>
            <small>Admin có thể tạo hoặc chuyển license sang LIFETIME.</small>
          </span>
        </label>

        <div className="modal-actions">
          <button className="button ghost" type="button" onClick={onClose}>Hủy</button>
          <button className="button primary" type="submit" disabled={busy || iconBusy}>
            {busy ? <span className="spinner" /> : <CheckIcon size={17} />} Lưu cấu hình
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ApplicationsPage({
  role,
  onError,
  notify,
}: {
  role: AdminRole;
  onError: ErrorHandler;
  notify: Notify;
}) {
  const [items, setItems] = useState<Application[]>([]);
  const [pagination, setPagination] = useState(emptyPagination);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Application | "new" | null>(null);
  const debouncedSearch = useDebouncedValue(search);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listApplications({ q: debouncedSearch, status, limit: PAGE_SIZE, offset });
      setItems(result.applications);
      setPagination(result.pagination);
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, offset, onError, status]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => setOffset(0), [debouncedSearch, status]);

  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow dark">APPLICATIONS</span>
          <h1>Ứng dụng</h1>
          <p>Cấu hình version, offline grace và chính sách license theo từng Desktop App.</p>
        </div>
        {can(role, "application:write") ? (
          <button className="button primary" type="button" onClick={() => setEditing("new")}>
            <PlusIcon size={18} /> Thêm ứng dụng
          </button>
        ) : null}
      </div>

      <section className="panel">
        <div className="toolbar">
          <SearchBox value={search} onChange={setSearch} placeholder="Tên hoặc app code..." />
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">Mọi trạng thái</option>
            <option value="ACTIVE">ACTIVE</option>
            <option value="DISABLED">DISABLED</option>
          </select>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Ứng dụng</th>
                <th>Version</th>
                <th>Offline grace</th>
                <th>Mặc định license</th>
                <th>Trạng thái</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <LoadingRows columns={6} />
              ) : (
                items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div className="cell-title">
                        <ApplicationAvatar appCode={item.appCode} iconDataUrl={item.iconDataUrl} large />
                        <div>
                          <strong>{item.name}</strong>
                          <small>{item.appCode}</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="cell-stack">
                        <strong>{item.currentVersion || "—"}</strong>
                        <small>Minimum {item.minimumVersion || "—"}</small>
                      </div>
                    </td>
                    <td>{formatDuration(item.offlineGraceSeconds)}</td>
                    <td>
                      <div className="cell-stack">
                        <strong>{item.defaultDurationDays} ngày · {item.defaultDeviceLimit} device</strong>
                        <small>{item.allowLifetime ? "Cho phép lifetime" : "Không lifetime"}</small>
                      </div>
                    </td>
                    <td><StatusBadge status={item.status} /></td>
                    <td>
                      {can(role, "application:write") ? (
                        <button
                          className="icon-button small"
                          type="button"
                          onClick={() => setEditing(item)}
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
            <EmptyState title="Chưa có application" body="Thêm Desktop App đầu tiên để bắt đầu cấp license." />
          ) : null}
        </div>
        <Pager pagination={pagination} onOffset={setOffset} />
      </section>

      {editing ? (
        <ApplicationFormModal
          application={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onError={onError}
          onSaved={() => {
            notify(editing === "new" ? "Đã tạo application" : "Đã cập nhật application");
            setEditing(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}
