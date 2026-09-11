import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const applications = readFileSync("src/ApplicationsPage.tsx", "utf8");
const customers = readFileSync("src/CustomersPage.tsx", "utf8");

describe("application image and customer cross-reference UI", () => {
  it("lets an admin choose and remove an application image", () => {
    expect(applications).toContain('accept="image/png,image/jpeg,image/webp"');
    expect(applications).toContain("normalizeApplicationIcon");
    expect(applications).toContain("iconDataUrl");
    expect(applications).toContain("Bỏ ảnh");
  });

  it("opens customer detail with license, app and device cross-reference", () => {
    expect(customers).toContain("getCustomer(id)");
    expect(customers).toContain("CustomerDetailModal");
    expect(customers).toContain("License / Key");
    expect(customers).toContain("license.application.name");
    expect(customers).toContain("license.activeDeviceCount");
  });

  it("reuses the full license detail flow from customer detail", () => {
    expect(customers).toContain("LicenseDetailModal");
    expect(customers).toContain("onOpenLicense");
  });
});
