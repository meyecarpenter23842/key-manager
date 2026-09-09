-- 0001_extensions.sql
-- Server/database-only migration. Never expose database credentials to Vite/Tauri clients.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
