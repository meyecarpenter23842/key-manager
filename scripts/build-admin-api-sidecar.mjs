import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const serverRoot = join(root, "server", "src");
const binaryRoot = join(root, "src-tauri", "binaries");

if (process.platform !== "win32") {
  process.stdout.write("[admin-api-sidecar] Windows-only sidecar build skipped on this host\n");
  process.exit(0);
}

function newestMtime(path) {
  const info = statSync(path);
  if (!info.isDirectory()) return info.mtimeMs;
  return readdirSync(path, { withFileTypes: true }).reduce((newest, entry) => {
    const child = join(path, entry.name);
    return Math.max(newest, newestMtime(child));
  }, info.mtimeMs);
}

const targetTriple = execFileSync("rustc", ["--print", "host-tuple"], {
  cwd: root,
  encoding: "utf8",
}).trim();

let pkgArch;
if (targetTriple === "x86_64-pc-windows-msvc") pkgArch = "x64";
else if (targetTriple === "aarch64-pc-windows-msvc") pkgArch = "arm64";
else {
  throw new Error(`ADMIN_API_SIDECAR_TARGET_UNSUPPORTED: ${targetTriple}`);
}

mkdirSync(binaryRoot, { recursive: true });
const output = join(binaryRoot, `key-manager-api-${targetTriple}.exe`);
const inputMtime = Math.max(
  newestMtime(serverRoot),
  statSync(join(root, "package.json")).mtimeMs,
  statSync(fileURLToPath(import.meta.url)).mtimeMs,
);

function clearTauriSidecarCache() {
  for (const profile of ["debug", "release"]) {
    rmSync(join(root, "src-tauri", "target", profile, "key-manager-api.exe"), { force: true });
  }
}

if (existsSync(output) && statSync(output).mtimeMs >= inputMtime) {
  clearTauriSidecarCache();
  process.stdout.write(`[admin-api-sidecar] up to date: ${output}\n`);
  process.exit(0);
}

process.stdout.write(`[admin-api-sidecar] building ${targetTriple}\n`);
const pkgArgs = [
  "dlx",
  "@yao-pkg/pkg@6.22.0",
  "server/src/index.mjs",
  "--target",
  `node22-win-${pkgArch}`,
  "--output",
  output,
];
const command = process.env.ComSpec || "cmd.exe";
const result = spawnSync(command, ["/D", "/S", "/C", "pnpm", ...pkgArgs], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`ADMIN_API_SIDECAR_BUILD_FAILED: exit ${result.status ?? "signal"}`);
}
if (!existsSync(output)) {
  throw new Error(`ADMIN_API_SIDECAR_BUILD_FAILED: output missing at ${output}`);
}
clearTauriSidecarCache();
process.stdout.write(`[admin-api-sidecar] ready: ${output}\n`);
