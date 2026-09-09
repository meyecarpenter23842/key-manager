import { describe, expect, it } from "vitest";

import { can, formatDuration, formatExpiry, pageCount, statusTone } from "../src/ui";

describe("admin desktop UI helpers", () => {
  it("formats offline grace into useful units", () => {
    expect(formatDuration(0)).toBe("Tắt offline");
    expect(formatDuration(120)).toBe("2 phút");
    expect(formatDuration(7200)).toBe("2 giờ");
    expect(formatDuration(172800)).toBe("2 ngày");
  });

  it("labels lifetime licenses without a fake expiry", () => {
    expect(formatExpiry(null)).toBe("Vĩnh viễn");
  });

  it("maps resource states to stable UI tones", () => {
    expect(statusTone("ACTIVE")).toBe("success");
    expect(statusTone("EXPIRED")).toBe("warning");
    expect(statusTone("REVOKED")).toBe("danger");
    expect(statusTone("INACTIVE")).toBe("neutral");
  });

  it("mirrors server RBAC for action visibility", () => {
    expect(can("OWNER", "admin:write")).toBe(true);
    expect(can("ADMIN", "license:revoke")).toBe(true);
    expect(can("STAFF", "license:create")).toBe(true);
    expect(can("STAFF", "license:revoke")).toBe(false);
    expect(can("STAFF", "application:write")).toBe(false);
  });

  it("keeps pagination at a minimum of one page", () => {
    expect(pageCount(0, 25)).toBe(1);
    expect(pageCount(26, 25)).toBe(2);
  });
});
