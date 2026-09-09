import process from "node:process";

import { createAdminApiServer } from "./app.mjs";
import { loadServerConfig } from "./config.mjs";
import { AdminRepository, createDatabasePool } from "./repository.mjs";
import { createStructuredLogger } from "./structured-log.mjs";

const config = loadServerConfig();
const pool = createDatabasePool(config.databaseUrl);
const repository = new AdminRepository(pool);
const structuredLogger = createStructuredLogger();
const server = createAdminApiServer({
  repository,
  sessionTtlHours: config.sessionTtlHours,
  allowedOrigins: config.allowedOrigins,
  publicRateLimitMax: config.publicRateLimitMax,
  publicRateLimitWindowMs: config.publicRateLimitWindowMs,
  logger: structuredLogger,
});

function log(message) {
  process.stdout.write(`[key-manager-api] ${message}\n`);
}

async function shutdown(signal) {
  log(`received ${signal}; shutting down`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

server.listen(config.port, config.host, () => {
  log(`listening on http://${config.host}:${config.port}`);
});
