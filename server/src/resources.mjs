const APPLICATION_STATUSES = new Set(["ACTIVE", "DISABLED"]);
const APP_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  if (unknown.length > 0) {
    throw invalid(`Unknown field: ${unknown[0]}`);
  }
}

function text(value, field, { required = false, max = 1000, nullable = false } = {}) {
  if (value === undefined) {
    if (required) throw invalid(`${field} is required`);
    return undefined;
  }
  if (value === null) {
    if (nullable) return null;
    throw invalid(`${field} must be a string`);
  }
  if (typeof value !== "string") throw invalid(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) {
    if (nullable) return null;
    throw invalid(`${field} must not be blank`);
  }
  if (normalized.length > max) throw invalid(`${field} is too long`);
  return normalized;
}

function nullableText(value, field, max) {
  return text(value, field, { max, nullable: true });
}

function integer(value, field, { min, max }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalid(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function boolean(value, field) {
  if (typeof value !== "boolean") throw invalid(`${field} must be a boolean`);
  return value;
}

function applicationStatus(value) {
  if (typeof value !== "string" || !APPLICATION_STATUSES.has(value)) {
    throw invalid("status must be ACTIVE or DISABLED");
  }
  return value;
}

function appCode(value, required) {
  const normalized = text(value, "appCode", { required, max: 32 });
  if (normalized === undefined) return undefined;
  const upper = normalized.toUpperCase();
  if (!APP_CODE_PATTERN.test(upper)) {
    throw invalid("appCode must use 2-32 uppercase letters, numbers, '_' or '-'");
  }
  return upper;
}

function customerEmail(value) {
  const normalized = nullableText(value, "email", 320);
  if (normalized === undefined || normalized === null) return normalized;
  const lower = normalized.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lower)) throw invalid("email is invalid");
  return lower;
}

function applicationIconDataUrl(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw invalid("iconDataUrl must be a string");
  if (Buffer.byteLength(value, "utf8") > 262144) throw invalid("iconDataUrl is too large");
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw invalid("iconDataUrl must be a base64 PNG, JPEG or WebP data URL");
  }
  return value;
}

const APPLICATION_FIELDS = new Set([
  "name",
  "appCode",
  "description",
  "currentVersion",
  "minimumVersion",
  "status",
  "offlineGraceSeconds",
  "defaultDeviceLimit",
  "defaultDurationDays",
  "allowLifetime",
  "iconDataUrl",
]);

export function normalizeApplicationCreate(body) {
  assertObject(body);
  assertAllowedKeys(body, APPLICATION_FIELDS);
  return {
    name: text(body.name, "name", { required: true, max: 200 }),
    appCode: appCode(body.appCode, true),
    description: nullableText(body.description, "description", 4000) ?? null,
    currentVersion: nullableText(body.currentVersion, "currentVersion", 64) ?? null,
    minimumVersion: nullableText(body.minimumVersion, "minimumVersion", 64) ?? null,
    status: body.status === undefined ? "ACTIVE" : applicationStatus(body.status),
    offlineGraceSeconds:
      body.offlineGraceSeconds === undefined
        ? 86400
        : integer(body.offlineGraceSeconds, "offlineGraceSeconds", { min: 0, max: 2592000 }),
    defaultDeviceLimit:
      body.defaultDeviceLimit === undefined
        ? 1
        : integer(body.defaultDeviceLimit, "defaultDeviceLimit", { min: 1, max: 32767 }),
    defaultDurationDays:
      body.defaultDurationDays === undefined
        ? 30
        : integer(body.defaultDurationDays, "defaultDurationDays", { min: 1, max: 36500 }),
    allowLifetime:
      body.allowLifetime === undefined ? true : boolean(body.allowLifetime, "allowLifetime"),
    iconDataUrl: applicationIconDataUrl(body.iconDataUrl) ?? null,
  };
}

