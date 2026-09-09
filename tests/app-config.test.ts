import { describe, expect, it } from "vitest";

import { APP_DESCRIPTION, APP_NAME } from "../src/config/app";

describe("desktop app metadata", () => {
  it("uses the Key Manager product identity", () => {
    expect(APP_NAME).toBe("Key Manager");
    expect(APP_DESCRIPTION).toContain("License Management");
  });
});
