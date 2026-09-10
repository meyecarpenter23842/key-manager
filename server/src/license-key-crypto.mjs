import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const ENVELOPE_VERSION = "v1";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

function invalidKey(message) {
  const error = new Error(message);
  error.code = "LICENSE_KEY_ENCRYPTION_KEY_INVALID";
  return error;
}

function parseKey(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim();
  let key;

  if (/^[0-9a-fA-F]{64}$/.test(normalized)) {
    key = Buffer.from(normalized, "hex");
  } else if (/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    key = Buffer.from(normalized, "base64");
  } else {
    throw invalidKey("LICENSE_KEY_ENCRYPTION_KEY must be 32 bytes encoded as 64 hex chars or base64");
  }

  if (key.length !== KEY_BYTES) {
    throw invalidKey("LICENSE_KEY_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

function decodePart(value, label) {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`LICENSE_KEY_CIPHERTEXT_INVALID: ${label}`);
  }
  return Buffer.from(value, "base64url");
}

export function createLicenseKeyProtector(encodedKey) {
  const key = parseKey(encodedKey);
  if (!key) return null;

  return Object.freeze({
    encrypt(rawLicenseKey) {
      if (typeof rawLicenseKey !== "string" || !rawLicenseKey.trim()) {
        throw new Error("LICENSE_KEY_ENCRYPT_FAILED: license key is empty");
      }
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: 16 });
      const ciphertext = Buffer.concat([
        cipher.update(rawLicenseKey, "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return [
        ENVELOPE_VERSION,
        nonce.toString("base64url"),
        tag.toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(".");
    },

    decrypt(envelope) {
      if (typeof envelope !== "string") {
        throw new Error("LICENSE_KEY_CIPHERTEXT_INVALID: envelope is not text");
      }
      const parts = envelope.split(".");
      if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
        throw new Error("LICENSE_KEY_CIPHERTEXT_INVALID: unsupported envelope");
      }
      const nonce = decodePart(parts[1], "nonce");
      const tag = decodePart(parts[2], "tag");
      const ciphertext = decodePart(parts[3], "ciphertext");
      if (nonce.length !== NONCE_BYTES || tag.length !== 16 || ciphertext.length === 0) {
        throw new Error("LICENSE_KEY_CIPHERTEXT_INVALID: invalid envelope lengths");
      }
      const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: 16 });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    },
  });
}
