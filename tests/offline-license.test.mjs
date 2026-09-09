import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createOfflineLicenseSigner,
  createOfflineLicenseSignerFromEnv,
  verifyOfflineLicenseToken,
} from "../server/src/offline-license.mjs";

const LICENSE_ID = "11111111-1111-1111-1111-111111111111";
const APP_ID = "22222222-2222-2222-2222-222222222222";
const ISSUED_AT = new Date("2026-09-09T10:00:00.000Z");

function fixture({ keyId = "test-key-1", privateKey = null } = {}) {
  const pair = generateKeyPairSync("ed25519");
  const signer = createOfflineLicenseSigner({
    keyId,
    privateKey: privateKey ?? pair.privateKey,
  });
  const issued = signer.issue({
    licenseId: LICENSE_ID,
    applicationId: APP_ID,
    appCode: "APP_A",
    deviceId: "device-1",
    licenseExpiresAt: null,
    offlineGraceSeconds: 3600,
    issuedAt: ISSUED_AT,
  });
  return { ...pair, signer, issued };
}

function tamperPayload(token, mutate) {
  const [header, encodedPayload, signature] = token.split(".");
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  mutate(payload);
  const changed = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${header}.${changed}.${signature}`;
}

function tamperSignature(token) {
  const [header, payload, encodedSignature] = token.split(".");
  const signature = Buffer.from(encodedSignature, "base64url");
  signature[0] ^= 1;
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

describe("offline license Ed25519 tokens", () => {
  it("verifies a valid signed token with the matching public key and bindings", () => {
    const { publicKey, issued } = fixture();
    const verified = verifyOfflineLicenseToken(issued.token, {
      publicKeys: { "test-key-1": publicKey },
      expected: {
        licenseId: LICENSE_ID,
        applicationId: APP_ID,
        appCode: "APP_A",
        deviceId: "device-1",
      },
    });

    expect(verified.header).toEqual({ alg: "EdDSA", typ: "KM-OFFLINE", kid: "test-key-1" });
    expect(verified.payload.schema_version).toBe(1);
    expect(verified.payload.license_id).toBe(LICENSE_ID);
    expect(verified.payload.app_id).toBe(APP_ID);
    expect(verified.payload.app_code).toBe("APP_A");
    expect(verified.payload.device_id).toBe("device-1");
    expect(verified.payload.issued_at).toBe("2026-09-09T10:00:00.000Z");
    expect(verified.payload.expires_at).toBeNull();
    expect(verified.payload.offline_valid_until).toBe("2026-09-09T11:00:00.000Z");
  });

  it("rejects a modified payload", () => {
    const { publicKey, issued } = fixture();
    const tampered = tamperPayload(issued.token, (payload) => {
      payload.device_id = "device-2";
    });

    expect(() =>
      verifyOfflineLicenseToken(tampered, { publicKeys: { "test-key-1": publicKey } }),
    ).toThrow(/signature verification failed/);
  });

  it("rejects a modified signature", () => {
    const { publicKey, issued } = fixture();
    expect(() =>
      verifyOfflineLicenseToken(tamperSignature(issued.token), {
        publicKeys: { "test-key-1": publicKey },
      }),
    ).toThrow(/signature verification failed/);
  });

  it("rejects the wrong public key", () => {
    const { issued } = fixture();
    const wrongPair = generateKeyPairSync("ed25519");
    expect(() =>
      verifyOfflineLicenseToken(issued.token, {
        publicKeys: { "test-key-1": wrongPair.publicKey },
      }),
    ).toThrow(/signature verification failed/);
  });

  it("cannot be reused for another application or device", () => {
    const { publicKey, issued } = fixture();
    expect(() =>
      verifyOfflineLicenseToken(issued.token, {
        publicKeys: { "test-key-1": publicKey },
        expected: { applicationId: "33333333-3333-3333-3333-333333333333" },
      }),
    ).toThrow(/binding mismatch for applicationId/);
    expect(() =>
      verifyOfflineLicenseToken(issued.token, {
        publicKeys: { "test-key-1": publicKey },
        expected: { deviceId: "device-2" },
      }),
    ).toThrow(/binding mismatch for deviceId/);
  });

  it("caps subscription offline validity at license expiry", () => {
    const pair = generateKeyPairSync("ed25519");
    const signer = createOfflineLicenseSigner({ keyId: "subscription-key", privateKey: pair.privateKey });
    const issued = signer.issue({
      licenseId: LICENSE_ID,
      applicationId: APP_ID,
      appCode: "APP_A",
      deviceId: "device-1",
      licenseExpiresAt: "2026-09-09T10:30:00.000Z",
      offlineGraceSeconds: 3600,
      issuedAt: ISSUED_AT,
    });
    const verified = verifyOfflineLicenseToken(issued.token, {
      publicKeys: { "subscription-key": pair.publicKey },
    });

    expect(verified.payload.expires_at).toBe("2026-09-09T10:30:00.000Z");
    expect(verified.payload.offline_valid_until).toBe("2026-09-09T10:30:00.000Z");
  });

  it("keeps lifetime licenses bounded by application offline grace", () => {
    const { issued } = fixture();
    expect(issued.payload.expires_at).toBeNull();
    expect(
      Date.parse(issued.payload.offline_valid_until) - Date.parse(issued.payload.issued_at),
    ).toBe(3600 * 1000);
  });

  it("uses kid for public-key rotation", () => {
    const oldPair = generateKeyPairSync("ed25519");
    const newPair = generateKeyPairSync("ed25519");
    const oldSigner = createOfflineLicenseSigner({ keyId: "key-2026-01", privateKey: oldPair.privateKey });
    const newSigner = createOfflineLicenseSigner({ keyId: "key-2026-02", privateKey: newPair.privateKey });
    const input = {
      licenseId: LICENSE_ID,
      applicationId: APP_ID,
      appCode: "APP_A",
      deviceId: "device-1",
      licenseExpiresAt: null,
      offlineGraceSeconds: 3600,
      issuedAt: ISSUED_AT,
    };
    const oldToken = oldSigner.issue(input).token;
    const newToken = newSigner.issue(input).token;
    const keyRing = new Map([
      ["key-2026-01", oldPair.publicKey],
      ["key-2026-02", newPair.publicKey],
    ]);

    expect(verifyOfflineLicenseToken(oldToken, { publicKeys: keyRing }).header.kid).toBe("key-2026-01");
    expect(verifyOfflineLicenseToken(newToken, { publicKeys: keyRing }).header.kid).toBe("key-2026-02");
    expect(() =>
      verifyOfflineLicenseToken(oldToken, { publicKeys: { "key-2026-02": newPair.publicKey } }),
    ).toThrow(/unknown key id/);
  });

  it("does not put raw license keys or hashes in the signed payload", () => {
    const { issued } = fixture();
    const rawKey = "APP_A-AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD";
    const serialized = JSON.stringify(issued);
    expect(serialized).not.toContain(rawKey);
    expect(serialized).not.toContain("license_key_hash");
    expect(serialized).not.toContain("licenseKeyHash");
  });
});

describe("offline signing server-only configuration", () => {
  it("is disabled by default", () => {
    expect(createOfflineLicenseSignerFromEnv({})).toBeNull();
  });

  it("fails fast when enabled without a key id or private key", () => {
    expect(() => createOfflineLicenseSignerFromEnv({ OFFLINE_SIGNING_ENABLED: "true" })).toThrow(
      /OFFLINE_SIGNING_KEY_ID/,
    );
    expect(() =>
      createOfflineLicenseSignerFromEnv({
        OFFLINE_SIGNING_ENABLED: "true",
        OFFLINE_SIGNING_KEY_ID: "prod-1",
      }),
    ).toThrow(/PRIVATE_KEY/);
  });

  it("accepts a test Ed25519 private key without hard-coding production key material", () => {
    const pair = generateKeyPairSync("ed25519");
    const pem = pair.privateKey.export({ format: "pem", type: "pkcs8" });
    const signer = createOfflineLicenseSignerFromEnv({
      OFFLINE_SIGNING_ENABLED: "true",
      OFFLINE_SIGNING_KEY_ID: "test-env-1",
      OFFLINE_SIGNING_PRIVATE_KEY: String(pem).replace(/\n/g, "\\n"),
    });

    expect(signer.keyId).toBe("test-env-1");
    expect(signer.algorithm).toBe("Ed25519");
  });

  it("rejects an invalid private key instead of starting with broken signing", () => {
    expect(() =>
      createOfflineLicenseSignerFromEnv({
        OFFLINE_SIGNING_ENABLED: "true",
        OFFLINE_SIGNING_KEY_ID: "prod-1",
        OFFLINE_SIGNING_PRIVATE_KEY: "not-a-private-key",
      }),
    ).toThrow(/valid Ed25519 private key/);
  });
});
