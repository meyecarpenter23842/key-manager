import { describe, expect, it } from "vitest";

import { PERMISSIONS, hasPermission } from "../server/src/rbac.mjs";
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  normalizeEmail,
  verifyPassword,
} from "../server/src/security.mjs";

describe("admin authentication security", () => {
  it("hashes passwords without storing plaintext and verifies the correct password", async () => {
    const password = "Correct-Horse-Battery-42";
    const encoded = await hashPassword(password);

    expect(encoded).not.toContain(password);
    expect(encoded.startsWith("scrypt$32768$8$1$")).toBe(true);
    await expect(verifyPassword(password, encoded)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password", encoded)).resolves.toBe(false);
  });

  it("normalizes admin email lookup", () => {
    expect(normalizeEmail("  Owner@Example.COM ")).toBe("owner@example.com");
  });

  it("stores only a fixed-length hash of session tokens", () => {
    const token = createSessionToken();
    const digest = hashSessionToken(token);

    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(digest).not.toBeNull();
    expect(digest.length).toBe(32);
  });
});

describe("admin RBAC", () => {
  it("gives OWNER admin-management permission", () => {
    expect(hasPermission("OWNER", PERMISSIONS.ADMIN_WRITE)).toBe(true);
  });

  it("lets ADMIN revoke licenses but not manage admins", () => {
    expect(hasPermission("ADMIN", PERMISSIONS.LICENSE_REVOKE)).toBe(true);
    expect(hasPermission("ADMIN", PERMISSIONS.ADMIN_WRITE)).toBe(false);
  });

  it("lets STAFF create and renew but not revoke or archive licenses", () => {
    expect(hasPermission("STAFF", PERMISSIONS.LICENSE_CREATE)).toBe(true);
    expect(hasPermission("STAFF", PERMISSIONS.LICENSE_RENEW)).toBe(true);
    expect(hasPermission("STAFF", PERMISSIONS.LICENSE_REVOKE)).toBe(false);
    expect(hasPermission("STAFF", PERMISSIONS.LICENSE_ARCHIVE)).toBe(false);
  });
});
