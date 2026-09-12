import { useEffect, useLayoutEffect, useState } from "react";

import { clearSession, hasSession, me } from "./api";
import { AdminShell } from "./AdminShell";
import { KeyIcon } from "./icons";
import { LoginScreen } from "./LoginScreen";
import type { AdminIdentity } from "./types";

export type Theme = "light" | "dark";
const THEME_STORAGE_KEY = "key-manager.theme";

function initialTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Storage can be unavailable in restricted webviews; system preference remains a safe fallback.
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function App() {
  const [admin, setAdmin] = useState<AdminIdentity | null>(null);
  const [booting, setBooting] = useState(true);
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Keep the in-memory theme even if persistence is unavailable.
    }
  }, [theme]);

  useEffect(() => {
    if (!hasSession()) { setBooting(false); return; }
    void me().then(setAdmin).catch(() => clearSession()).finally(() => setBooting(false));
  }, []);

  const toggleTheme = () => setTheme((current) => current === "dark" ? "light" : "dark");

  if (booting) return <main className="boot-screen"><div className="brand-mark large"><KeyIcon size={28} /></div><span className="spinner dark" /><strong>Đang mở Key Manager...</strong></main>;
  if (!admin) return <LoginScreen theme={theme} onToggleTheme={toggleTheme} onLogin={setAdmin} />;
  return <AdminShell admin={admin} theme={theme} onToggleTheme={toggleTheme} onSignedOut={() => setAdmin(null)} />;
}
