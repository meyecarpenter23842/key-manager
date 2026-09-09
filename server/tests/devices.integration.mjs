import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import process from "node:process";

import { createAdminApiServer } from "../src/app.mjs";
import { DeviceRepository } from "../src/device-repository.mjs";
import { normalizeDeviceActivation } from "../src/devices.mjs";
import { AdminRepository, createDatabasePool } from "../src/repository.mjs";
import { isUuid } from "../src/resources.mjs";
import { hashPassword } from "../src/security.mjs";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for the devices integration test");
}

const pool = createDatabasePool(process.env.DATABASE_URL);
const repository = new AdminRepository(pool);
const deviceRepository = new DeviceRepository(pool);
const ownerPassword = randomUUID();
const staffPassword = randomUUID();
let server;

async function api(baseUrl, path, options = {}) {
  const response = await globalThis.fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function login(baseUrl, email, password) {
  const result = await api(baseUrl, "/api/admin/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  assert.equal(result.response.status, 200);
  return result.body.token;
}

async function insertLifetimeLicense(applicationId, fillByte) {
  const result = await pool.query(
    `INSERT INTO licenses (
       application_id, license_key_hash, license_key_preview, license_type, max_devices, status
     ) VALUES ($1, $2, $3, 'LIFETIME', 1, 'ACTIVE')
     RETURNING id`,
    [applicationId, Buffer.alloc(32, fillByte), `****-****-DEVICE0${fillByte}`],
  );
  return result.rows[0].id;
}

try {
  await pool.query("DELETE FROM license_events");
  await pool.query("DELETE FROM devices");
  await pool.query("DELETE FROM licenses");
  await pool.query("DELETE FROM customers");
  await pool.query("DELETE FROM applications");
  await pool.query("DELETE FROM admin_sessions");
  await pool.query("DELETE FROM audit_logs");
  await pool.query("DELETE FROM admins");

  const owner = await repository.bootstrapOwner({
    email: "owner.phase5@example.com",
    passwordHash: await hashPassword(ownerPassword),
  });
  await repository.createAdmin({
    email: "staff.phase5@example.com",
    passwordHash: await hashPassword(staffPassword),
    role: "STAFF",
    actorAdminId: owner.id,
    requestId: "phase5-create-staff",
    ipAddress: null,
  });

  const appResult = await pool.query(
    `INSERT INTO applications (name, app_code, default_device_limit)
     VALUES ('Phase 5 App', 'PHASE5_APP', 1)
     RETURNING id`,
  );
  const applicationId = appResult.rows[0].id;
  const licenseId = await insertLifetimeLicense(applicationId, 1);
  const concurrentLicenseId = await insertLifetimeLicense(applicationId, 2);

  const firstActivation = normalizeDeviceActivation(
    {
      licenseId,
      deviceId: "device-one",
      deviceName: "Workstation One",
      os: "Windows 11",
      appVersion: "5.0.0",
    },
    isUuid,
  );
  const first = await deviceRepository.activateDevice(firstActivation);
  assert.equal(first.created, true);
  assert.equal(first.device.status, "ACTIVE");
  assert.equal(first.device.deviceName, "Workstation One");
  assert.equal(first.device.os, "Windows 11");
  assert.equal(first.device.appVersion, "5.0.0");

  const sameDevice = await deviceRepository.activateDevice({
    ...firstActivation,
    deviceName: "Workstation One Renamed",
    appVersion: "5.0.1",
  });
  assert.equal(sameDevice.created, false);
  assert.equal(sameDevice.device.id, first.device.id);
  assert.equal(sameDevice.device.deviceName, "Workstation One Renamed");
  assert.equal(sameDevice.device.appVersion, "5.0.1");

  const oneActiveResult = await pool.query(
    "SELECT count(*)::int AS count FROM devices WHERE license_id = $1 AND status = 'ACTIVE'",
    [licenseId],
  );
  assert.equal(oneActiveResult.rows[0].count, 1);

  await assert.rejects(
    () =>
      deviceRepository.activateDevice({
        licenseId,
        deviceId: "device-two",
        deviceName: "Workstation Two",
        os: "Windows 11",
        appVersion: "5.0.0",
      }),
    (error) => error.errorCode === "DEVICE_LIMIT_REACHED" && error.statusCode === 409,
  );

  server = createAdminApiServer({ repository, deviceRepository, sessionTtlHours: 1 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const ownerToken = await login(baseUrl, "owner.phase5@example.com", ownerPassword);
  const staffToken = await login(baseUrl, "staff.phase5@example.com", staffPassword);

  const staffList = await api(baseUrl, `/api/admin/v1/devices?licenseId=${licenseId}`, {
    headers: { authorization: `Bearer ${staffToken}` },
  });
  assert.equal(staffList.response.status, 200);
  assert.equal(staffList.body.devices.length, 1);
  assert.equal(staffList.body.devices[0].deviceId, "device-one");

  const staffRevoke = await api(baseUrl, `/api/admin/v1/devices/${first.device.id}/revoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${staffToken}` },
  });
  assert.equal(staffRevoke.response.status, 403);
  assert.equal(staffRevoke.body.error.code, "FORBIDDEN");

  const ownerRevoke = await api(baseUrl, `/api/admin/v1/devices/${first.device.id}/revoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(ownerRevoke.response.status, 200);
  assert.equal(ownerRevoke.body.device.status, "REVOKED");
  assert.ok(ownerRevoke.body.device.revokedAt);

  const second = await deviceRepository.activateDevice({
    licenseId,
    deviceId: "device-two",
    deviceName: "Workstation Two",
    os: "Windows 11",
    appVersion: "5.0.0",
  });
  assert.equal(second.created, true);
  assert.equal(second.device.status, "ACTIVE");

  await assert.rejects(
    () => deviceRepository.activateDevice(firstActivation),
    (error) => error.errorCode === "DEVICE_REVOKED" && error.statusCode === 409,
  );

  const activeAfterRevoke = await api(
    baseUrl,
    `/api/admin/v1/devices?licenseId=${licenseId}&status=ACTIVE`,
    { headers: { authorization: `Bearer ${staffToken}` } },
  );
  assert.equal(activeAfterRevoke.response.status, 200);
  assert.equal(activeAfterRevoke.body.devices.length, 1);
  assert.equal(activeAfterRevoke.body.devices[0].deviceId, "device-two");

  const concurrent = await Promise.allSettled([
    deviceRepository.activateDevice({
      licenseId: concurrentLicenseId,
      deviceId: "concurrent-a",
      deviceName: "Concurrent A",
      os: "Windows 11",
      appVersion: "5.0.0",
    }),
    deviceRepository.activateDevice({
      licenseId: concurrentLicenseId,
      deviceId: "concurrent-b",
      deviceName: "Concurrent B",
      os: "Windows 11",
      appVersion: "5.0.0",
    }),
  ]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = concurrent.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.errorCode, "DEVICE_LIMIT_REACHED");

  const concurrentCount = await pool.query(
    "SELECT count(*)::int AS count FROM devices WHERE license_id = $1 AND status = 'ACTIVE'",
    [concurrentLicenseId],
  );
  assert.equal(concurrentCount.rows[0].count, 1);

  const eventsResult = await pool.query(
    `SELECT event_type, actor_type, count(*)::int AS count
     FROM license_events
     WHERE event_type IN ('DEVICE_ACTIVATED', 'DEVICE_REVOKED')
     GROUP BY event_type, actor_type`,
  );
  const events = new Map(
    eventsResult.rows.map((row) => [`${row.event_type}:${row.actor_type}`, row.count]),
  );
  assert.equal(events.get("DEVICE_ACTIVATED:LICENSE_API"), 3);
  assert.equal(events.get("DEVICE_REVOKED:ADMIN"), 1);

  const auditResult = await pool.query(
    `SELECT action, actor_type, count(*)::int AS count
     FROM audit_logs
     WHERE action IN ('DEVICE_ACTIVATED', 'DEVICE_REVOKED')
     GROUP BY action, actor_type`,
  );
  const audits = new Map(
    auditResult.rows.map((row) => [`${row.action}:${row.actor_type}`, row.count]),
  );
  assert.equal(audits.get("DEVICE_ACTIVATED:LICENSE_API"), 3);
  assert.equal(audits.get("DEVICE_REVOKED:ADMIN"), 1);

  process.stdout.write("[admin-api] devices integration test passed\n");
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await pool.end();
}
