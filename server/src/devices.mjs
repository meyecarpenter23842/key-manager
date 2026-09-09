const DEVICE_STATUSES = new Set(["ACTIVE", "INACTIVE", "REVOKED"]);

function inputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.errorCode = "INVALID_REQUEST";
  return error;
}

function normalizeRequiredText(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw inputError(`${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw inputError(`${field} is too long`);
  }
  return normalized;
}

function normalizeOptionalText(value, field, maxLength) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw inputError(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) throw inputError(`${field} is too long`);
  return normalized;
}

export function normalizeDeviceActivation(input, isUuid) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw inputError("Invalid device activation payload");
  }
  const licenseId = String(input.licenseId ?? "").trim();
  if (!isUuid(licenseId)) throw inputError("licenseId must be a UUID");

  return {
    licenseId,
    deviceId: normalizeRequiredText(input.deviceId, "deviceId", 512),
    deviceName: normalizeOptionalText(input.deviceName, "deviceName", 255),
    os: normalizeOptionalText(input.os, "os", 255),
    appVersion: normalizeOptionalText(input.appVersion, "appVersion", 64),
  };
}

export function parseDeviceFilters(url, isUuid) {
  const licenseIdText = url.searchParams.get("licenseId");
  const licenseId = licenseIdText?.trim() || null;
  if (licenseId !== null && !isUuid(licenseId)) {
    throw inputError("licenseId must be a UUID");
  }

  const statusText = url.searchParams.get("status");
  const status = statusText?.trim().toUpperCase() || null;
  if (status !== null && !DEVICE_STATUSES.has(status)) {
    throw inputError("status must be ACTIVE, INACTIVE or REVOKED");
  }

  return { licenseId, status };
}
