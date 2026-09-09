import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import process from "node:process";

import { createAdminApiServer } from "../src/app.mjs";
import { DeviceRepository } from "../src/device-repository.mjs";
import { LicenseApiRepository } from "../src/license-api-repository.mjs";
import { PublicLicenseService } from "../src/license-service.mjs";
import { hashLicenseKey } from "../src/licenses.mjs";
import {
  createOfflineLicenseSigner,
  verifyOfflineLicenseToken,
} from "../src/offline-license.mjs";
import { AdminRepository, createDatabasePool } from "../src/repository.mjs";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for the offline license integration test");
}

const pool = createDatabasePool(process.env.DATABASE_URL);
const repository = new AdminRepository(pool);
const deviceRepository = new DeviceRepository(pool);
const licenseApiRepository = new LicenseApiRepository(pool);
const signingPair = generateKeyPairSync("ed25519");
const offlineSigner = createOfflineLicenseSigner({
  keyId: "phase7-test-key",
  privateKey: signingPair.privateKey,
});
let serverTime = new Date("2030-01-01T00:00:00.000Z");
const structuredLogs = [];
const licenseService = new PublicLicenseService({
  licenseRepository: licenseApiRepository,
  deviceRepository,
  offlineSigner,
  clock: () => new Date(serverTime.getTime()),
});
let server;