export function normalizeApplicationPatch(body) {
  assertObject(body);
  assertAllowedKeys(body, APPLICATION_FIELDS);
  const result = {};
  if (Object.hasOwn(body, "name")) result.name = text(body.name, "name", { max: 200 });
  if (Object.hasOwn(body, "appCode")) result.appCode = appCode(body.appCode, false);
  if (Object.hasOwn(body, "description")) {
    result.description = nullableText(body.description, "description", 4000);
  }
  if (Object.hasOwn(body, "currentVersion")) {
    result.currentVersion = nullableText(body.currentVersion, "currentVersion", 64);
  }
  if (Object.hasOwn(body, "minimumVersion")) {
    result.minimumVersion = nullableText(body.minimumVersion, "minimumVersion", 64);
  }
  if (Object.hasOwn(body, "status")) result.status = applicationStatus(body.status);
  if (Object.hasOwn(body, "offlineGraceSeconds")) {
    result.offlineGraceSeconds = integer(body.offlineGraceSeconds, "offlineGraceSeconds", {
      min: 0,
      max: 2592000,
    });
  }
  if (Object.hasOwn(body, "defaultDeviceLimit")) {
    result.defaultDeviceLimit = integer(body.defaultDeviceLimit, "defaultDeviceLimit", {
      min: 1,
      max: 32767,
    });
  }
  if (Object.hasOwn(body, "defaultDurationDays")) {
    result.defaultDurationDays = integer(body.defaultDurationDays, "defaultDurationDays", {
      min: 1,
      max: 36500,
    });
  }
  if (Object.hasOwn(body, "allowLifetime")) {
    result.allowLifetime = boolean(body.allowLifetime, "allowLifetime");
  }
  if (Object.hasOwn(body, "iconDataUrl")) {
    result.iconDataUrl = applicationIconDataUrl(body.iconDataUrl);
  }
  if (Object.keys(result).length === 0) throw invalid("At least one editable field is required");
  return result;
}

const CUSTOMER_FIELDS = new Set(["name", "phone", "email", "company", "note"]);

export function normalizeCustomerCreate(body) {
  assertObject(body);
  assertAllowedKeys(body, CUSTOMER_FIELDS);
  return {
    name: text(body.name, "name", { required: true, max: 200 }),
    phone: nullableText(body.phone, "phone", 100) ?? null,
    email: customerEmail(body.email) ?? null,
    company: nullableText(body.company, "company", 200) ?? null,
    note: nullableText(body.note, "note", 4000) ?? null,
  };
}

export function normalizeCustomerPatch(body) {
  assertObject(body);
  assertAllowedKeys(body, CUSTOMER_FIELDS);
  const result = {};
  if (Object.hasOwn(body, "name")) result.name = text(body.name, "name", { max: 200 });
  if (Object.hasOwn(body, "phone")) result.phone = nullableText(body.phone, "phone", 100);
  if (Object.hasOwn(body, "email")) result.email = customerEmail(body.email);
  if (Object.hasOwn(body, "company")) result.company = nullableText(body.company, "company", 200);
  if (Object.hasOwn(body, "note")) result.note = nullableText(body.note, "note", 4000);
  if (Object.keys(result).length === 0) throw invalid("At least one editable field is required");
  return result;
}

export function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function parsePagination(url, { maxLimit = 100, defaultLimit = 25 } = {}) {
  const rawLimit = url.searchParams.get("limit");
  const rawOffset = url.searchParams.get("offset");
  const limit = rawLimit === null ? defaultLimit : Number(rawLimit);
  const offset = rawOffset === null ? 0 : Number(rawOffset);
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw invalid(`limit must be an integer between 1 and ${maxLimit}`);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw invalid("offset must be a non-negative integer");
  }
  return { limit, offset };
}

export function parseSearch(url) {
  const q = (url.searchParams.get("q") || "").trim();
  if (q.length > 200) throw invalid("q is too long");
  return q;
}

export function parseApplicationStatusFilter(url) {
  const status = url.searchParams.get("status");
  if (status === null || status === "") return null;
  return applicationStatus(status);
}
