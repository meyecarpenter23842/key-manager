import { readFileSync } from "node:fs";
import process from "node:process";
import { Buffer } from "node:buffer";
import {
  createPrivateKey,
  createPublicKey,
  sign as signMessage,
  verify as verifyMessage,
} from "node:crypto";

const TOKEN_TYPE = "KM-OFFLINE";
const TOKEN_ALGORITHM = "EdDSA";
const TOKEN_SCHEMA_VERSION = 1;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function configError(message, cause) {
  return new Error(`Offline signing configuration error: ${message}`, cause ? { cause } : undefined);
}

function tokenError(message) {
  return new Error(`Invalid offline license token: ${message}`);
}

function parseEnabled(value) {
  if (value === undefined || value === null || String(value).trim() === "") return false;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw configError("OFFLINE_SIGNING_ENABLED must be true or false");
}

function normalizeKeyId(value) {
  const keyId = typeof value === "string" ? value.trim() : "";
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw configError(
      "OFFLINE_SIGNING_KEY_ID must be 1-64 letters, numbers, '.', '_', ':', or '-'",
    );
  }
  return keyId;
}

function privateKeyObject(value) {
  try {
    const key = value?.type === "private" ? value : createPrivateKey(value);
    if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
      throw new Error("key is not an Ed25519 private key");
    }
    return key;
  } catch (error) {
    throw configError("private key must be a valid Ed25519 private key", error);
  }
}

function publicKeyObject(value) {
  try {
    const key = value?.type === "public" ? value : createPublicKey(value);
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
      throw new Error("key is not an Ed25519 public key");
    }
    return key;
  } catch (error) {
    throw tokenError(`public key is invalid: ${error.message}`);
  }
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeJson(encoded, label) {
  if (typeof encoded !== "string" || !encoded || !BASE64URL_PATTERN.test(encoded)) {
    throw tokenError(`${label} is not valid base64url`);
  }
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw tokenError(`${label} is not valid JSON`);
  }
}

