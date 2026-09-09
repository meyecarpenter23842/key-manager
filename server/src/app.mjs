import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { URL } from "node:url";

import { PERMISSIONS, hasPermission, isAdminRole } from "./rbac.mjs";
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
const INVALID_CREDENTIALS = { error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials" } };

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
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}

export function createAdminApiServer({ repository, sessionTtlHours = 12, allowedOrigins = [] }) {
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
          if (!hasPermission(session.role, PERMISSIONS.ADMIN_READ)) {
            writeJson(
              response,
              403,
              { error: { code: "FORBIDDEN", message: "Insufficient permission" } },
              commonHeaders,
            );
            return;
          }
          const admins = await repository.listAdmins();
          writeJson(response, 200, { admins }, commonHeaders);
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/admin/v1/admins") {
          if (!hasPermission(session.role, PERMISSIONS.ADMIN_WRITE)) {
            writeJson(
              response,
              403,
              { error: { code: "FORBIDDEN", message: "Insufficient permission" } },
              commonHeaders,
            );
            return;
          }

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
            code: statusCode >= 500 ? "SERVER_ERROR" : "INVALID_REQUEST",
            message: statusCode >= 500 ? "Internal server error" : error.message,
          },
        },
        commonHeaders,
      );
    }
  });
}
