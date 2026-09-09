import { URL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  normalizeApplicationCreate,
  normalizeApplicationPatch,
  normalizeCustomerCreate,
  parsePagination,
} from "../server/src/resources.mjs";

describe("Phase 3 resource validation", () => {
  it("normalizes application codes and applies database-aligned defaults", () => {
    expect(normalizeApplicationCreate({ name: "App", appCode: "desk_app" })).toEqual({
      name: "App",
      appCode: "DESK_APP",
      description: null,
      currentVersion: null,
      minimumVersion: null,
      status: "ACTIVE",
      offlineGraceSeconds: 86400,
      defaultDeviceLimit: 1,
      defaultDurationDays: 30,
      allowLifetime: true,
    });
  });

  it("rejects unknown application fields", () => {
    expect(() => normalizeApplicationPatch({ minimumVersion: "1.2.3", surprise: true })).toThrow(
      "Unknown field",
    );
  });

  it("normalizes customer email and nullable optional fields", () => {
    expect(
      normalizeCustomerCreate({
        name: "Customer",
        email: " Person@Example.COM ",
        phone: "",
      }),
    ).toMatchObject({ email: "person@example.com", phone: null });
  });

  it("enforces pagination bounds", () => {
    expect(() => parsePagination(new URL("http://localhost/?limit=101"))).toThrow("limit must be");
    expect(parsePagination(new URL("http://localhost/?limit=50&offset=25"))).toEqual({
      limit: 50,
      offset: 25,
    });
  });
});
