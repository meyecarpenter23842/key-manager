import { useEffect, useState } from "react";

import { clearSession, hasSession, me } from "./api";
import { AdminShell } from "./AdminShell";
import { KeyIcon } from "./icons";
import { LoginScreen } from "./LoginScreen";
import type { AdminIdentity } from "./types";

export function App() {
  const [admin, setAdmin] = useState<AdminIdentity | null>(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    if (!hasSession()) { setBooting(false); return; }
    void me().then(setAdmin).catch(() => clearSession()).finally(() => setBooting(false));
  }, []);

  if (booting) return <main className="boot-screen"><div className="brand-mark large"><KeyIcon size={28} /></div><span className="spinner dark" /><strong>Đang mở Key Manager...</strong></main>;
  if (!admin) return <LoginScreen onLogin={setAdmin} />;
  return <AdminShell admin={admin} onSignedOut={() => setAdmin(null)} />;
}
