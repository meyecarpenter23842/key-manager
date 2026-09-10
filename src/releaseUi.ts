export function splitPatterns(value: string): string[] {
  return value
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function joinPatterns(patterns: string[]): string {
  return patterns.join(", ");
}

export function nextPatchVersion(version: string | null | undefined): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || "").trim());
  if (!match) return "";
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}
