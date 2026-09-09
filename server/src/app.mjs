import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { URL } from "node:url";

import { DeviceRepository } from "./device-repository.mjs";
import { parseDeviceFilters } from "./devices.mjs";
import { LicenseApiRepository } from "./license-api-repository.mjs";
import { PublicLicenseService } from "./license-service.mjs";
import {
  generateLicenseKey,
  hashLicenseKey,
  maskLicenseKey,
  normalizeDeviceLimit,
  normalizeLicenseCreate,
  normalizeLicenseRenew,
  parseLicenseFilters,
} from "./licenses.mjs";
import {
  normalizeActivation,
  normalizeDeactivation,
  normalizeHeartbeat,
  normalizeValidation,
} from "./public-license.mjs";
import { createRateLimiter } from "./rate-limit.mjs";
import { PERMISSIONS, hasPermission, isAdminRole } from "./rbac.mjs";
import {
  isUuid,
  normalizeApplicationCreate,
  normalizeApplicationPatch,
  normalizeCustomerCreate,
  normalizeCustomerPatch,
  parseApplicationStatusFilter,
  parsePagination,
  parseSearch,
} from "./resources.mjs";
import {
  DUMMY_PASSWORD_HASH,
  createSessionToken,
  hashPassword,
  hashSessionToken,
  normalizeEmail,
  validateEmail,
  validatePassword,
  verifyPassword,
} from "./security.mjs";

const MAX_JSON_BODY_BYTES = 16 * 1024;
const INVALID_CREDENTIALS = {
  error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials" },
};
const PUBLIC_LICENSE_ACTIONS = new Map([
  ["/api/v1/license/activate", "activate"],
  ["/api/v1/license/validate", "validate"],
  ["/api/v1/license/heartbeat", "heartbeat"],
  ["/api/v1/license/deactivate", "deactivate"],
]);

function writeJson(response, statusCode, payload, headers = {}) {
  const body = payload === null ? "" : JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(body);
}

function clientIp(request) {
  return request.socket.remoteAddress || null;
}

function userAgent(request) {
  const value = request.headers["user-agent"];
  return typeof value === "string" && value.trim() ? value.slice(0, 1000) : null;
}

async function readJson(request) {
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_JSON_BODY_BYTES) {
      const error = new Error("request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("invalid JSON body");
    error.statusCode = 400;
    throw error;
  }
}

function bearerToken(request) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

function publicAdmin(admin) {
  return {
    id: admin.admin_id ?? admin.id,
    email: admin.email,
    role: admin.role,
    status: admin.status,
  };
}

async function authenticate(request, repository) {
  const tokenHash = hashSessionToken(bearerToken(request));
  if (!tokenHash) return null;
  return repository.findSessionByTokenHash(tokenHash);
}

function corsHeaders(request, allowedOrigins) {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !allowedOrigins.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-headers": "authorization, content-type, x-request-id",
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
  };
}

function requirePermission(response, headers, session, permission) {
  if (hasPermission(session.role, permission)) return true;
  writeJson(
    response,
    403,
    { error: { code: "FORBIDDEN", message: "Insufficient permission" } },
    headers,
  );
  return false;
}

function writeResourceNotFound(response, headers, resource) {
  writeJson(
    response,
    404,
    { error: { code: "RESOURCE_NOT_FOUND", message: `${resource} not found` } },
    headers,
  );
}

function pathId(pathname, prefix) {
  const match = new RegExp(`^${prefix}/([^/]+)$`).exec(pathname);
  return match?.[1] ?? null;
}

function licensePath(pathname) {
  const match = /^\/api\/admin\/v1\/licenses\/([^/]+)(?:\/(renew|revoke|reactivate|archive|device-limit))?$/.exec(
    pathname,
  );
  if (!match) return null;
  return { id: match[1], action: match[2] ?? null };
}

function devicePath(pathname) {
  const match = /^\/api\/admin\/v1\/devices\/([^/]+)(?:\/(revoke))?$/.exec(pathname);
  if (!match) return null;
  return { id: match[1], action: match[2] ?? null };
}

function normalizePublicPayload(action, body) {
  switch (action) {
    case "activate":
      return normalizeActivation(body);
    case "validate":
      return normalizeValidation(body);
    case "heartbeat":
      return normalizeHeartbeat(body);
    case "deactivate":
      return normalizeDeactivation(body);
    default:
      throw new Error("Unknown public license action");
  }
}

function safeStructuredLog(logger, event) {
  if (typeof logger !== "function") return;
  try {
    logger(event);
  } catch {
    // Logging must never alter an API response.
  }
}

