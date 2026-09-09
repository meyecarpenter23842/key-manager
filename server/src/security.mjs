import { Buffer } from "node:buffer";
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const DUMMY_PASSWORD_HASH =
  "scrypt$32768$8$1$QkJCQkJCQkJCQkJCQkJCQg$q2TNhJ48cbQ8YAlGzBiIuNr4hNm31eg-Ez3XqbF40lw";

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

export function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

export function validateEmail(email) {
  const normalized = normalizeEmail(email);
  return normalized.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

export function validatePassword(password) {
  return (
    typeof password === "string" &&
    password.length >= PASSWORD_MIN_LENGTH &&
    password.length <= PASSWORD_MAX_LENGTH
  );
}

export async function hashPassword(password) {
  if (!validatePassword(password)) {
    throw new Error(
      `password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters`,
    );
  }

  const salt = randomBytes(16);
  const derivedKey = await scrypt(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEMORY,
  });

  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    Buffer.from(derivedKey).toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password, encodedHash) {
  if (typeof password !== "string" || typeof encodedHash !== "string") {
    return false;
  }

  const [algorithm, nText, rText, pText, saltText, digestText, ...extra] = encodedHash.split("$");
  if (algorithm !== "scrypt" || !saltText || !digestText || extra.length > 0) {
    return false;
  }

  const N = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) {
    return false;
  }

  let salt;
  let expected;
  try {
    salt = Buffer.from(saltText, "base64url");
    expected = Buffer.from(digestText, "base64url");
  } catch {
    return false;
  }

  if (salt.length !== 16 || expected.length !== SCRYPT_KEY_LENGTH) {
    return false;
  }

  const actual = Buffer.from(
    await scrypt(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT_MAX_MEMORY,
    }),
  );

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token) {
  if (typeof token !== "string" || token.length < 32 || token.length > 256) {
    return null;
  }

  return createHash("sha256").update(token, "utf8").digest();
}
