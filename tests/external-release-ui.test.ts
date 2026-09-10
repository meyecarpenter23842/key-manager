import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../src/ReleaseManagerPage.tsx", import.meta.url), "utf8");

describe("external release UI regression coverage", () => {
  it("stores external publish failures in the Build / Publish log before reporting them", () => {
    const flow = source.match(/async function runExternalPackage[\s\S]*?\n  }\n\n  if \(!config\)/)?.[0] ?? "";
    expect(flow).toContain("const message = errorMessage(error);");
    expect(flow).toContain("setLog(message);");
    expect(flow.indexOf("setLog(message);")).toBeLessThan(flow.indexOf("onError("));
  });

  it("collects source status before asking for the next external version", () => {
    expect(source).toContain("getExternalReleaseStatus(application.id)");
    expect(source).toContain("newVersion: nextPatchVersion(status.currentVersion)");
  });

  it("keeps version and release notes in the publish flow rather than release configuration", () => {
    const publishModal = source.match(/title={`Phát hành[\s\S]*?title={`Cấu hình release/)?.[0] ?? "";
    expect(publishModal).toContain('label="Version mới"');
    expect(publishModal).toContain('label="Release notes"');

    const configModal = source.match(/title={`Cấu hình release[\s\S]*?{editingR2 \?/)?.[0] ?? "";
    expect(configModal).not.toContain('label="Version mới"');
    expect(configModal).not.toContain('label="Release notes"');
  });
});
