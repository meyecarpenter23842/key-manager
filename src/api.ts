import type {
  AdminIdentity,
  AdminListItem,
  Application,
  Customer,
  CustomerDetail,
  Device,
  License,
  LicenseDetail,
  Pagination,
} from "./types";

const API_BASE = (import.meta.env.VITE_ADMIN_API_URL || "http://127.0.0.1:3001").replace(/\/$/, "");
const TOKEN_KEY = "key-manager.admin-session";

interface ApiErrorPayload {
  error?: { code?: string; message?: string };
  requestId?: string;
}

export class ApiError extends Error {
  status: number;
  code: string;
  requestId: string | null;

  constructor(message: string, { status, code, requestId }: { status: number; code: string; requestId: string | null }) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

function sessionToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

function requestId(): string {
  return crypto.randomUUID();
}

async function request<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
  const headers = new Headers(init.headers);
  const outgoingRequestId = requestId();
  headers.set("accept", "application/json");
  headers.set("x-request-id", outgoingRequestId);
  if (init.body !== undefined && init.body !== null) headers.set("content-type", "application/json");
  const token = sessionToken();
  if (auth && token) headers.set("authorization", `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError("Không kết nối được Admin API", {
      status: 0,
      code: "NETWORK_ERROR",
      requestId: outgoingRequestId,
    });
  }

  const responseRequestId = response.headers.get("x-request-id");
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const payload = (body ?? {}) as ApiErrorPayload;
    if (response.status === 401 && auth) clearSession();
    throw new ApiError(payload.error?.message || `Admin API trả về HTTP ${response.status}`, {
      status: response.status,
      code: payload.error?.code || "HTTP_ERROR",
      requestId: payload.requestId || responseRequestId || outgoingRequestId,
    });
  }

  return body as T;
}

function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

export function apiBaseUrl(): string {
  return API_BASE;
}

export function hasSession(): boolean {
  return Boolean(sessionToken());
}

export function clearSession(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

export async function login(email: string, password: string): Promise<{ admin: AdminIdentity; expiresAt: string }> {
  const result = await request<{ token: string; admin: AdminIdentity; expiresAt: string }>(
    "/api/admin/v1/auth/login",
    { method: "POST", body: JSON.stringify({ email, password }) },
    false,
  );
  sessionStorage.setItem(TOKEN_KEY, result.token);
  return { admin: result.admin, expiresAt: result.expiresAt };
}

export async function me(): Promise<AdminIdentity> {
  const result = await request<{ admin: AdminIdentity }>("/api/admin/v1/auth/me");
  return result.admin;
}

export async function logout(): Promise<void> {
  try {
    await request<null>("/api/admin/v1/auth/logout", { method: "POST" });
  } finally {
    clearSession();
  }
}

export async function health(): Promise<boolean> {
  try {
    await request<{ status: string }>("/health", {}, false);
    return true;
  } catch {
    return false;
  }
}

export async function listApplications(params: {
  q?: string;
  status?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ applications: Application[]; pagination: Pagination }> {
  return request(`/api/admin/v1/applications${query(params)}`);
}

export async function createApplication(data: Omit<Application, "id" | "createdAt" | "updatedAt">): Promise<Application> {
  const result = await request<{ application: Application }>("/api/admin/v1/applications", {
    method: "POST",
    body: JSON.stringify(data),
  });
  return result.application;
}

export async function updateApplication(id: string, data: Partial<Omit<Application, "id" | "createdAt" | "updatedAt">>): Promise<Application> {
  const result = await request<{ application: Application }>(`/api/admin/v1/applications/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
  return result.application;
}

export async function listCustomers(params: { q?: string; limit?: number; offset?: number } = {}): Promise<{ customers: Customer[]; pagination: Pagination }> {
  return request(`/api/admin/v1/customers${query(params)}`);
}

export async function createCustomer(data: Pick<Customer, "name" | "phone" | "email" | "company" | "note">): Promise<Customer> {
  const result = await request<{ customer: Customer }>("/api/admin/v1/customers", {
    method: "POST",
    body: JSON.stringify(data),
  });
  return result.customer;
}

export async function updateCustomer(id: string, data: Partial<Pick<Customer, "name" | "phone" | "email" | "company" | "note">>): Promise<Customer> {
  const result = await request<{ customer: Customer }>(`/api/admin/v1/customers/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
  return result.customer;
}

export async function getCustomer(id: string): Promise<CustomerDetail> {
  const result = await request<{ customer: CustomerDetail }>(`/api/admin/v1/customers/${id}`);
  return result.customer;
}

export async function listLicenses(params: {
  q?: string;
  applicationId?: string;
  customerId?: string;
  licenseType?: string;
  status?: string;
  expiringWithinDays?: number;
  limit?: number;
  offset?: number;
} = {}): Promise<{ licenses: License[]; pagination: Pagination }> {
  return request(`/api/admin/v1/licenses${query(params)}`);
}

export async function getLicense(id: string): Promise<LicenseDetail> {
  const result = await request<{ license: LicenseDetail }>(`/api/admin/v1/licenses/${id}`);
  return result.license;
}

export async function createLicense(data: {
  applicationId: string;
  customerId: string | null;
  licenseType: "SUBSCRIPTION" | "LIFETIME";
  durationDays?: number;
  maxDevices?: number;
  note?: string | null;
}): Promise<{ license: License; licenseKey: string }> {
  return request("/api/admin/v1/licenses", { method: "POST", body: JSON.stringify(data) });
}

export async function revealLicenseKey(id: string): Promise<string> {
  const result = await request<{ licenseKey: string }>(`/api/admin/v1/licenses/${id}/reveal-key`, {
    method: "POST",
  });
  return result.licenseKey;
}

export async function renewLicense(id: string, data: { durationDays?: number; toLifetime?: boolean }): Promise<License> {
  const result = await request<{ license: License }>(`/api/admin/v1/licenses/${id}/renew`, {
    method: "POST",
    body: JSON.stringify(data),
  });
  return result.license;
}

export async function revokeLicense(id: string): Promise<License> {
  const result = await request<{ license: License }>(`/api/admin/v1/licenses/${id}/revoke`, { method: "POST" });
  return result.license;
}

export async function reactivateLicense(id: string): Promise<License> {
  const result = await request<{ license: License }>(`/api/admin/v1/licenses/${id}/reactivate`, { method: "POST" });
  return result.license;
}

export async function archiveLicense(id: string): Promise<License> {
  const result = await request<{ license: License }>(`/api/admin/v1/licenses/${id}/archive`, { method: "POST" });
  return result.license;
}

export async function setLicenseDeviceLimit(id: string, maxDevices: number): Promise<License> {
  const result = await request<{ license: License }>(`/api/admin/v1/licenses/${id}/device-limit`, {
    method: "PATCH",
    body: JSON.stringify({ maxDevices }),
  });
  return result.license;
}

export async function listDevices(params: {
  q?: string;
  licenseId?: string;
  status?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ devices: Device[]; pagination: Pagination }> {
  return request(`/api/admin/v1/devices${query(params)}`);
}

export async function revokeDevice(id: string): Promise<Device> {
  const result = await request<{ device: Device }>(`/api/admin/v1/devices/${id}/revoke`, { method: "POST" });
  return result.device;
}

export async function listAdmins(): Promise<AdminListItem[]> {
  const result = await request<{ admins: AdminListItem[] }>("/api/admin/v1/admins");
  return result.admins;
}

export async function createAdmin(data: { email: string; password: string; role: "OWNER" | "ADMIN" | "STAFF" }): Promise<AdminListItem> {
  const result = await request<{ admin: AdminListItem }>("/api/admin/v1/admins", {
    method: "POST",
    body: JSON.stringify(data),
  });
  return result.admin;
}
