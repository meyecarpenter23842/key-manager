import assert from "node:assert/strict";
import process from "node:process";

import { createAdminApiServer } from "../src/app.mjs";
import { DeviceRepository } from "../src/device-repository.mjs";
import { hashLicenseKey } from "../src/licenses.mjs";
import { AdminRepository, createDatabasePool } from "../src/repository.mjs";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for the public license integration test");
}

const pool = createDatabasePool(process.env.DATABASE_URL);
const repository = new AdminRepository(pool);
const deviceRepository = new DeviceRepository(pool);
const structuredLogs = [];
let server;
let rateServer;

async function api(baseUrl, path, body, headers = {}) {
  const response = await globalThis.fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function insertApplication({ appCode, status = "ACTIVE", minimumVersion = null }) {
  const result = await pool.query(
    `INSERT INTO applications (
       name, app_code, status, minimum_version, current_version, offline_grace_seconds,
       default_device_limit
     ) VALUES ($1, $2, $3, $4, '9.9.9', 3600, 1)
     RETURNING id`,
    [`${appCode} Application`, appCode, status, minimumVersion],
  );
  return result.rows[0].id;
}

async function insertLicense({
  applicationId,
  rawKey,
  licenseType = "LIFETIME",
  expiresAt = null,
  status = "ACTIVE",
  maxDevices = 1,
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
  valid: "PUBLIC_APP-11111111-11111111-11111111-11111111",
  wrongApp: "OTHER_APP-22222222-22222222-22222222-22222222",
  expired: "PUBLIC_APP-33333333-33333333-33333333-33333333",
  revoked: "PUBLIC_APP-44444444-44444444-44444444-44444444",
  disabled: "DISABLED_APP-55555555-55555555-55555555-55555555",
  archived: "PUBLIC_APP-66666666-66666666-66666666-66666666",
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
     VALUES ('phase6-owner@example.com', 'phase6-test-password-hash', 'OWNER')
     RETURNING id`,
  );
  const ownerId = adminResult.rows[0].id;

  const publicAppId = await insertApplication({ appCode: "PUBLIC_APP", minimumVersion: "2.0.0" });
  const otherAppId = await insertApplication({ appCode: "OTHER_APP", minimumVersion: "1.0.0" });
  const disabledAppId = await insertApplication({ appCode: "DISABLED_APP", status: "DISABLED" });

  const validLicenseId = await insertLicense({ applicationId: publicAppId, rawKey: keys.valid });
  await insertLicense({ applicationId: otherAppId, rawKey: keys.wrongApp });
  await insertLicense({
    applicationId: publicAppId,
    rawKey: keys.expired,
    licenseType: "SUBSCRIPTION",
    expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
  });
  await insertLicense({ applicationId: publicAppId, rawKey: keys.revoked, status: "REVOKED" });
  await insertLicense({ applicationId: disabledAppId, rawKey: keys.disabled });
  await insertLicense({ applicationId: publicAppId, rawKey: keys.archived, status: "ARCHIVED" });

  server = createAdminApiServer({
    repository,
    deviceRepository,
    publicRateLimitMax: 1000,
    logger: (event) => structuredLogs.push(event),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const invalidPayload = await api(baseUrl, "/api/v1/license/activate", {
    appCode: "PUBLIC_APP",
  });
  assert.equal(invalidPayload.response.status, 400);
  assert.equal(invalidPayload.body.error.code, "INVALID_REQUEST");
  assert.ok(invalidPayload.body.requestId);

  const invalidKey = await api(baseUrl, "/api/v1/license/activate", {
    appCode: "PUBLIC_APP",
    licenseKey: "PUBLIC_APP-FFFFFFFF-FFFFFFFF-FFFFFFFF-FFFFFFFF",
    deviceId: "missing-key-device",
    appVersion: "2.0.0",
  });
  assert.equal(invalidKey.response.status, 404);
  assert.equal(invalidKey.body.error.code, "INVALID_LICENSE");

  const wrongApplication = await api(baseUrl, "/api/v1/license/activate", {
    appCode: "PUBLIC_APP",
    licenseKey: keys.wrongApp,
    deviceId: "wrong-app-device",
    appVersion: "2.0.0",
  });
  assert.equal(wrongApplication.response.status, 403);
  assert.equal(wrongApplication.body.error.code, "WRONG_APPLICATION");

  const unknownApplication = await api(baseUrl, "/api/v1/license/activate", {
    appCode: "UNKNOWN_APP",
    licenseKey: keys.valid,
    deviceId: "unknown-app-device",
    appVersion: "2.0.0",
  });
  assert.equal(unknownApplication.response.status, 403);
  assert.equal(unknownApplication.body.error.code, "WRONG_APPLICATION");

  const disabledApplication = await api(baseUrl, "/api/v1/license/activate", {
    appCode: "DISABLED_APP",
    licenseKey: keys.disabled,
    deviceId: "disabled-app-device",
    appVersion: "2.0.0",
  });
  assert.equal(disabledApplication.response.status, 403);
  assert.equal(disabledApplication.body.error.code, "APPLICATION_DISABLED");

  const expiredLicense = await api(baseUrl, "/api/v1/license/activate", {
    appCode: "PUBLIC_APP",
    licenseKey: keys.expired,
    deviceId: "expired-device",
    appVersion: "2.0.0",
  });
  assert.equal(expiredLicense.response.status, 403);
  assert.equal(expiredLicense.body.error.code, "LICENSE_EXPIRED");

  const revokedLicense = await api(baseUrl, "/api/v1/license/activate", {
    appCode: "PUBLIC_APP",
    licenseKey: keys.revoked,
    deviceId: "revoked-license-device",
    appVersion: "2.0.0",
  });
  assert.equal(revokedLicense.response.status, 403);
  assert.equal(revokedLicense.body.error.code, "LICENSE_REVOKED");

  const archivedLicense = await api(baseUrl, "/api/v1/license/activate", {
    appCode: "PUBLIC_APP",
    licenseKey: keys.archived,
    deviceId: "archived-device",
    appVersion: "2.0.0",
  });
  assert.equal(archivedLicense.response.status, 404);
  assert.equal(archivedLicense.body.error.code, "INVALID_LICENSE");

  const updateRequired = await api(baseUrl, "/api/v1/license/activate", {
    appCode: "PUBLIC_APP",
    licenseKey: keys.valid,
    deviceId: "old-client-device",
    appVersion: "1.9.9",
  });
  assert.equal(updateRequired.response.status, 426);
  assert.equal(updateRequired.body.error.code, "UPDATE_REQUIRED");

  const requestId = "phase6-activate-request";
  const activation = await api(
    baseUrl,
    "/api/v1/license/activate",
    {
      appCode: "public_app",
      licenseKey: keys.valid.toLowerCase(),
      deviceId: "device-one",
      deviceName: "Main Workstation",
      os: "Windows 11",
      appVersion: "2.0.0",
    },
    { "x-request-id": requestId },
  );
  assert.equal(activation.response.status, 200);
  assert.equal(activation.response.headers.get("x-request-id"), requestId);
  assert.equal(activation.body.requestId, requestId);
  assert.equal(activation.body.status, "ACTIVE");
  assert.equal(activation.body.application.appCode, "PUBLIC_APP");
  assert.equal(activation.body.application.minimumVersion, "2.0.0");
  assert.equal(activation.body.application.offlineGraceSeconds, 3600);
  assert.equal(activation.body.license.id, validLicenseId);
  assert.equal(activation.body.license.type, "LIFETIME");
  assert.equal(activation.body.license.expiresAt, null);
  assert.equal(activation.body.device.deviceId, "device-one");
  assert.equal(activation.body.device.status, "ACTIVE");
  assert.ok(activation.body.serverTime);
  const activationText = JSON.stringify(activation.body);
  assert.equal(activationText.includes(keys.valid), false);
  assert.equal(activationText.includes("license_key_hash"), false);
  assert.equal(activationText.includes("licenseKeyHash"), false);

  const duplicateActivation = await api(baseUrl, "/api/v1/license/activate", {
    appCode: "PUBLIC_APP",
    licenseKey: keys.valid,
    deviceId: "device-one",
    deviceName: "Main Workstation Renamed",
    os: "Windows 11",
    appVersion: "2.1.0",
  });
  assert.equal(duplicateActivation.response.status, 200);
  assert.equal(duplicateActivation.body.device.id, activation.body.device.id);

  const activeCount = await pool.query(
    "SELECT count(*)::int AS count FROM devices WHERE license_id = $1 AND status = 'ACTIVE'",
    [validLicenseId],
  );
  assert.equal(activeCount.rows[0].count, 1);

  const deviceLimit = await api(baseUrl, "/api/v1/license/activate", {
    appCode: "PUBLIC_APP",
    licenseKey: keys.valid,
    deviceId: "device-two",
    appVersion: "2.0.0",
  });
  assert.equal(deviceLimit.response.status, 409);
  assert.equal(deviceLimit.body.error.code, "DEVICE_LIMIT_REACHED");

  const validation = await api(baseUrl, "/api/v1/license/validate", {
    appCode: "PUBLIC_APP",
    licenseKey: keys.valid,
    deviceId: "device-one",
    appVersion: "2.1.0",
  });
  assert.equal(validation.response.status, 200);
  assert.equal(validation.body.status, "ACTIVE");

  const heartbeat = await api(baseUrl, "/api/v1/license/heartbeat", {
    appCode: "PUBLIC_APP",
    licenseKey: keys.valid,
    deviceId: "device-one",
    deviceName: "Heartbeat Workstation",
    os: "Windows 11 Pro",
    appVersion: "2.2.0",
  });
  assert.equal(heartbeat.response.status, 200);
  assert.equal(heartbeat.body.status, "ACTIVE");
  const heartbeatRow = await pool.query(
    `SELECT device_name, os, app_version
     FROM devices
     WHERE license_id = $1 AND device_id = 'device-one'`,
    [validLicenseId],
  );
  assert.equal(heartbeatRow.rows[0].device_name, "Heartbeat Workstation");
  assert.equal(heartbeatRow.rows[0].os, "Windows 11 Pro");
  assert.equal(heartbeatRow.rows[0].app_version, "2.2.0");

  const deactivation = await api(baseUrl, "/api/v1/license/deactivate", {
    appCode: "PUBLIC_APP",
    licenseKey: keys.valid,
    deviceId: "device-one",
  });
  assert.equal(deactivation.response.status, 200);
  assert.equal(deactivation.body.status, "INACTIVE");
  assert.equal(deactivation.body.device.status, "INACTIVE");

  const validateInactive = await api(baseUrl, "/api/v1/license/validate", {
    appCode: "PUBLIC_APP",
    licenseKey: keys.valid,
    deviceId: "device-one",
    appVersion: "2.2.0",
  });
  assert.equal(validateInactive.response.status, 404);
  assert.equal(validateInactive.body.error.code, "INVALID_LICENSE");

  const secondActivation = await api(baseUrl, "/api/v1/license/activate", {
    appCode: "PUBLIC_APP",
    licenseKey: keys.valid,
    deviceId: "device-two",
    deviceName: "Second Workstation",
    os: "Windows 11",
    appVersion: "2.2.0",
  });
  assert.equal(secondActivation.response.status, 200);
  assert.equal(secondActivation.body.device.status, "ACTIVE");

  const inactiveBlockedByLimit = await api(baseUrl, "/api/v1/license/activate", {
    appCode: "PUBLIC_APP",
    licenseKey: keys.valid,
    deviceId: "device-one",
    appVersion: "2.2.0",
  });
  assert.equal(inactiveBlockedByLimit.response.status, 409);
  assert.equal(inactiveBlockedByLimit.body.error.code, "DEVICE_LIMIT_REACHED");

  await deviceRepository.revokeDevice({
    id: secondActivation.body.device.id,
    actorAdminId: ownerId,
    requestId: "phase6-admin-revoke",
  });

  const revokedDevice = await api(baseUrl, "/api/v1/license/heartbeat", {
    appCode: "PUBLIC_APP",
    licenseKey: keys.valid,
    deviceId: "device-two",
    appVersion: "2.2.0",
  });
  assert.equal(revokedDevice.response.status, 403);
  assert.equal(revokedDevice.body.error.code, "DEVICE_REVOKED");

  const reactivateInactive = await api(baseUrl, "/api/v1/license/activate", {
    appCode: "PUBLIC_APP",
    licenseKey: keys.valid,
    deviceId: "device-one",
    deviceName: "Reactivated Workstation",
    os: "Windows 11",
    appVersion: "2.2.0",
  });
  assert.equal(reactivateInactive.response.status, 200);
  assert.equal(reactivateInactive.body.device.id, activation.body.device.id);
  assert.equal(reactivateInactive.body.device.status, "ACTIVE");

  const revokedCannotReactivate = await api(baseUrl, "/api/v1/license/activate", {
    appCode: "PUBLIC_APP",
    licenseKey: keys.valid,
    deviceId: "device-two",
    appVersion: "2.2.0",
  });
  assert.equal(revokedCannotReactivate.response.status, 403);
  assert.equal(revokedCannotReactivate.body.error.code, "DEVICE_REVOKED");

  const deactivationEvents = await pool.query(
    `SELECT count(*)::int AS count
     FROM license_events
     WHERE license_id = $1 AND event_type = 'DEVICE_DEACTIVATED' AND actor_type = 'LICENSE_API'`,
    [validLicenseId],
  );
  assert.equal(deactivationEvents.rows[0].count, 1);

  const deactivationAudits = await pool.query(
    `SELECT count(*)::int AS count
     FROM audit_logs
     WHERE action = 'DEVICE_DEACTIVATED' AND actor_type = 'LICENSE_API'`,
  );
  assert.equal(deactivationAudits.rows[0].count, 1);

  assert.ok(structuredLogs.length > 0);
  const activateLog = structuredLogs.find((entry) => entry.requestId === requestId);
  assert.equal(activateLog.path, "/api/v1/license/activate");
  assert.equal(activateLog.statusCode, 200);
  assert.equal(JSON.stringify(structuredLogs).includes(keys.valid), false);
  assert.equal(JSON.stringify(structuredLogs).includes(keys.valid.toLowerCase()), false);

  await new Promise((resolve) => server.close(resolve));
  server = null;

  rateServer = createAdminApiServer({
    repository,
    deviceRepository,
    publicRateLimitMax: 2,
    publicRateLimitWindowMs: 60_000,
  });
  await new Promise((resolve) => rateServer.listen(0, "127.0.0.1", resolve));
  const rateBaseUrl = `http://127.0.0.1:${rateServer.address().port}`;
  const ratePayload = {
    appCode: "PUBLIC_APP",
    licenseKey: keys.valid,
    deviceId: "device-one",
    appVersion: "2.2.0",
  };
  const rateOne = await api(rateBaseUrl, "/api/v1/license/validate", ratePayload);
  const rateTwo = await api(rateBaseUrl, "/api/v1/license/validate", ratePayload);
  const rateThree = await api(rateBaseUrl, "/api/v1/license/validate", ratePayload);
  assert.equal(rateOne.response.status, 200);
  assert.equal(rateTwo.response.status, 200);
  assert.equal(rateThree.response.status, 429);
  assert.equal(rateThree.body.error.code, "RATE_LIMITED");
  assert.ok(Number(rateThree.response.headers.get("retry-after")) >= 1);
  assert.equal(rateThree.response.headers.get("x-ratelimit-limit"), "2");

  process.stdout.write("[license-api] public license integration test passed\n");
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (rateServer) await new Promise((resolve) => rateServer.close(resolve));
  await pool.end();
}
