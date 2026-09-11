import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync("src/LoginScreen.tsx", "utf8");

describe("Admin API runtime recovery UI", () => {
  it("re-checks and repairs the Admin API runtime while the login screen stays open", () => {
    expect(source).toContain("async function refreshRuntime()");
    expect(source).toContain("ensureAdminApiRuntime()");
    expect(source).toContain("window.setInterval(() => void refreshRuntime(), 5_000)");
    expect(source).toContain("window.clearInterval(timer)");
  });

  it("retries one login after recovering from a network-level API failure", () => {
    const submit = source.match(/async function submit\(event:[\s\S]*?\n  }\n\n  return \(/)?.[0] ?? "";
    expect(submit).toContain('caught.code !== "NETWORK_ERROR"');
    expect(submit).toContain("const runtime = await ensureAdminApiRuntime()");
    expect(submit.match(/result = await login\(email, password\)/g)?.length).toBe(2);
  });
});
