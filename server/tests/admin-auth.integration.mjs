import assert from "node:assert/strict";
import process from "node:process";

import { createAdminApiServer } from "../src/app.mjs";
import { AdminRepository, createDatabasePool } from "../src/repository.mjs";
import { hashPassword } from "../src/security.mjs";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for the admin auth integration test");
}

const pool = createDatabasePool(process.env.DATABASE_URL);
const repository = new AdminRepository(pool);
const ownerPassword = "Owner-Integration-Password-42";
const staffPassword = "Staff-Integration-Password-42";
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
  const body = text ? JSON.parse(text) : null;
  return { response, body };
}

try {
  await pool.query("DELETE FROM admin_sessions");
  await pool.query("DELETE FROM audit_logs WHERE target_type IN ('ADMIN', 'ADMIN_AUTH', 'ADMIN_SESSION')");
  await pool.query("DELETE FROM admins");

  const ownerPasswordHash = await hashPassword(ownerPassword);
  await repository.bootstrapOwner({
    email: "owner.integration@example.com",
    passwordHash: ownerPasswordHash,
  });

  server = createAdminApiServer({ repository, sessionTtlHours: 1 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const badLogin = await api(baseUrl, "/api/admin/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "owner.integration@example.com", password: "wrong-password" }),
  });
  assert.equal(badLogin.response.status, 401);
  assert.equal(badLogin.body.error.code, "INVALID_CREDENTIALS");

  const ownerLogin = await api(baseUrl, "/api/admin/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "OWNER.INTEGRATION@example.com", password: ownerPassword }),
  });
  assert.equal(ownerLogin.response.status, 200);
  assert.equal(ownerLogin.body.admin.role, "OWNER");
  assert.ok(ownerLogin.body.token);

  const ownerHeaders = { authorization: `Bearer ${ownerLogin.body.token}` };
  const me = await api(baseUrl, "/api/admin/v1/auth/me", { headers: ownerHeaders });
  assert.equal(me.response.status, 200);
  assert.equal(me.body.admin.email, "owner.integration@example.com");

  const createStaff = await api(baseUrl, "/api/admin/v1/admins", {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      email: "staff.integration@example.com",
      password: staffPassword,
      role: "STAFF",
    }),
  });
  assert.equal(createStaff.response.status, 201);
  assert.equal(createStaff.body.admin.role, "STAFF");

  const staffLogin = await api(baseUrl, "/api/admin/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "staff.integration@example.com", password: staffPassword }),
  });
  assert.equal(staffLogin.response.status, 200);

  const staffListAdmins = await api(baseUrl, "/api/admin/v1/admins", {
    headers: { authorization: `Bearer ${staffLogin.body.token}` },
  });
  assert.equal(staffListAdmins.response.status, 403);
  assert.equal(staffListAdmins.body.error.code, "FORBIDDEN");

  const logout = await api(baseUrl, "/api/admin/v1/auth/logout", {
    method: "POST",
    headers: ownerHeaders,
  });
  assert.equal(logout.response.status, 204);

  const revokedSession = await api(baseUrl, "/api/admin/v1/auth/me", { headers: ownerHeaders });
  assert.equal(revokedSession.response.status, 401);

  const auditResult = await pool.query(
    `SELECT action, count(*)::int AS count
     FROM audit_logs
     WHERE action IN ('OWNER_BOOTSTRAPPED', 'ADMIN_LOGIN_FAILED', 'ADMIN_LOGIN_SUCCEEDED', 'ADMIN_CREATED', 'ADMIN_LOGOUT')
     GROUP BY action`,
  );
  const actions = new Map(auditResult.rows.map((row) => [row.action, row.count]));
  assert.equal(actions.get("OWNER_BOOTSTRAPPED"), 1);
  assert.equal(actions.get("ADMIN_LOGIN_FAILED"), 1);
  assert.equal(actions.get("ADMIN_LOGIN_SUCCEEDED"), 2);
  assert.equal(actions.get("ADMIN_CREATED"), 1);
  assert.equal(actions.get("ADMIN_LOGOUT"), 1);

  process.stdout.write("[admin-api] integration test passed\n");
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await pool.end();
}
