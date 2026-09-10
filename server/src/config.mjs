import process from "node:process";

function parsePositiveInteger(value, fallback, name, maximum) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

export function loadServerConfig(env = process.env) {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for the Key Manager API server");
  }

  return {
    databaseUrl: env.DATABASE_URL,
    host: env.ADMIN_API_HOST || "127.0.0.1",
    port: parsePositiveInteger(env.ADMIN_API_PORT, 3001, "ADMIN_API_PORT", 65535),
    sessionTtlHours: parsePositiveInteger(
      env.ADMIN_SESSION_TTL_HOURS,
      12,
      "ADMIN_SESSION_TTL_HOURS",
      168,
    ),
    allowedOrigins: String(env.ADMIN_API_ALLOWED_ORIGINS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    licenseKeyEncryptionKey: env.LICENSE_KEY_ENCRYPTION_KEY || null,
    publicRateLimitMax: parsePositiveInteger(
      env.LICENSE_API_RATE_LIMIT_MAX,
      120,
      "LICENSE_API_RATE_LIMIT_MAX",
      100000,
    ),
    publicRateLimitWindowMs:
      parsePositiveInteger(
        env.LICENSE_API_RATE_LIMIT_WINDOW_SECONDS,
        60,
        "LICENSE_API_RATE_LIMIT_WINDOW_SECONDS",
        3600,
      ) * 1000,
  };
}