function normalizeDate(value, field) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${field} must be a valid date`);
  return date;
}

function normalizeGraceSeconds(value) {
  if (!Number.isInteger(value) || value < 0 || value > 2_592_000) {
    throw new Error("offlineGraceSeconds must be an integer between 0 and 2592000");
  }
  return value;
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw tokenError("payload must be a JSON object");
  }
  if (payload.schema_version !== TOKEN_SCHEMA_VERSION) {
    throw tokenError(`unsupported schema_version ${String(payload.schema_version)}`);
  }

  for (const field of ["license_id", "app_id", "app_code", "device_id", "issued_at", "offline_valid_until"]) {
    if (typeof payload[field] !== "string" || !payload[field]) {
      throw tokenError(`${field} is required`);
    }
  }
  if (payload.expires_at !== null && typeof payload.expires_at !== "string") {
    throw tokenError("expires_at must be a string or null");
  }

  const issuedAt = Date.parse(payload.issued_at);
  const offlineValidUntil = Date.parse(payload.offline_valid_until);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(offlineValidUntil)) {
    throw tokenError("issued_at and offline_valid_until must be valid timestamps");
  }
  if (offlineValidUntil < issuedAt) {
    throw tokenError("offline_valid_until cannot be before issued_at");
  }
  if (payload.expires_at !== null) {
    const expiresAt = Date.parse(payload.expires_at);
    if (!Number.isFinite(expiresAt)) throw tokenError("expires_at must be a valid timestamp");
    if (offlineValidUntil > expiresAt) {
      throw tokenError("offline_valid_until cannot exceed expires_at");
    }
  }
}

function lookupPublicKey(publicKeys, keyId) {
  if (publicKeys instanceof Map) return publicKeys.get(keyId);
  if (publicKeys && typeof publicKeys === "object") return publicKeys[keyId];
  return undefined;
}

export function createOfflineLicenseSigner({ keyId, privateKey }) {
  const normalizedKeyId = normalizeKeyId(keyId);
  const signingKey = privateKeyObject(privateKey);

  return {
    algorithm: "Ed25519",
    keyId: normalizedKeyId,

    issue({
      licenseId,
      applicationId,
      appCode,
      deviceId,
      licenseExpiresAt = null,
      offlineGraceSeconds,
      issuedAt = new Date(),
    }) {
      const issued = normalizeDate(issuedAt, "issuedAt");
      const graceSeconds = normalizeGraceSeconds(offlineGraceSeconds);
      const licenseExpiry =
        licenseExpiresAt === null || licenseExpiresAt === undefined
          ? null
          : normalizeDate(licenseExpiresAt, "licenseExpiresAt");

      if (licenseExpiry !== null && licenseExpiry.getTime() <= issued.getTime()) {
        throw new Error("Cannot issue an offline token for an expired license");
      }

      let offlineValidUntil = new Date(issued.getTime() + graceSeconds * 1000);
      if (licenseExpiry !== null && licenseExpiry.getTime() < offlineValidUntil.getTime()) {
        offlineValidUntil = licenseExpiry;
      }

      const header = {
        alg: TOKEN_ALGORITHM,
        typ: TOKEN_TYPE,
        kid: normalizedKeyId,
      };
      const payload = {
        schema_version: TOKEN_SCHEMA_VERSION,
        license_id: requiredString(licenseId, "licenseId"),
        app_id: requiredString(applicationId, "applicationId"),
        app_code: requiredString(appCode, "appCode"),
        device_id: requiredString(deviceId, "deviceId"),
        issued_at: issued.toISOString(),
        expires_at: licenseExpiry === null ? null : licenseExpiry.toISOString(),
        offline_valid_until: offlineValidUntil.toISOString(),
      };

      const encodedHeader = encodeJson(header);
      const encodedPayload = encodeJson(payload);
      const signingInput = `${encodedHeader}.${encodedPayload}`;
      const signature = signMessage(null, Buffer.from(signingInput, "ascii"), signingKey);
      const token = `${signingInput}.${signature.toString("base64url")}`;

      return {
        token,
        algorithm: "Ed25519",
        keyId: normalizedKeyId,
        issuedAt: payload.issued_at,
        offlineValidUntil: payload.offline_valid_until,
        payload,
      };
    },
  };
}

export function createOfflineLicenseSignerFromEnv(
  env = process.env,
  { readFile = readFileSync } = {},
) {
  if (!parseEnabled(env.OFFLINE_SIGNING_ENABLED)) return null;

  const keyId = normalizeKeyId(env.OFFLINE_SIGNING_KEY_ID);
  const inlineValue =
    typeof env.OFFLINE_SIGNING_PRIVATE_KEY === "string"
      ? env.OFFLINE_SIGNING_PRIVATE_KEY.trim()
      : "";
  const fileValue =
    typeof env.OFFLINE_SIGNING_PRIVATE_KEY_FILE === "string"
      ? env.OFFLINE_SIGNING_PRIVATE_KEY_FILE.trim()
      : "";

  if (inlineValue && fileValue) {
    throw configError(
      "provide exactly one of OFFLINE_SIGNING_PRIVATE_KEY or OFFLINE_SIGNING_PRIVATE_KEY_FILE",
    );
  }
  if (!inlineValue && !fileValue) {
    throw configError(
      "OFFLINE_SIGNING_PRIVATE_KEY or OFFLINE_SIGNING_PRIVATE_KEY_FILE is required when signing is enabled",
    );
  }

  let privateKey;
  if (inlineValue) {
    privateKey = inlineValue.replace(/\\n/g, "\n");
  } else {
    try {
      privateKey = readFile(fileValue, "utf8");
    } catch (error) {
      throw configError(`cannot read OFFLINE_SIGNING_PRIVATE_KEY_FILE: ${fileValue}`, error);
    }
  }

  return createOfflineLicenseSigner({ keyId, privateKey });
}

export function verifyOfflineLicenseToken(token, { publicKeys, expected = {} } = {}) {
  if (typeof token !== "string") throw tokenError("token must be a string");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw tokenError("token must have header, payload, and signature segments");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJson(encodedHeader, "header");
  const payload = decodeJson(encodedPayload, "payload");

  if (
    !header ||
    typeof header !== "object" ||
    Array.isArray(header) ||
    header.alg !== TOKEN_ALGORITHM ||
    header.typ !== TOKEN_TYPE ||
    typeof header.kid !== "string" ||
    !KEY_ID_PATTERN.test(header.kid)
  ) {
    throw tokenError("header is invalid or unsupported");
  }

  const keyMaterial = lookupPublicKey(publicKeys, header.kid);
  if (!keyMaterial) throw tokenError(`unknown key id: ${header.kid}`);
  const key = publicKeyObject(keyMaterial);

  if (!BASE64URL_PATTERN.test(encodedSignature)) {
    throw tokenError("signature is not valid base64url");
  }
  const signature = Buffer.from(encodedSignature, "base64url");
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  if (!verifyMessage(null, Buffer.from(signingInput, "ascii"), key, signature)) {
    throw tokenError("signature verification failed");
  }

  validatePayload(payload);

  const bindings = [
    ["licenseId", "license_id"],
    ["applicationId", "app_id"],
    ["appCode", "app_code"],
    ["deviceId", "device_id"],
  ];
  for (const [expectedField, payloadField] of bindings) {
    if (expected[expectedField] !== undefined && expected[expectedField] !== payload[payloadField]) {
      throw tokenError(`binding mismatch for ${expectedField}`);
    }
  }

  return { header, payload };
}
