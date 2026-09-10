import { describe, expect, it } from "vitest";

import { formatFileSize, joinPatterns, nextPatchVersion, splitPatterns } from "../src/releaseUi";

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

  it("suggests the next patch version only for stable semver", () => {
    expect(nextPatchVersion("0.1.0")).toBe("0.1.1");
    expect(nextPatchVersion("1.9.99")).toBe("1.9.100");
    expect(nextPatchVersion("1.0.0-rc.1")).toBe("");
  });

  it("formats installer sizes", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1024)).toBe("1.00 KB");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.00 MB");
  });
});
