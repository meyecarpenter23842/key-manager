import type { AdminRole, DeviceStatus, LicenseStatus } from "./types";

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatExpiry(value: string | null): string {
  return value ? formatDateTime(value) : "Vĩnh viễn";
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "Tắt offline";
  if (seconds % 86400 === 0) return `${seconds / 86400} ngày`;
  if (seconds % 3600 === 0) return `${seconds / 3600} giờ`;
  if (seconds % 60 === 0) return `${seconds / 60} phút`;
  return `${seconds} giây`;
}

export function statusTone(status: LicenseStatus | DeviceStatus | string): string {
  switch (status) {
    case "ACTIVE":
      return "success";
    case "INACTIVE":
      return "neutral";
    case "EXPIRED":
      return "warning";
    case "REVOKED":
    case "DISABLED":
      return "danger";
    case "ARCHIVED":
      return "neutral";
    default:
      return "neutral";
  }
}

const ROLE_PERMISSIONS: Record<AdminRole, Set<string>> = {
  OWNER: new Set([
    "admin:read",
    "admin:write",
    "application:read",
    "application:write",
    "customer:read",
    "customer:write",
    "license:read",
    "license:create",
    "license:renew",
    "license:revoke",
    "license:archive",
    "license:device-limit",
    "device:read",
    "device:revoke",
  ]),
  ADMIN: new Set([
    "application:read",
    "application:write",
    "customer:read",
    "customer:write",
    "license:read",
    "license:create",
    "license:renew",
    "license:revoke",
    "license:archive",
    "license:device-limit",
    "device:read",
    "device:revoke",
  ]),
  STAFF: new Set([
    "application:read",
    "customer:read",
    "customer:write",
    "license:read",
    "license:create",
    "license:renew",
    "device:read",
  ]),
};

export function can(role: AdminRole, permission: string): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function pageCount(total: number, limit: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, limit)));
}
