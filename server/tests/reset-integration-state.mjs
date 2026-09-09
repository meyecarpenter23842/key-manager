import process from "node:process";

import { createDatabasePool } from "../src/repository.mjs";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for the integration test reset");
}

const pool = createDatabasePool(process.env.DATABASE_URL);

try {
  await pool.query("DELETE FROM license_events");
  await pool.query("DELETE FROM devices");
  await pool.query("DELETE FROM licenses");
  await pool.query("DELETE FROM customers");
  await pool.query("DELETE FROM applications");
  await pool.query("DELETE FROM admin_sessions");
  await pool.query("DELETE FROM audit_logs");
  await pool.query("DELETE FROM admins");
  process.stdout.write("[admin-api] integration test state reset\n");
} finally {
  await pool.end();
}
