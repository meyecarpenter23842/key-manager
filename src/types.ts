export type AdminRole = "OWNER" | "ADMIN" | "STAFF";
export type ResourceStatus = "ACTIVE" | "DISABLED";
export type LicenseStatus = "ACTIVE" | "EXPIRED" | "REVOKED" | "ARCHIVED";
export type LicenseType = "SUBSCRIPTION" | "LIFETIME";
export type DeviceStatus = "ACTIVE" | "INACTIVE" | "REVOKED";

export interface AdminIdentity {
  id: string;
  email: string;
  role: AdminRole;
  status: "ACTIVE" | "DISABLED";
}

export interface AdminListItem {
  id: string;
  email: string;
  role: AdminRole;
  status: string;
  last_login_at?: string | null;
  created_at: string;
  updated_at?: string;
}

export interface Application {
  id: string;
  name: string;
  appCode: string;
  description: string | null;
  currentVersion: string | null;
  minimumVersion: string | null;
  status: ResourceStatus;
  offlineGraceSeconds: number;
  defaultDeviceLimit: number;
  defaultDurationDays: number;
  allowLifetime: boolean;
  iconDataUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  company: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerLicenseDevice extends LicenseDevice {
  licenseId: string;
}

export interface CustomerRenewalEvent extends LicenseEvent {
  licenseId: string;
}

export interface CustomerLicenseDetail {
  id: string;
  licenseKeyPreview: string;
  licenseType: LicenseType;
  expiresAt: string | null;
  maxDevices: number;
  status: LicenseStatus;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  application: {
    id: string;
    name: string;
    appCode: string;
    iconDataUrl: string | null;
  };
  deviceCount: number;
  activeDeviceCount: number;
  devices: CustomerLicenseDevice[];
  renewalHistory: CustomerRenewalEvent[];
}

export interface CustomerDetail extends Customer {
  licenses: CustomerLicenseDetail[];
}

export interface License {
  id: string;
  applicationId: string;
  customerId: string | null;
  licenseKeyPreview: string;
  licenseType: LicenseType;
  expiresAt: string | null;
  maxDevices: number;
  status: LicenseStatus;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  applicationName: string;
  appCode: string;
  applicationIconDataUrl: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  customerCompany: string | null;
  deviceCount: number;
  activeDeviceCount: number;
}

export interface LicenseEvent {
  id: string;
  eventType: string;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  actorType: string;
  actorAdminId: string | null;
  actorEmail: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface LicenseDevice {
  id: string;
  deviceId: string;
  deviceName: string | null;
  os: string | null;
  appVersion: string | null;
  status: DeviceStatus;
  activatedAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

export interface LicenseDetail extends License {
  keyRevealAvailable: boolean;
  application: { id: string; name: string; appCode: string; iconDataUrl: string | null };
  customer: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    company: string | null;
  } | null;
  devices: LicenseDevice[];
  events: LicenseEvent[];
}

export interface Device {
  id: string;
  licenseId: string;
  deviceId: string;
  deviceName: string | null;
  os: string | null;
  appVersion: string | null;
  status: DeviceStatus;
  activatedAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  licenseKeyPreview: string;
  applicationId: string;
  applicationName: string;
  appCode: string;
  customerId: string | null;
  customerName: string | null;
}

export interface Pagination {
  total: number;
  limit: number;
  offset: number;
}
