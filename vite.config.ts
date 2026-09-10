import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const adminApiUrl = env.VITE_ADMIN_API_URL || "http://127.0.0.1:3101";

  return {
    plugins: [react()],
    clearScreen: false,
    define: {
      "import.meta.env.VITE_ADMIN_API_URL": JSON.stringify(adminApiUrl),
    },
    server: {
      port: 1420,
      strictPort: true,
      watch: {
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
