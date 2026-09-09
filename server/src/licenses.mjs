import { createHash, randomBytes } from "node:crypto";

const LICENSE_TYPES = new Set(["SUBSCRIPTION", "LIFETIME"]);
const LICENSE_STATUSES = new Set(["ACTIVE", "EXPIRED", "REVOKED", "ARCHIVED"]);
const MAX_DURATION_DAYS = 36500;
const MAX_DEVICE_LIMIT = 32767;

function invalid(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function assertObject(value, label = "payload") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${label} must be a JSON object`);
  }
}

function assertAllowedKeys(value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw invalid(`Unknown field: ${unknown[0]}`);
}

function integer(value, field, { min, max }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalid(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function nullableText(value, field, max) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw invalid(`${field} must be a string or null`);
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > max) throw invalid(`${field} is too long`);
  return normalized;
}

function enumValue(value, field, values) {
  if (typeof value !== "string" || !values.has(value)) {
    throw invalid(`${field} is invalid`);
  }
  return value;
}

export function generateLicenseKey(appCode) {
  const entropy = randomBytes(16).toString("hex").toUpperCase();
  const groups = entropy.match(/.{1,8}/g);
  return `${appCode}-${groups.join("-")}`;
}

export function normalizeRawLicenseKey(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return normalized || null;
}

export function hashLicenseKey(value) {
  const normalized = normalizeRawLicenseKey(value);
  if (!normalized) return null;
  return createHash("sha256").update(normalized, "utf8").digest();
}

export function maskLicenseKey(value) {
  const normalized = normalizeRawLicenseKey(value);
  if (!normalized) throw invalid("license key is required");
  const lastGroup = normalized.split("-").at(-1) || normalized.slice(-8);
  return `****-****-${lastGroup.slice(-8)}`;
}

const LICENSE_CREATE_FIELDS = new Set([
  "applicationId",
  "customerId",
  "licenseType",
  "durationDays",
  "maxDevices",
  "note",
]);

export function normalizeLicenseCreate(body, isUuid) {
  assertObject(body);
  assertAllowedKeys(body, LICENSE_CREATE_FIELDS);
  if (!isUuid(body.applicationId)) throw invalid("applicationId must be a UUID");
  if (body.customerId !== undefined && body.customerId !== null && !isUuid(body.customerId)) {
    throw invalid("customerId must be a UUID or null");
  }

  const licenseType = enumValue(body.licenseType, "licenseType", LICENSE_TYPES);
  const durationDays =
    body.durationDays === undefined
      ? null
      : integer(body.durationDays, "durationDays", { min: 1, max: MAX_DURATION_DAYS });
  if (licenseType === "LIFETIME" && durationDays !== null) {
    throw invalid("durationDays is not allowed for LIFETIME licenses");
  }

  return {
    applicationId: body.applicationId,
    customerId: body.customerId ?? null,
    licenseType,
    durationDays,
    maxDevices:
      body.maxDevices === undefined
        ? null
        : integer(body.maxDevices, "maxDevices", { min: 1, max: MAX_DEVICE_LIMIT }),
    note: nullableText(body.note, "note", 4000) ?? null,
  };
}

const LICENSE_RENEW_FIELDS = new Set(["durationDays", "toLifetime"]);

export function normalizeLicenseRenew(body) {
  assertObject(body);
  assertAllowedKeys(body, LICENSE_RENEW_FIELDS);
  const toLifetime = body.toLifetime === true;
  if (body.toLifetime !== undefined && typeof body.toLifetime !== "boolean") {
    throw invalid("toLifetime must be a boolean");
  }
  const durationDays =
    body.durationDays === undefined
      ? null
      : integer(body.durationDays, "durationDays", { min: 1, max: MAX_DURATION_DAYS });
  if (toLifetime === (durationDays !== null)) {
    throw invalid("Provide exactly one of durationDays or toLifetime=true");
  }
  return { durationDays, toLifetime };
}

export function normalizeDeviceLimit(body) {
  assertObject(body);
  assertAllowedKeys(body, new Set(["maxDevices"]));
  return {
    maxDevices: integer(body.maxDevices, "maxDevices", { min: 1, max: MAX_DEVICE_LIMIT }),
  };
}

export function parseLicenseFilters(url, isUuid) {
  const applicationId = url.searchParams.get("applicationId");
  const customerId = url.searchParams.get("customerId");
  const licenseType = url.searchParams.get("licenseType");
  const status = url.searchParams.get("status");
  const expiringWithinDaysRaw = url.searchParams.get("expiringWithinDays");

  if (applicationId && !isUuid(applicationId)) throw invalid("applicationId must be a UUID");
  if (customerId && !isUuid(customerId)) throw invalid("customerId must be a UUID");

  return {
    applicationId: applicationId || null,
    customerId: customerId || null,
    licenseType: licenseType ? enumValue(licenseType, "licenseType", LICENSE_TYPES) : null,
    status: status ? enumValue(status, "status", LICENSE_STATUSES) : null,
    expiringWithinDays:
      expiringWithinDaysRaw === null || expiringWithinDaysRaw === ""
        ? null
        : integer(Number(expiringWithinDaysRaw), "expiringWithinDays", { min: 1, max: 3650 }),
  };
}
