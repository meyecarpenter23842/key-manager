import process from "node:process";

import { loadServerConfig } from "../src/config.mjs";
import { AdminRepository, createDatabasePool } from "../src/repository.mjs";
import { hashPassword, normalizeEmail, validateEmail, validatePassword } from "../src/security.mjs";

const config = loadServerConfig();
const email = normalizeEmail(process.env.KEY_MANAGER_OWNER_EMAIL);
const password = process.env.KEY_MANAGER_OWNER_PASSWORD;

if (!validateEmail(email) || !validatePassword(password)) {
  process.stderr.write(
    "[admin-bootstrap] set KEY_MANAGER_OWNER_EMAIL and a KEY_MANAGER_OWNER_PASSWORD of 12-128 characters\n",
  );
  process.exit(1);
}

const pool = createDatabasePool(config.databaseUrl);
try {
  const repository = new AdminRepository(pool);
  const passwordHash = await hashPassword(password);
  const owner = await repository.bootstrapOwner({ email, passwordHash });
  process.stdout.write(`[admin-bootstrap] created OWNER ${owner.email}\n`);
} finally {
  await pool.end();
}
