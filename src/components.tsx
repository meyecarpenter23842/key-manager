import { useEffect, useState, type ReactNode } from "react";

import { ChevronLeftIcon, ChevronRightIcon, KeyIcon, SearchIcon, XIcon } from "./icons";
import type { Pagination } from "./types";
import { pageCount, statusTone } from "./ui";

export type ErrorHandler = (error: unknown) => void;
export type Notify = (title: string, detail?: string) => void;
export const PAGE_SIZE = 25;
export const emptyPagination: Pagination = { total: 0, limit: PAGE_SIZE, offset: 0 };

export async function copyTextToClipboard(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("Clipboard unavailable");
  }
}

export function useDebouncedValue(value: string, delay = 280) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  return debounced;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

export function Modal({ title, subtitle, onClose, children, wide = false }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <section className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Đóng">
            <XIcon />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge status-${statusTone(status)}`}>{status}</span>;
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon"><KeyIcon /></div>
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

export function LoadingRows({ columns = 5 }: { columns?: number }) {
  return (
    <>
      {[0, 1, 2, 3, 4].map((row) => (
        <tr key={row} className="skeleton-row">
          {Array.from({ length: columns }, (_, column) => <td key={column}><span className="skeleton-line" /></td>)}
        </tr>
      ))}
    </>
  );
}

export function Pager({ pagination, onOffset }: { pagination: Pagination; onOffset: (offset: number) => void }) {
  const current = Math.floor(pagination.offset / pagination.limit) + 1;
  const pages = pageCount(pagination.total, pagination.limit);
  return (
    <div className="pager">
      <span>{pagination.total.toLocaleString("vi-VN")} bản ghi · Trang {current}/{pages}</span>
      <div>
        <button className="icon-button small" type="button" disabled={pagination.offset <= 0} onClick={() => onOffset(Math.max(0, pagination.offset - pagination.limit))} aria-label="Trang trước">
          <ChevronLeftIcon size={17} />
        </button>
        <button className="icon-button small" type="button" disabled={pagination.offset + pagination.limit >= pagination.total} onClick={() => onOffset(pagination.offset + pagination.limit)} aria-label="Trang sau">
          <ChevronRightIcon size={17} />
        </button>
      </div>
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <div className="search-box">
      <SearchIcon size={18} />
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      {value ? <button type="button" onClick={() => onChange("")} aria-label="Xóa tìm kiếm"><XIcon size={15} /></button> : null}
    </div>
  );
}