async function api(baseUrl, path, body) {
  const response = await globalThis.fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function insertApplication({ appCode, offlineGraceSeconds = 3600 }) {
  const result = await pool.query(
    `INSERT INTO applications (
       name, app_code, status, minimum_version, current_version, offline_grace_seconds,
       default_device_limit
     ) VALUES ($1, $2, 'ACTIVE', '1.0.0', '9.9.9', $3, 5)
     RETURNING id`,
    [`${appCode} Application`, appCode, offlineGraceSeconds],
  );
  return result.rows[0].id;
}

async function insertLicense({
  applicationId,
  rawKey,
  licenseType = "LIFETIME",
  expiresAt = null,
  status = "ACTIVE",
  maxDevices = 5,
}) {
  const result = await pool.query(
    `INSERT INTO licenses (
       application_id, license_key_hash, license_key_preview, license_type,
       expires_at, max_devices, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      applicationId,
      hashLicenseKey(rawKey),
      `****-****-${rawKey.slice(-8)}`,
      licenseType,
      expiresAt,
      maxDevices,
      status,
    ],
  );
  return result.rows[0].id;
}

const keys = {
  lifetime: "OFFLINE_APP-11111111-11111111-11111111-11111111",
  subscription: "OFFLINE_APP-22222222-22222222-22222222-22222222",
  expired: "OFFLINE_APP-33333333-33333333-33333333-33333333",
  revoked: "OFFLINE_APP-44444444-44444444-44444444-44444444",
  noGrace: "NO_GRACE-55555555-55555555-55555555-55555555",
};

try {
  await pool.query("DELETE FROM license_events");
  await pool.query("DELETE FROM devices");
  await pool.query("DELETE FROM licenses");
  await pool.query("DELETE FROM customers");
  await pool.query("DELETE FROM applications");
  await pool.query("DELETE FROM admin_sessions");
  await pool.query("DELETE FROM audit_logs");
  await pool.query("DELETE FROM admins");

  const adminResult = await pool.query(
    `INSERT INTO admins (email, password_hash, role)
     VALUES ('phase7-owner@example.com', 'phase7-test-password-hash', 'OWNER')
     RETURNING id`,
  );
  const ownerId = adminResult.rows[0].id;

  const appId = await insertApplication({ appCode: "OFFLINE_APP", offlineGraceSeconds: 3600 });
  const noGraceAppId = await insertApplication({ appCode: "NO_GRACE", offlineGraceSeconds: 0 });
  const lifetimeLicenseId = await insertLicense({ applicationId: appId, rawKey: keys.lifetime });
  const subscriptionLicenseId = await insertLicense({
    applicationId: appId,
    rawKey: keys.subscription,
    licenseType: "SUBSCRIPTION",
    expiresAt: "2030-01-01T00:30:00.000Z",
  });
  await insertLicense({
    applicationId: appId,
    rawKey: keys.expired,
    licenseType: "SUBSCRIPTION",
    expiresAt: "2020-01-01T00:00:00.000Z",
  });
  await insertLicense({ applicationId: appId, rawKey: keys.revoked, status: "REVOKED" });
  await insertLicense({ applicationId: noGraceAppId, rawKey: keys.noGrace });

  server = createAdminApiServer({
    repository,
    deviceRepository,
    licenseService,
    publicRateLimitMax: 1000,
    logger: (event) => structuredLogs.push(event),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const expired = await api(baseUrl, "/api/v1/license/activate", {
    appCode: "OFFLINE_APP",
    licenseKey: keys.expired,
    deviceId: "expired-device",
    appVersion: "1.0.0",
  });
  assert.equal(expired.response.status, 403);
  assert.equal(expired.body.error.code, "LICENSE_EXPIRED");
  assert.equal(Object.hasOwn(expired.body, "offline"), false);

  const revoked = await api(baseUrl, "/api/v1/license/activate", {
    appCode: "OFFLINE_APP",
    licenseKey: keys.revoked,
    deviceId: "revoked-license-device",
    appVersion: "1.0.0",
  });
  assert.equal(revoked.response.status, 403);
  assert.equal(revoked.body.error.code, "LICENSE_REVOKED");
  assert.equal(Object.hasOwn(revoked.body, "offline"), false);

  const activation = await api(baseUrl, "/api/v1/license/activate", {
    appCode: "OFFLINE_APP",
    licenseKey: keys.lifetime,
    deviceId: "device-one",
    deviceName: "Offline Workstation",
    os: "Windows 11",
    appVersion: "1.0.0",
  });
  assert.equal(activation.response.status, 200);
  assert.equal(activation.body.license.id, lifetimeLicenseId);
  assert.equal(activation.body.serverTime, "2030-01-01T00:00:00.000Z");
  assert.equal(activation.body.offline.algorithm, "Ed25519");
  assert.equal(activation.body.offline.keyId, "phase7-test-key");
  assert.equal(activation.body.offline.issuedAt, activation.body.serverTime);
  assert.equal(activation.body.offline.offlineValidUntil, "2030-01-01T01:00:00.000Z");

  const verifiedActivation = verifyOfflineLicenseToken(activation.body.offline.token, {
    publicKeys: { "phase7-test-key": signingPair.publicKey },
    expected: {
      licenseId: lifetimeLicenseId,
      applicationId: appId,
      appCode: "OFFLINE_APP",
      deviceId: "device-one",
    },
  });
  assert.equal(verifiedActivation.payload.expires_at, null);
  assert.equal(verifiedActivation.payload.offline_valid_until, "2030-01-01T01:00:00.000Z");
  assert.throws(
    () =>
      verifyOfflineLicenseToken(activation.body.offline.token, {
        publicKeys: { "phase7-test-key": signingPair.publicKey },
        expected: { appCode: "OTHER_APP" },
      }),
    /binding mismatch for appCode/,
  );
  assert.throws(
    () =>
      verifyOfflineLicenseToken(activation.body.offline.token, {
        publicKeys: { "phase7-test-key": signingPair.publicKey },
        expected: { deviceId: "device-two" },
      }),
    /binding mismatch for deviceId/,
  );

  const activationText = JSON.stringify(activation.body);
  const keyHashHex = hashLicenseKey(keys.lifetime).toString("hex");
  assert.equal(activationText.includes(keys.lifetime), false);
  assert.equal(activationText.includes(keyHashHex), false);
  assert.equal(activationText.includes("license_key_hash"), false);
  assert.equal(activationText.includes("licenseKeyHash"), false);

  serverTime = new Date("2030-01-01T00:05:00.000Z");
  const validation = await api(baseUrl, "/api/v1/license/validate", {
    appCode: "OFFLINE_APP",
    licenseKey: keys.lifetime,
    deviceId: "device-one",
    appVersion: "1.0.0",
  });
  assert.equal(validation.response.status, 200);
  assert.notEqual(validation.body.offline.token, activation.body.offline.token);
  assert.equal(validation.body.offline.issuedAt, "2030-01-01T00:05:00.000Z");
  assert.equal(validation.body.offline.offlineValidUntil, "2030-01-01T01:05:00.000Z");
  verifyOfflineLicenseToken(validation.body.offline.token, {
    publicKeys: { "phase7-test-key": signingPair.publicKey },
    expected: { appCode: "OFFLINE_APP", deviceId: "device-one" },
  });

  serverTime = new Date("2030-01-01T00:10:00.000Z");
  const heartbeat = await api(baseUrl, "/api/v1/license/heartbeat", {
    appCode: "OFFLINE_APP",
    licenseKey: keys.lifetime,
    deviceId: "device-one",
    deviceName: "Offline Workstation",
    os: "Windows 11",
    appVersion: "1.1.0",
  });
  assert.equal(heartbeat.response.status, 200);
  assert.notEqual(heartbeat.body.offline.token, validation.body.offline.token);
  assert.equal(heartbeat.body.offline.issuedAt, "2030-01-01T00:10:00.000Z");

  const subscription = await api(baseUrl, "/api/v1/license/activate", {
    appCode: "OFFLINE_APP",
    licenseKey: keys.subscription,
    deviceId: "subscription-device",
    appVersion: "1.0.0",
  });
  assert.equal(subscription.response.status, 200);
  assert.equal(subscription.body.license.id, subscriptionLicenseId);
  const verifiedSubscription = verifyOfflineLicenseToken(subscription.body.offline.token, {
    publicKeys: { "phase7-test-key": signingPair.publicKey },
  });
  assert.equal(verifiedSubscription.payload.expires_at, "2030-01-01T00:30:00.000Z");
  assert.equal(verifiedSubscription.payload.offline_valid_until, "2030-01-01T00:30:00.000Z");

  const revokedDeviceActivation = await api(baseUrl, "/api/v1/license/activate", {
    appCode: "OFFLINE_APP",
    licenseKey: keys.lifetime,
    deviceId: "device-to-revoke",
    appVersion: "1.0.0",
  });
  assert.equal(revokedDeviceActivation.response.status, 200);
  await deviceRepository.revokeDevice({
    id: revokedDeviceActivation.body.device.id,
    actorAdminId: ownerId,
    requestId: "phase7-revoke-device",
  });
  serverTime = new Date("2030-01-01T00:15:00.000Z");
  const revokedDeviceRefresh = await api(baseUrl, "/api/v1/license/heartbeat", {
    appCode: "OFFLINE_APP",
    licenseKey: keys.lifetime,
    deviceId: "device-to-revoke",
    appVersion: "1.0.0",
  });
  assert.equal(revokedDeviceRefresh.response.status, 409);
  assert.equal(revokedDeviceRefresh.body.error.code, "DEVICE_REVOKED");
  assert.equal(Object.hasOwn(revokedDeviceRefresh.body, "offline"), false);

  const deactivation = await api(baseUrl, "/api/v1/license/deactivate", {
    appCode: "OFFLINE_APP",
    licenseKey: keys.lifetime,
    deviceId: "device-one",
  });
  assert.equal(deactivation.response.status, 200);
  assert.equal(deactivation.body.status, "INACTIVE");
  assert.equal(Object.hasOwn(deactivation.body, "offline"), false);

  const noGrace = await api(baseUrl, "/api/v1/license/activate", {
    appCode: "NO_GRACE",
    licenseKey: keys.noGrace,
    deviceId: "online-only-device",
    appVersion: "1.0.0",
  });
  assert.equal(noGrace.response.status, 200);
  assert.equal(noGrace.body.application.offlineGraceSeconds, 0);
  assert.equal(Object.hasOwn(noGrace.body, "offline"), false);

  assert.ok(structuredLogs.length > 0);
  const logsText = JSON.stringify(structuredLogs);
  for (const rawKey of Object.values(keys)) assert.equal(logsText.includes(rawKey), false);
  assert.equal(logsText.includes(keyHashHex), false);
  assert.equal(logsText.includes("license_key_hash"), false);
  assert.equal(logsText.includes("licenseKeyHash"), false);

  process.stdout.write("[license-api] offline license signing integration test passed\n");
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
