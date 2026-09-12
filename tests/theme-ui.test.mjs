import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const app = readFileSync("src/App.tsx", "utf8");
const shell = readFileSync("src/AdminShell.tsx", "utf8");
const login = readFileSync("src/LoginScreen.tsx", "utf8");
const theme = readFileSync("src/styles/theme.css", "utf8");

describe("dark theme UI", () => {
  it("persists the chosen theme and applies it at the document root", () => {
    expect(app).toContain('const THEME_STORAGE_KEY = "key-manager.theme"');
    expect(app).toContain("document.documentElement.dataset.theme = theme");
    expect(app).toContain("window.localStorage.setItem(THEME_STORAGE_KEY, theme)");
    expect(app).toContain("prefers-color-scheme: dark");
  });

  it("offers moon and sun toggles on both login and admin UI", () => {
    expect(shell).toContain('className="icon-button theme-toggle"');
    expect(shell).toContain("MoonIcon");
    expect(shell).toContain("SunIcon");
    expect(login).toContain('className="icon-button theme-toggle login-theme-toggle"');
    expect(login).toContain("MoonIcon");
    expect(login).toContain("SunIcon");
  });

  it("darkens every major raised surface instead of leaving bright cards", () => {
    for (const selector of [
      ".login-card",
      ".stat-card",
      ".panel",
      ".modal",
      ".toast",
      ".customer-license-card",
      ".release-current-version",
      ".r2-profile-card",
      ".release-app-row",
    ]) {
      expect(theme).toContain(selector);
    }
    expect(theme).toContain(':root[data-theme="dark"] input');
    expect(theme).toContain(':root[data-theme="dark"] th');
    expect(theme).toContain(':root[data-theme="dark"] td');
  });
});
