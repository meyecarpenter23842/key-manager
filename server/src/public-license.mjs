import { normalizeRawLicenseKey } from "./licenses.mjs";

const APP_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;
const VERSION_PATTERN = /^v?(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function invalid(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.errorCode = "INVALID_REQUEST";
  return error;
}

function assertObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("payload must be a JSON object");
  }
}

function assertAllowedKeys(value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw invalid(`Unknown field: ${unknown[0]}`);
}

function requiredText(value, field, max) {
  if (typeof value !== "string") throw invalid(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw invalid(`${field} must not be blank`);
  if (normalized.length > max) throw invalid(`${field} is too long`);
  return normalized;
}

function optionalText(value, field, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw invalid(`${field} must be a string or null`);
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > max) throw invalid(`${field} is too long`);
  return normalized;
}

function normalizeAppCode(value) {
  const normalized = requiredText(value, "appCode", 32).toUpperCase();
  if (!APP_CODE_PATTERN.test(normalized)) {
    throw invalid("appCode must use 2-32 uppercase letters, numbers, '_' or '-'");
  }
  return normalized;
}

function normalizeLicenseKey(value) {
  const normalized = normalizeRawLicenseKey(value);
  if (!normalized) throw invalid("licenseKey is required");
  if (normalized.length > 256) throw invalid("licenseKey is too long");
  return normalized;
}

function normalizeVersion(value, { required = true } = {}) {
  if ((value === undefined || value === null) && !required) return null;
  const normalized = requiredText(value, "appVersion", 64);
  if (!VERSION_PATTERN.test(normalized)) {
    throw invalid("appVersion must be a dotted numeric version such as 1.2.3");
  }
  return normalized;
}

const BASE_FIELDS = new Set(["appCode", "licenseKey", "deviceId", "appVersion"]);
const METADATA_FIELDS = new Set([
  "appCode",
  "licenseKey",
  "deviceId",
  "deviceName",
  "os",
  "appVersion",
]);

function normalizeBase(body, { metadata = false, versionRequired = true } = {}) {
  assertObject(body);
  assertAllowedKeys(body, metadata ? METADATA_FIELDS : BASE_FIELDS);
  return {
    appCode: normalizeAppCode(body.appCode),
    licenseKey: normalizeLicenseKey(body.licenseKey),
    deviceId: requiredText(body.deviceId, "deviceId", 512),
    deviceName: metadata ? optionalText(body.deviceName, "deviceName", 200) : null,
    os: metadata ? optionalText(body.os, "os", 200) : null,
    appVersion: normalizeVersion(body.appVersion, { required: versionRequired }),
  };
}

export function normalizeActivation(body) {
  return normalizeBase(body, { metadata: true, versionRequired: true });
}

export function normalizeValidation(body) {
  return normalizeBase(body, { metadata: false, versionRequired: true });
}

export function normalizeHeartbeat(body) {
  return normalizeBase(body, { metadata: true, versionRequired: true });
}

export function normalizeDeactivation(body) {
  return normalizeBase(body, { metadata: false, versionRequired: false });
}

function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return null;
  const numeric = match[1].split(".").map(Number);
  while (numeric.length < 4) numeric.push(0);
  const prerelease = match[2] ? match[2].split(".") : [];
  return { numeric, prerelease };
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) {
      const difference = Number(left[index]) - Number(right[index]);
      if (difference !== 0) return Math.sign(difference);
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    const difference = left[index].localeCompare(right[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function compareAppVersions(leftValue, rightValue) {
  const left = parseVersion(leftValue);
  const right = parseVersion(rightValue);
  if (!left || !right) return null;
  for (let index = 0; index < 4; index += 1) {
    const difference = left.numeric[index] - right.numeric[index];
    if (difference !== 0) return Math.sign(difference);
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}
