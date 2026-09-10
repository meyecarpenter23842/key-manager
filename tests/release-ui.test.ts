import { describe, expect, it } from "vitest";

import { formatFileSize, joinPatterns, splitPatterns } from "../src/releaseUi";

describe("release manager UI helpers", () => {
  it("normalizes artifact patterns from common separators", () => {
    expect(splitPatterns("*.exe, *.blockmap; latest.yml\nlatest.json")).toEqual([
      "*.exe",
      "*.blockmap",
      "latest.yml",
      "latest.json",
    ]);
  });

  it("joins patterns for editable fields", () => {
    expect(joinPatterns(["*.exe", "latest.yml"])).toBe("*.exe, latest.yml");
  });

  it("formats installer sizes", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1024)).toBe("1.00 KB");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.00 MB");
  });
});