export function createAdminApiServer({
  repository,
  deviceRepository = null,
  licenseApiRepository = null,
  licenseService = null,
  publicRateLimiter = null,
  publicRateLimitMax = 120,
  publicRateLimitWindowMs = 60_000,
  logger = null,
  sessionTtlHours = 12,
  allowedOrigins = [],
}) {
  const devices = deviceRepository ?? new DeviceRepository(repository.pool);
  const publicLicenses =
    licenseService ??
    new PublicLicenseService({
      licenseRepository: licenseApiRepository ?? new LicenseApiRepository(repository.pool),
      deviceRepository: devices,
    });
  const rateLimiter =
    publicRateLimiter ??
    createRateLimiter({ maxRequests: publicRateLimitMax, windowMs: publicRateLimitWindowMs });

  return createServer(async (request, response) => {
    const requestIdHeader = request.headers["x-request-id"];
    const requestId =
      typeof requestIdHeader === "string" && requestIdHeader.trim()
        ? requestIdHeader.trim().slice(0, 200)
        : randomUUID();
    const commonHeaders = {
      "x-request-id": requestId,
      ...corsHeaders(request, allowedOrigins),
    };

    try {
      const url = new URL(request.url || "/", "http://localhost");

      if (request.method === "OPTIONS") {
        response.writeHead(204, commonHeaders);
        response.end();
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        await repository.ping();
        writeJson(response, 200, { status: "ok" }, commonHeaders);
        return;
      }

      const publicAction = PUBLIC_LICENSE_ACTIONS.get(url.pathname);
      if (request.method === "POST" && publicAction) {
        const startedAt = Date.now();
        const ipAddress = clientIp(request);
        const rate = rateLimiter.check(ipAddress || "unknown");
        const rateHeaders = {
          ...commonHeaders,
          "x-ratelimit-limit": String(rate.limit),
          "x-ratelimit-remaining": String(rate.remaining),
        };

        if (!rate.allowed) {
          const headers = { ...rateHeaders, "retry-after": String(rate.retryAfterSeconds) };
          writeJson(
            response,
            429,
            {
              error: { code: "RATE_LIMITED", message: "Too many requests" },
              requestId,
            },
            headers,
          );
          safeStructuredLog(logger, {
            type: "http_request",
            requestId,
            method: request.method,
            path: url.pathname,
            statusCode: 429,
            errorCode: "RATE_LIMITED",
            durationMs: Date.now() - startedAt,
            ipAddress,
          });
          return;
        }

        try {
          const input = normalizePublicPayload(publicAction, await readJson(request));
          const result = await publicLicenses[publicAction](input, { requestId, ipAddress });
          writeJson(response, 200, { ...result, requestId }, rateHeaders);
          safeStructuredLog(logger, {
            type: "http_request",
            requestId,
            method: request.method,
            path: url.pathname,
            statusCode: 200,
            durationMs: Date.now() - startedAt,
            ipAddress,
          });
        } catch (error) {
          const statusCode = Number(error?.statusCode) || 500;
          const errorCode =
            error?.errorCode || (statusCode >= 500 ? "SERVER_ERROR" : "INVALID_REQUEST");
          writeJson(
            response,
            statusCode,
            {
              error: {
                code: errorCode,
                message: statusCode >= 500 ? "Internal server error" : error.message,
              },
              requestId,
            },
            rateHeaders,
          );
          safeStructuredLog(logger, {
            type: "http_request",
            requestId,
            method: request.method,
            path: url.pathname,
            statusCode,
            errorCode,
            durationMs: Date.now() - startedAt,
            ipAddress,
          });
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/v1/auth/login") {
        const body = await readJson(request);
        const email = normalizeEmail(body.email);
        const password = body.password;
        if (!validateEmail(email) || typeof password !== "string") {
          writeJson(response, 401, INVALID_CREDENTIALS, commonHeaders);
          return;
        }

        const admin = await repository.findAdminByEmail(email);
        const passwordMatches = await verifyPassword(
          password,
          admin?.password_hash ?? DUMMY_PASSWORD_HASH,
        );
        if (!admin || admin.status !== "ACTIVE" || !passwordMatches) {
          await repository.recordFailedLogin({
            email,
            ipAddress: clientIp(request),
            requestId,
          });
          writeJson(response, 401, INVALID_CREDENTIALS, commonHeaders);
          return;
        }

        const token = createSessionToken();
        const tokenHash = hashSessionToken(token);
        const expiresAt = new Date(Date.now() + sessionTtlHours * 60 * 60 * 1000);
        await repository.recordSuccessfulLogin({
          adminId: admin.id,
          tokenHash,
          expiresAt,
          ipAddress: clientIp(request),
          userAgent: userAgent(request),
          requestId,
        });

        writeJson(
          response,
          200,
          { token, expiresAt: expiresAt.toISOString(), admin: publicAdmin(admin) },
          commonHeaders,
        );
        return;
      }

      if (url.pathname.startsWith("/api/admin/v1/")) {
        const session = await authenticate(request, repository);
        if (!session) {
          writeJson(
            response,
            401,
            { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
            commonHeaders,
          );
          return;
        }

        if (request.method === "GET" && url.pathname === "/api/admin/v1/auth/me") {
          writeJson(response, 200, { admin: publicAdmin(session) }, commonHeaders);
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/admin/v1/auth/logout") {
          await repository.revokeSession({
            sessionId: session.session_id,
            adminId: session.admin_id,
            requestId,
            ipAddress: clientIp(request),
          });
          response.writeHead(204, commonHeaders);
          response.end();
          return;
        }

        if (request.method === "GET" && url.pathname === "/api/admin/v1/admins") {
          if (!requirePermission(response, commonHeaders, session, PERMISSIONS.ADMIN_READ)) return;
          const admins = await repository.listAdmins();
          writeJson(response, 200, { admins }, commonHeaders);
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/admin/v1/admins") {
          if (!requirePermission(response, commonHeaders, session, PERMISSIONS.ADMIN_WRITE)) return;

          const body = await readJson(request);
          const email = normalizeEmail(body.email);
          const role = body.role;
          if (!validateEmail(email) || !validatePassword(body.password) || !isAdminRole(role)) {
            writeJson(
              response,
              400,
              { error: { code: "INVALID_REQUEST", message: "Invalid admin payload" } },
              commonHeaders,
            );
            return;
          }

          const passwordHash = await hashPassword(body.password);
          const admin = await repository.createAdmin({
            email,
            passwordHash,
            role,
            actorAdminId: session.admin_id,
            requestId,
            ipAddress: clientIp(request),
          });
          writeJson(response, 201, { admin }, commonHeaders);
          return;
        }

        if (request.method === "GET" && url.pathname === "/api/admin/v1/applications") {
          if (!requirePermission(response, commonHeaders, session, PERMISSIONS.APPLICATION_READ)) return;
          const { limit, offset } = parsePagination(url);
          const q = parseSearch(url);
          const status = parseApplicationStatusFilter(url);
          const result = await repository.listApplications({ q, status, limit, offset });
          writeJson(
            response,
            200,
            {
              applications: result.items,
              pagination: { total: result.total, limit: result.limit, offset: result.offset },
            },
            commonHeaders,
          );
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/admin/v1/applications") {
          if (!requirePermission(response, commonHeaders, session, PERMISSIONS.APPLICATION_WRITE)) return;
          const data = normalizeApplicationCreate(await readJson(request));
          const application = await repository.createApplication({
            data,
            actorAdminId: session.admin_id,
            requestId,
            ipAddress: clientIp(request),
          });
          writeJson(response, 201, { application }, commonHeaders);
          return;
        }

        const applicationId = pathId(url.pathname, "/api/admin/v1/applications");
        if (applicationId !== null) {
          if (!isUuid(applicationId)) {
            const error = new Error("application id must be a UUID");
            error.statusCode = 400;
            throw error;
          }
          if (request.method === "GET") {
            if (!requirePermission(response, commonHeaders, session, PERMISSIONS.APPLICATION_READ)) return;
            const application = await repository.getApplicationById(applicationId);
            if (!application) {
              writeResourceNotFound(response, commonHeaders, "Application");
              return;
            }
            writeJson(response, 200, { application }, commonHeaders);
            return;
          }
          if (request.method === "PATCH") {
            if (!requirePermission(response, commonHeaders, session, PERMISSIONS.APPLICATION_WRITE)) return;
            const patch = normalizeApplicationPatch(await readJson(request));
            const application = await repository.updateApplication({
              id: applicationId,
              patch,
              actorAdminId: session.admin_id,
              requestId,
              ipAddress: clientIp(request),
            });
            if (!application) {
              writeResourceNotFound(response, commonHeaders, "Application");
              return;
            }
            writeJson(response, 200, { application }, commonHeaders);
            return;
          }
        }

        if (request.method === "GET" && url.pathname === "/api/admin/v1/customers") {
          if (!requirePermission(response, commonHeaders, session, PERMISSIONS.CUSTOMER_READ)) return;
          const { limit, offset } = parsePagination(url);
          const q = parseSearch(url);
          const result = await repository.listCustomers({ q, limit, offset });
          writeJson(
            response,
            200,
            {
              customers: result.items,
              pagination: { total: result.total, limit: result.limit, offset: result.offset },
            },
            commonHeaders,
          );
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/admin/v1/customers") {
          if (!requirePermission(response, commonHeaders, session, PERMISSIONS.CUSTOMER_WRITE)) return;
          const data = normalizeCustomerCreate(await readJson(request));
          const customer = await repository.createCustomer({
            data,
            actorAdminId: session.admin_id,
            requestId,
            ipAddress: clientIp(request),
          });
          writeJson(response, 201, { customer }, commonHeaders);
          return;
        }

        const customerId = pathId(url.pathname, "/api/admin/v1/customers");
        if (customerId !== null) {
          if (!isUuid(customerId)) {
            const error = new Error("customer id must be a UUID");
            error.statusCode = 400;
            throw error;
          }
          if (request.method === "GET") {
            if (!requirePermission(response, commonHeaders, session, PERMISSIONS.CUSTOMER_READ)) return;
            const customer = await repository.getCustomerDetail(customerId);
            if (!customer) {
              writeResourceNotFound(response, commonHeaders, "Customer");
              return;
            }
            writeJson(response, 200, { customer }, commonHeaders);
            return;
          }
          if (request.method === "PATCH") {
            if (!requirePermission(response, commonHeaders, session, PERMISSIONS.CUSTOMER_WRITE)) return;
            const patch = normalizeCustomerPatch(await readJson(request));
            const customer = await repository.updateCustomer({
              id: customerId,
              patch,
              actorAdminId: session.admin_id,
              requestId,
              ipAddress: clientIp(request),
            });
            if (!customer) {
              writeResourceNotFound(response, commonHeaders, "Customer");
              return;
            }
            writeJson(response, 200, { customer }, commonHeaders);
            return;
          }
        }

        if (request.method === "GET" && url.pathname === "/api/admin/v1/devices") {
          if (!requirePermission(response, commonHeaders, session, PERMISSIONS.DEVICE_READ)) return;
          const { limit, offset } = parsePagination(url);
          const q = parseSearch(url);
          const filters = parseDeviceFilters(url, isUuid);
          const result = await devices.listDevices({ q, ...filters, limit, offset });
          writeJson(
            response,
            200,
            {
              devices: result.items,
              pagination: { total: result.total, limit, offset },
            },
            commonHeaders,
          );
          return;
        }

        const deviceRoute = devicePath(url.pathname);
        if (deviceRoute !== null) {
          if (!isUuid(deviceRoute.id)) {
            const error = new Error("device id must be a UUID");
            error.statusCode = 400;
            throw error;
          }
          if (deviceRoute.action === "revoke" && request.method === "POST") {
            if (!requirePermission(response, commonHeaders, session, PERMISSIONS.DEVICE_REVOKE)) return;
            const device = await devices.revokeDevice({
              id: deviceRoute.id,
              actorAdminId: session.admin_id,
              requestId,
              ipAddress: clientIp(request),
            });
            if (!device) {
              writeResourceNotFound(response, commonHeaders, "Device");
              return;
            }
            writeJson(response, 200, { device }, commonHeaders);
            return;
          }
        }

        if (request.method === "GET" && url.pathname === "/api/admin/v1/licenses") {
          if (!requirePermission(response, commonHeaders, session, PERMISSIONS.LICENSE_READ)) return;
          const { limit, offset } = parsePagination(url);
          const q = parseSearch(url);
          const filters = parseLicenseFilters(url, isUuid);
          const result = await repository.listLicenses({
            q,
            qHash: q ? hashLicenseKey(q) : null,
            ...filters,
            limit,
            offset,
          });
          writeJson(
            response,
            200,
            {
              licenses: result.items,
              pagination: { total: result.total, limit: result.limit, offset: result.offset },
            },
            commonHeaders,
          );
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/admin/v1/licenses") {
          if (!requirePermission(response, commonHeaders, session, PERMISSIONS.LICENSE_CREATE)) return;
          const data = normalizeLicenseCreate(await readJson(request), isUuid);
          const application = await repository.getApplicationById(data.applicationId);
          if (!application) {
            writeResourceNotFound(response, commonHeaders, "Application");
            return;
          }
          const licenseKey = generateLicenseKey(application.appCode);
          const license = await repository.createLicense({
            data,
            keyHash: hashLicenseKey(licenseKey),
            keyPreview: maskLicenseKey(licenseKey),
            actorAdminId: session.admin_id,
            requestId,
            ipAddress: clientIp(request),
          });
          writeJson(response, 201, { license, licenseKey }, commonHeaders);
          return;
        }

        const licenseRoute = licensePath(url.pathname);
        if (licenseRoute !== null) {
          if (!isUuid(licenseRoute.id)) {
            const error = new Error("license id must be a UUID");
            error.statusCode = 400;
            throw error;
          }

          if (licenseRoute.action === null && request.method === "GET") {
            if (!requirePermission(response, commonHeaders, session, PERMISSIONS.LICENSE_READ)) return;
            const license = await repository.getLicenseDetail(licenseRoute.id);
            if (!license) {
              writeResourceNotFound(response, commonHeaders, "License");
              return;
            }
            writeJson(response, 200, { license }, commonHeaders);
            return;
          }

          if (licenseRoute.action === "renew" && request.method === "POST") {
            if (!requirePermission(response, commonHeaders, session, PERMISSIONS.LICENSE_RENEW)) return;
            const renewal = normalizeLicenseRenew(await readJson(request));
            const license = await repository.renewLicense({
              id: licenseRoute.id,
              renewal,
              actorAdminId: session.admin_id,
              requestId,
              ipAddress: clientIp(request),
            });
            if (!license) {
              writeResourceNotFound(response, commonHeaders, "License");
              return;
            }
            writeJson(response, 200, { license }, commonHeaders);
            return;
          }

          if (licenseRoute.action === "revoke" && request.method === "POST") {
            if (!requirePermission(response, commonHeaders, session, PERMISSIONS.LICENSE_REVOKE)) return;
            const license = await repository.revokeLicense({
              id: licenseRoute.id,
              actorAdminId: session.admin_id,
              requestId,
              ipAddress: clientIp(request),
            });
            if (!license) {
              writeResourceNotFound(response, commonHeaders, "License");
              return;
            }
            writeJson(response, 200, { license }, commonHeaders);
            return;
          }

          if (licenseRoute.action === "reactivate" && request.method === "POST") {
            if (!requirePermission(response, commonHeaders, session, PERMISSIONS.LICENSE_REVOKE)) return;
            const license = await repository.reactivateLicense({
              id: licenseRoute.id,
              actorAdminId: session.admin_id,
              requestId,
              ipAddress: clientIp(request),
            });
            if (!license) {
              writeResourceNotFound(response, commonHeaders, "License");
              return;
            }
            writeJson(response, 200, { license }, commonHeaders);
            return;
          }

          if (licenseRoute.action === "archive" && request.method === "POST") {
            if (!requirePermission(response, commonHeaders, session, PERMISSIONS.LICENSE_ARCHIVE)) return;
            const license = await repository.archiveLicense({
              id: licenseRoute.id,
              actorAdminId: session.admin_id,
              requestId,
              ipAddress: clientIp(request),
            });
            if (!license) {
              writeResourceNotFound(response, commonHeaders, "License");
              return;
            }
            writeJson(response, 200, { license }, commonHeaders);
            return;
          }

          if (licenseRoute.action === "device-limit" && request.method === "PATCH") {
            if (!requirePermission(response, commonHeaders, session, PERMISSIONS.LICENSE_DEVICE_LIMIT)) {
              return;
            }
            const { maxDevices } = normalizeDeviceLimit(await readJson(request));
            const license = await repository.updateLicenseDeviceLimit({
              id: licenseRoute.id,
              maxDevices,
              actorAdminId: session.admin_id,
              requestId,
              ipAddress: clientIp(request),
            });
            if (!license) {
              writeResourceNotFound(response, commonHeaders, "License");
              return;
            }
            writeJson(response, 200, { license }, commonHeaders);
            return;
          }
        }
      }

      writeJson(
        response,
        404,
        { error: { code: "NOT_FOUND", message: "Route not found" } },
        commonHeaders,
      );
    } catch (error) {
      if (error?.code === "23505") {
        writeJson(
          response,
          409,
          { error: { code: "CONFLICT", message: "Resource already exists" } },
          commonHeaders,
        );
        return;
      }
      const statusCode = Number(error?.statusCode) || 500;
      writeJson(
        response,
        statusCode,
        {
          error: {
            code: error?.errorCode || (statusCode >= 500 ? "SERVER_ERROR" : "INVALID_REQUEST"),
            message: statusCode >= 500 ? "Internal server error" : error.message,
          },
        },
        commonHeaders,
      );
    }
  });
}
