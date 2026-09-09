import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import process from "node:process";

import { createAdminApiServer } from "../src/app.mjs";
import { AdminRepository, createDatabasePool } from "../src/repository.mjs";
import { hashPassword } from "../src/security.mjs";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for the applications/customers integration test");
}

const pool = createDatabasePool(process.env.DATABASE_URL);
const repository = new AdminRepository(pool);
const ownerPassword = "Owner-Phase3-Password-42";
const staffPassword = "Staff-Phase3-Password-42";
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
    email: "owner.phase3@example.com",
    passwordHash: await hashPassword(ownerPassword),
  });

  server = createAdminApiServer({ repository, sessionTtlHours: 1 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const ownerToken = await login(baseUrl, "owner.phase3@example.com", ownerPassword);
  const ownerHeaders = { authorization: `Bearer ${ownerToken}` };

  const createStaff = await api(baseUrl, "/api/admin/v1/admins", {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      email: "staff.phase3@example.com",
      password: staffPassword,
      role: "STAFF",
    }),
  });
  assert.equal(createStaff.response.status, 201);
  const staffToken = await login(baseUrl, "staff.phase3@example.com", staffPassword);
  const staffHeaders = { authorization: `Bearer ${staffToken}` };

  const unauthenticated = await api(baseUrl, "/api/admin/v1/applications");
  assert.equal(unauthenticated.response.status, 401);

  const staffCannotCreateApplication = await api(baseUrl, "/api/admin/v1/applications", {
    method: "POST",
    headers: staffHeaders,
    body: JSON.stringify({ name: "Denied", appCode: "DENIED_APP" }),
  });
  assert.equal(staffCannotCreateApplication.response.status, 403);

  const createApplication = await api(baseUrl, "/api/admin/v1/applications", {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      name: "Desktop Pro",
      appCode: "desktop-pro",
      description: "Primary desktop application",
      currentVersion: "2.5.0",
      minimumVersion: "2.0.0",
      offlineGraceSeconds: 172800,
      defaultDeviceLimit: 2,
      defaultDurationDays: 45,
      allowLifetime: false,
    }),
  });
  assert.equal(createApplication.response.status, 201);
  assert.equal(createApplication.body.application.appCode, "DESKTOP-PRO");
  assert.equal(createApplication.body.application.defaultDeviceLimit, 2);
  const applicationId = createApplication.body.application.id;

  const duplicateApplication = await api(baseUrl, "/api/admin/v1/applications", {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({ name: "Duplicate", appCode: "desktop-pro" }),
  });
  assert.equal(duplicateApplication.response.status, 409);
  assert.equal(duplicateApplication.body.error.code, "CONFLICT");

  const invalidApplication = await api(baseUrl, "/api/admin/v1/applications", {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({ name: "Bad", appCode: "?", extra: true }),
  });
  assert.equal(invalidApplication.response.status, 400);

  const staffCanReadApplications = await api(
    baseUrl,
    "/api/admin/v1/applications?q=desktop&limit=10&offset=0",
    { headers: staffHeaders },
  );
  assert.equal(staffCanReadApplications.response.status, 200);
  assert.equal(staffCanReadApplications.body.pagination.total, 1);
  assert.equal(staffCanReadApplications.body.applications[0].id, applicationId);

  const updateApplication = await api(baseUrl, `/api/admin/v1/applications/${applicationId}`, {
    method: "PATCH",
    headers: ownerHeaders,
    body: JSON.stringify({
      status: "DISABLED",
      minimumVersion: "2.4.0",
      offlineGraceSeconds: 3600,
      allowLifetime: true,
    }),
  });
  assert.equal(updateApplication.response.status, 200);
  assert.equal(updateApplication.body.application.status, "DISABLED");
  assert.equal(updateApplication.body.application.minimumVersion, "2.4.0");

  const disabledApplications = await api(
    baseUrl,
    "/api/admin/v1/applications?status=DISABLED&q=pro",
    { headers: ownerHeaders },
  );
  assert.equal(disabledApplications.response.status, 200);
  assert.equal(disabledApplications.body.pagination.total, 1);

  const createCustomer = await api(baseUrl, "/api/admin/v1/customers", {
    method: "POST",
    headers: staffHeaders,
    body: JSON.stringify({
      name: "Nguyen Van A",
      phone: "+84 901 234 567",
      email: "CUSTOMER@EXAMPLE.COM",
      company: "Acme Studio",
      note: "Priority customer",
    }),
  });
  assert.equal(createCustomer.response.status, 201);
  assert.equal(createCustomer.body.customer.email, "customer@example.com");
  const customerId = createCustomer.body.customer.id;

  const updateCustomer = await api(baseUrl, `/api/admin/v1/customers/${customerId}`, {
    method: "PATCH",
    headers: staffHeaders,
    body: JSON.stringify({ company: "Acme Holdings", note: null }),
  });
  assert.equal(updateCustomer.response.status, 200);
  assert.equal(updateCustomer.body.customer.company, "Acme Holdings");
  assert.equal(updateCustomer.body.customer.note, null);

  for (const query of ["nguyen", "901 234", "customer@example.com", "holdings"]) {
    const search = await api(
      baseUrl,
      `/api/admin/v1/customers?q=${encodeURIComponent(query)}&limit=1`,
      { headers: ownerHeaders },
    );
    assert.equal(search.response.status, 200);
    assert.equal(search.body.pagination.total, 1);
    assert.equal(search.body.customers[0].id, customerId);
  }

  const licenseResult = await pool.query(
    `INSERT INTO licenses (
       application_id, customer_id, license_key_hash, license_key_preview,
       license_type, expires_at, max_devices, status, created_by_admin_id
     ) VALUES ($1, $2, $3, '****-PHASE3', 'SUBSCRIPTION', now() + interval '30 days', 2, 'ACTIVE', $4)
     RETURNING id`,
    [applicationId, customerId, Buffer.alloc(32, 7), createStaff.body.admin.id],
  );
  const licenseId = licenseResult.rows[0].id;
  await pool.query(
    `INSERT INTO devices (license_id, device_id, device_name, os, app_version)
     VALUES ($1, 'device-phase3-1', 'Workstation', 'Windows 11', '2.5.0')`,
    [licenseId],
  );
  await pool.query(
    `INSERT INTO license_events (
       license_id, event_type, old_value, new_value, actor_type, actor_admin_id, metadata
     ) VALUES (
       $1, 'LICENSE_RENEWED', jsonb_build_object('expiresAt', 'old'),
       jsonb_build_object('expiresAt', 'new'), 'ADMIN', $2, '{}'::jsonb
     )`,
    [licenseId, createStaff.body.admin.id],
  );

  const customerDetail = await api(baseUrl, `/api/admin/v1/customers/${customerId}`, {
    headers: ownerHeaders,
  });
  assert.equal(customerDetail.response.status, 200);
  assert.equal(customerDetail.body.customer.licenses.length, 1);
  const detailLicense = customerDetail.body.customer.licenses[0];
  assert.equal(detailLicense.application.appCode, "DESKTOP-PRO");
  assert.equal(detailLicense.devices.length, 1);
  assert.equal(detailLicense.renewalHistory.length, 1);
  assert.equal(detailLicense.activeDeviceCount, 1);
  assert.equal("licenseKeyHash" in detailLicense, false);
  assert.equal("license_key_hash" in detailLicense, false);

  const badId = await api(baseUrl, "/api/admin/v1/customers/not-a-uuid", {
    headers: ownerHeaders,
  });
  assert.equal(badId.response.status, 400);

  const missingCustomer = await api(
    baseUrl,
    "/api/admin/v1/customers/00000000-0000-4000-8000-000000000000",
    { headers: ownerHeaders },
  );
  assert.equal(missingCustomer.response.status, 404);
  assert.equal(missingCustomer.body.error.code, "RESOURCE_NOT_FOUND");

  const auditResult = await pool.query(
    `SELECT action, count(*)::int AS count
     FROM audit_logs
     WHERE action IN (
       'APPLICATION_CREATED', 'APPLICATION_STATUS_CHANGED', 'CUSTOMER_CREATED', 'CUSTOMER_UPDATED'
     )
     GROUP BY action`,
  );
  const actions = new Map(auditResult.rows.map((row) => [row.action, row.count]));
  assert.equal(actions.get("APPLICATION_CREATED"), 1);
  assert.equal(actions.get("APPLICATION_STATUS_CHANGED"), 1);
  assert.equal(actions.get("CUSTOMER_CREATED"), 1);
  assert.equal(actions.get("CUSTOMER_UPDATED"), 1);

  process.stdout.write("[admin-api] applications/customers integration test passed\n");
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
