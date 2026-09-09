import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

import { APP_DESCRIPTION, APP_NAME } from "./config/app";

export function App() {
  const [runtime, setRuntime] = useState("Đang kết nối Tauri runtime...");

  useEffect(() => {
    void invoke<string>("app_info")
      .then(setRuntime)
      .catch(() => setRuntime("Browser preview — chạy `pnpm tauri dev` để mở desktop app"));
  }, []);

  return (
    <main className="app-shell">
      <section className="hero-card">
        <div className="eyebrow">DESKTOP ADMIN</div>
        <h1>{APP_NAME}</h1>
        <p className="description">{APP_DESCRIPTION}</p>
        <div className="runtime-row">
          <span className="status-dot" aria-hidden="true" />
          <span>{runtime}</span>
        </div>
      </section>

      <section className="architecture-grid" aria-label="Kiến trúc nền tảng">
        <article>
          <strong>Tauri + React</strong>
          <span>Desktop UI chạy native WebView trên Windows.</span>
        </article>
        <article>
          <strong>License API</strong>
          <span>Backend HTTPS riêng sẽ được triển khai ở phase tiếp theo.</span>
        </article>
        <article>
          <strong>PostgreSQL</strong>
          <span>Chỉ backend được truy cập database; desktop client không truy cập trực tiếp.</span>
        </article>
      </section>
    </main>
  );
}
