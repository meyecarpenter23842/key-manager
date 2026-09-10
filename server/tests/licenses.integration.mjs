import assert from "node:assert/strict";
import process from "node:process";

import { createAdminApiServer } from "../src/app.mjs";
import { hashLicenseKey } from "../src/licenses.mjs";
import { AdminRepository, createDatabasePool } from "../src/repository.mjs";
import { hashPassword } from "../src/security.mjs";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for the licenses integration test");
}

const pool = createDatabasePool(process.env.DATABASE_URL);
const repository = new AdminRepository(pool);
const ownerPassword = "Owner-Phase4-Password-42";
const staffPassword = "Staff-Phase4-Password-42";
const licenseKeyEncryptionKey = "11".repeat(32);
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

function assertNoKeyMaterial(payload) {
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes("license_key_hash"), false);
  assert.equal(serialized.includes("licenseKeyHash"), false);
  assert.equal(serialized.includes("license_key_ciphertext"), false);
  assert.equal(serialized.includes("licenseKeyCiphertext"), false);
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

  await repository.bootstrapOwner({
    email: "owner.phase4@example.com",
    passwordHash: await hashPassword(ownerPassword),
  });

  server = createAdminApiServer({
    repository,
    sessionTtlHours: 1,
    licenseKeyEncryptionKey,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const ownerToken = await login(baseUrl, "owner.phase4@example.com", ownerPassword);
  const ownerHeaders = { authorization: `Bearer ${ownerToken}` };

  const createStaff = await api(baseUrl, "/api/admin/v1/admins", {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      email: "staff.phase4@example.com",
      password: staffPassword,
      role: "STAFF",
    }),
  });
  assert.equal(createStaff.response.status, 201);
  const staffToken = await login(baseUrl, "staff.phase4@example.com", staffPassword);
  const staffHeaders = { authorization: `Bearer ${staffToken}` };

  const createApplication = await api(baseUrl, "/api/admin/v1/applications", {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      name: "Phase 4 Desktop",
      appCode: "PHASE4_APP",
      defaultDeviceLimit: 2,
      defaultDurationDays: 10,
      allowLifetime: true,
    }),
  });
  assert.equal(createApplication.response.status, 201);
  const applicationId = createApplication.body.application.id;

  const createNoLifetimeApplication = await api(baseUrl, "/api/admin/v1/applications", {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      name: "Subscription Only",
      appCode: "SUB_ONLY",
      allowLifetime: false,
    }),
  });
  assert.equal(createNoLifetimeApplication.response.status, 201);

  const createDisabledApplication = await api(baseUrl, "/api/admin/v1/applications", {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      name: "Disabled App",
      appCode: "DISABLED_APP",
      status: "DISABLED",
    }),
  });
  assert.equal(createDisabledApplication.response.status, 201);

  const createCustomer = await api(baseUrl, "/api/admin/v1/customers", {
    method: "POST",
    headers: staffHeaders,
    body: JSON.stringify({
      name: "License Customer",
      phone: "+84 900 111 222",
      email: "license.customer@example.com",
      company: "Phase Four Co",
    }),
  });
  assert.equal(createCustomer.response.status, 201);
  const customerId = createCustomer.body.customer.id;

  const unauthenticated = await api(baseUrl, "/api/admin/v1/licenses");
  assert.equal(unauthenticated.response.status, 401);

  const createSubscription = await api(baseUrl, "/api/admin/v1/licenses", {
    method: "POST",
    headers: staffHeaders,
    body: JSON.stringify({
      applicationId,
      customerId,
      licenseType: "SUBSCRIPTION",
      durationDays: 5,
      note: "Phase 4 subscription",
    }),
  });
  assert.equal(createSubscription.response.status, 201);
  assert.match(createSubscription.body.licenseKey, /^PHASE4_APP(?:-[0-9A-F]{8}){4}$/);
  assert.equal(createSubscription.body.license.licenseType, "SUBSCRIPTION");
  assert.equal(createSubscription.body.license.maxDevices, 2);
  assert.equal(createSubscription.body.license.status, "ACTIVE");
  assertNoKeyMaterial(createSubscription.body);
  const subscriptionId = createSubscription.body.license.id;
  const rawSubscriptionKey = createSubscription.body.licenseKey;
  const initialExpiry = new Date(createSubscription.body.license.expiresAt);

  const storedKey = await pool.query(
    `SELECT license_key_hash, license_key_preview, license_key_ciphertext
     FROM licenses
     WHERE id = $1`,
    [subscriptionId],
  );
  assert.equal(storedKey.rows[0].license_key_hash.equals(hashLicenseKey(rawSubscriptionKey)), true);
  assert.notEqual(storedKey.rows[0].license_key_preview, rawSubscriptionKey);
  assert.equal(storedKey.rows[0].license_key_preview.includes(rawSubscriptionKey), false);
  assert.match(storedKey.rows[0].license_key_ciphertext, /^v1\./);
  assert.equal(storedKey.rows[0].license_key_ciphertext.includes(rawSubscriptionKey), false);

  const rawKeySearch = await api(
    baseUrl,
    `/api/admin/v1/licenses?q=${encodeURIComponent(rawSubscriptionKey)}`,
    { headers: staffHeaders },
  );
  assert.equal(rawKeySearch.response.status, 200);
  assert.equal(rawKeySearch.body.pagination.total, 1);
  assert.equal(rawKeySearch.body.licenses[0].id, subscriptionId);
  assertNoKeyMaterial(rawKeySearch.body);

  for (const query of ["License Customer", "900 111", "phase four", "PHASE4_APP"]) {
    const search = await api(
      baseUrl,
      `/api/admin/v1/licenses?q=${encodeURIComponent(query)}&applicationId=${applicationId}`,
      { headers: staffHeaders },
    );
    assert.equal(search.response.status, 200);
    assert.equal(search.body.pagination.total, 1);
  }

  const filtered = await api(
    baseUrl,
    `/api/admin/v1/licenses?applicationId=${applicationId}&customerId=${customerId}&licenseType=SUBSCRIPTION&status=ACTIVE&expiringWithinDays=10`,
    { headers: staffHeaders },
  );
  assert.equal(filtered.response.status, 200);
  assert.equal(filtered.body.pagination.total, 1);

  const detail = await api(baseUrl, `/api/admin/v1/licenses/${subscriptionId}`, {
    headers: staffHeaders,
  });
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.license.application.id, applicationId);
  assert.equal(detail.body.license.customer.id, customerId);
  assert.equal(detail.body.license.events[0].eventType, "LICENSE_CREATED");
  assert.equal(detail.body.license.keyRevealAvailable, true);
  assert.equal("licenseKey" in detail.body.license, false);
  assertNoKeyMaterial(detail.body);
  assert.equal(JSON.stringify(detail.body).includes(rawSubscriptionKey), false);

  const staffCannotReveal = await api(
    baseUrl,
    `/api/admin/v1/licenses/${subscriptionId}/reveal-key`,
    { method: "POST", headers: staffHeaders },
  );
  assert.equal(staffCannotReveal.response.status, 403);
  assert.equal(staffCannotReveal.body.error.code, "FORBIDDEN");

  const reveal = await api(baseUrl, `/api/admin/v1/licenses/${subscriptionId}/reveal-key`, {
    method: "POST",
    headers: ownerHeaders,
  });
  assert.equal(reveal.response.status, 200);
  assert.equal(reveal.body.licenseKey, rawSubscriptionKey);
  assertNoKeyMaterial(reveal.body);

  const revealAudit = await pool.query(
    `SELECT action, metadata
     FROM audit_logs
     WHERE target_type = 'LICENSE' AND target_id = $1 AND action = 'LICENSE_KEY_REVEALED'`,
    [subscriptionId],
  );
  assert.equal(revealAudit.rowCount, 1);
  assert.equal(JSON.stringify(revealAudit.rows[0]).includes(rawSubscriptionKey), false);

  const createLifetime = await api(baseUrl, "/api/admin/v1/licenses", {
    method: "POST",
    headers: staffHeaders,
    body: JSON.stringify({ applicationId, licenseType: "LIFETIME", maxDevices: 1 }),
  });
  assert.equal(createLifetime.response.status, 201);
  assert.equal(createLifetime.body.license.expiresAt, null);
  assert.equal(createLifetime.body.license.status, "ACTIVE");
  const lifetimeId = createLifetime.body.license.id;

  await pool.query("UPDATE licenses SET license_key_ciphertext = NULL WHERE id = $1", [lifetimeId]);
  const legacyDetail = await api(baseUrl, `/api/admin/v1/licenses/${lifetimeId}`, {
    headers: ownerHeaders,
  });
  assert.equal(legacyDetail.response.status, 200);
  assert.equal(legacyDetail.body.license.keyRevealAvailable, false);
  assertNoKeyMaterial(legacyDetail.body);

  const legacyReveal = await api(baseUrl, `/api/admin/v1/licenses/${lifetimeId}/reveal-key`, {
    method: "POST",
    headers: ownerHeaders,
  });
  assert.equal(legacyReveal.response.status, 409);
  assert.equal(legacyReveal.body.error.code, "LICENSE_KEY_UNAVAILABLE");

  const lifetimeFilter = await api(baseUrl, "/api/admin/v1/licenses?licenseType=LIFETIME", {
    headers: ownerHeaders,
  });
  assert.equal(lifetimeFilter.response.status, 200);
  assert.equal(lifetimeFilter.body.licenses.some((license) => license.id === lifetimeId), true);

  const lifetimeDenied = await api(baseUrl, "/api/admin/v1/licenses", {
    method: "POST",
    headers: staffHeaders,
    body: JSON.stringify({
      applicationId: createNoLifetimeApplication.body.application.id,
      licenseType: "LIFETIME",
    }),
  });
  assert.equal(lifetimeDenied.response.status, 409);
  assert.equal(lifetimeDenied.body.error.code, "LIFETIME_NOT_ALLOWED");

  const disabledDenied = await api(baseUrl, "/api/admin/v1/licenses", {
    method: "POST",
    headers: staffHeaders,
    body: JSON.stringify({
      applicationId: createDisabledApplication.body.application.id,
      licenseType: "SUBSCRIPTION",
    }),
  });
  assert.equal(disabledDenied.response.status, 409);
  assert.equal(disabledDenied.body.error.code, "APPLICATION_DISABLED");

  const activeRenew = await api(baseUrl, `/api/admin/v1/licenses/${subscriptionId}/renew`, {
    method: "POST",
    headers: staffHeaders,
    body: JSON.stringify({ durationDays: 3 }),
  });
  assert.equal(activeRenew.response.status, 200);
  const activeRenewExpiry = new Date(activeRenew.body.license.expiresAt);
  assert.ok(Math.abs(activeRenewExpiry - initialExpiry - 3 * 86400000) < 1500);

  await pool.query(
    "UPDATE licenses SET expires_at = now() - interval '1 day', status = 'ACTIVE' WHERE id = $1",
    [subscriptionId],
  );
  const expiredFilter = await api(baseUrl, "/api/admin/v1/licenses?status=EXPIRED", {
    headers: staffHeaders,
  });
  assert.equal(expiredFilter.response.status, 200);
  assert.equal(expiredFilter.body.licenses.some((license) => license.id === subscriptionId), true);

  const renewExpiredStartedAt = Date.now();
  const expiredRenew = await api(baseUrl, `/api/admin/v1/licenses/${subscriptionId}/renew`, {
    method: "POST",
    headers: staffHeaders,
    body: JSON.stringify({ durationDays: 2 }),
  });
  assert.equal(expiredRenew.response.status, 200);
  assert.equal(expiredRenew.body.license.status, "ACTIVE");
  const expiredRenewExpiry = new Date(expiredRenew.body.license.expiresAt).getTime();
  assert.ok(expiredRenewExpiry >= renewExpiredStartedAt + 2 * 86400000 - 1500);
  assert.ok(expiredRenewExpiry <= Date.now() + 2 * 86400000 + 1500);

  await pool.query(
    `INSERT INTO devices (license_id, device_id, device_name, os, app_version)
     VALUES
       ($1, 'phase4-device-1', 'PC 1', 'Windows 11', '1.0.0'),
       ($1, 'phase4-device-2', 'PC 2', 'Windows 11', '1.0.0')`,
    [subscriptionId],
  );

  const staffCannotChangeLimit = await api(
    baseUrl,
    `/api/admin/v1/licenses/${subscriptionId}/device-limit`,
    {
      method: "PATCH",
      headers: staffHeaders,
      body: JSON.stringify({ maxDevices: 3 }),
    },
  );
  assert.equal(staffCannotChangeLimit.response.status, 403);

  const belowActiveCount = await api(
    baseUrl,
    `/api/admin/v1/licenses/${subscriptionId}/device-limit`,
    {
      method: "PATCH",
      headers: ownerHeaders,
      body: JSON.stringify({ maxDevices: 1 }),
    },
  );
  assert.equal(belowActiveCount.response.status, 409);
  assert.equal(belowActiveCount.body.error.code, "DEVICE_LIMIT_BELOW_ACTIVE_COUNT");

  const changeDeviceLimit = await api(
    baseUrl,
    `/api/admin/v1/licenses/${subscriptionId}/device-limit`,
    {
      method: "PATCH",
      headers: ownerHeaders,
      body: JSON.stringify({ maxDevices: 3 }),
    },
  );
  assert.equal(changeDeviceLimit.response.status, 200);
  assert.equal(changeDeviceLimit.body.license.maxDevices, 3);

  const staffCannotRevoke = await api(baseUrl, `/api/admin/v1/licenses/${subscriptionId}/revoke`, {
    method: "POST",
    headers: staffHeaders,
  });
  assert.equal(staffCannotRevoke.response.status, 403);

  const revoke = await api(baseUrl, `/api/admin/v1/licenses/${subscriptionId}/revoke`, {
    method: "POST",
    headers: ownerHeaders,
  });
  assert.equal(revoke.response.status, 200);
  assert.equal(revoke.body.license.status, "REVOKED");

  const renewRevoked = await api(baseUrl, `/api/admin/v1/licenses/${subscriptionId}/renew`, {
    method: "POST",
    headers: staffHeaders,
    body: JSON.stringify({ durationDays: 1 }),
  });
  assert.equal(renewRevoked.response.status, 200);
  assert.equal(renewRevoked.body.license.status, "REVOKED");

  const reactivate = await api(baseUrl, `/api/admin/v1/licenses/${subscriptionId}/reactivate`, {
    method: "POST",
    headers: ownerHeaders,
  });
  assert.equal(reactivate.response.status, 200);
  assert.equal(reactivate.body.license.status, "ACTIVE");

  const convertible = await api(baseUrl, "/api/admin/v1/licenses", {
    method: "POST",
    headers: staffHeaders,
    body: JSON.stringify({ applicationId, licenseType: "SUBSCRIPTION", durationDays: 7 }),
  });
  assert.equal(convertible.response.status, 201);
  const convertLifetime = await api(
    baseUrl,
    `/api/admin/v1/licenses/${convertible.body.license.id}/renew`,
    {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({ toLifetime: true }),
    },
  );
  assert.equal(convertLifetime.response.status, 200);
  assert.equal(convertLifetime.body.license.licenseType, "LIFETIME");
  assert.equal(convertLifetime.body.license.expiresAt, null);

  const archive = await api(baseUrl, `/api/admin/v1/licenses/${subscriptionId}/archive`, {
    method: "POST",
    headers: ownerHeaders,
  });
  assert.equal(archive.response.status, 200);
  assert.equal(archive.body.license.status, "ARCHIVED");

  const renewArchived = await api(baseUrl, `/api/admin/v1/licenses/${subscriptionId}/renew`, {
    method: "POST",
    headers: staffHeaders,
    body: JSON.stringify({ durationDays: 1 }),
  });
  assert.equal(renewArchived.response.status, 409);
  assert.equal(renewArchived.body.error.code, "LICENSE_ARCHIVED");

  const archivedDetail = await api(baseUrl, `/api/admin/v1/licenses/${subscriptionId}`, {
    headers: ownerHeaders,
  });
  assert.equal(archivedDetail.response.status, 200);
  assert.equal(archivedDetail.body.license.keyRevealAvailable, true);
  assert.equal("licenseKey" in archivedDetail.body.license, false);
  assertNoKeyMaterial(archivedDetail.body);
  const eventTypes = archivedDetail.body.license.events.map((event) => event.eventType);
  for (const eventType of [
    "LICENSE_CREATED",
    "LICENSE_RENEWED",
    "DEVICE_LIMIT_CHANGED",
    "LICENSE_REVOKED",
    "LICENSE_REACTIVATED",
    "LICENSE_ARCHIVED",
  ]) {
    assert.equal(eventTypes.includes(eventType), true, `missing ${eventType}`);
  }

  const auditResult = await pool.query(
    `SELECT action, count(*)::int AS count
     FROM audit_logs
     WHERE target_type = 'LICENSE'
     GROUP BY action`,
  );
  const auditActions = new Map(auditResult.rows.map((row) => [row.action, row.count]));
  for (const action of [
    "LICENSE_CREATED",
    "LICENSE_KEY_REVEALED",
    "LICENSE_RENEWED",
    "LICENSE_REVOKED",
    "LICENSE_REACTIVATED",
    "LICENSE_ARCHIVED",
    "DEVICE_LIMIT_CHANGED",
    "LICENSE_CHANGED_TO_LIFETIME",
  ]) {
    assert.ok((auditActions.get(action) ?? 0) >= 1, `missing audit action ${action}`);
  }

  const rawLeak = await pool.query(
    `SELECT count(*)::int AS count
     FROM licenses
     WHERE license_key_preview = $1`,
    [rawSubscriptionKey],
  );
  assert.equal(rawLeak.rows[0].count, 0);

  process.stdout.write("[admin-api] licenses integration test passed\n");
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
