export const ADMIN_ROLES = Object.freeze(["OWNER", "ADMIN", "STAFF"]);

export const PERMISSIONS = Object.freeze({
  ADMIN_READ: "admin:read",
  ADMIN_WRITE: "admin:write",
  APPLICATION_READ: "application:read",
  APPLICATION_WRITE: "application:write",
  CUSTOMER_READ: "customer:read",
  CUSTOMER_WRITE: "customer:write",
  LICENSE_READ: "license:read",
  LICENSE_CREATE: "license:create",
  LICENSE_RENEW: "license:renew",
  LICENSE_REVOKE: "license:revoke",
  LICENSE_ARCHIVE: "license:archive",
  LICENSE_DEVICE_LIMIT: "license:device-limit",
  DEVICE_READ: "device:read",
  DEVICE_REVOKE: "device:revoke",
  AUDIT_READ: "audit:read",
});

const ownerPermissions = Object.freeze(Object.values(PERMISSIONS));
const adminPermissions = Object.freeze([
  PERMISSIONS.APPLICATION_READ,
  PERMISSIONS.APPLICATION_WRITE,
  PERMISSIONS.CUSTOMER_READ,
  PERMISSIONS.CUSTOMER_WRITE,
  PERMISSIONS.LICENSE_READ,
  PERMISSIONS.LICENSE_CREATE,
  PERMISSIONS.LICENSE_RENEW,
  PERMISSIONS.LICENSE_REVOKE,
  PERMISSIONS.LICENSE_ARCHIVE,
  PERMISSIONS.LICENSE_DEVICE_LIMIT,
  PERMISSIONS.DEVICE_READ,
  PERMISSIONS.DEVICE_REVOKE,
  PERMISSIONS.AUDIT_READ,
]);
const staffPermissions = Object.freeze([
  PERMISSIONS.APPLICATION_READ,
  PERMISSIONS.CUSTOMER_READ,
  PERMISSIONS.CUSTOMER_WRITE,
  PERMISSIONS.LICENSE_READ,
  PERMISSIONS.LICENSE_CREATE,
  PERMISSIONS.LICENSE_RENEW,
  PERMISSIONS.DEVICE_READ,
]);

export const ROLE_PERMISSIONS = Object.freeze({
  OWNER: ownerPermissions,
  ADMIN: adminPermissions,
  STAFF: staffPermissions,
});

export function isAdminRole(role) {
  return ADMIN_ROLES.includes(role);
}

export function hasPermission(role, permission) {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
