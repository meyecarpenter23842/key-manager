import { invoke } from "@tauri-apps/api/core";

export interface AdminApiRuntimeStatus {
  online: boolean;
  managed: boolean;
  detail: string | null;
}

export function configureAdminApi(databaseUrl: string): Promise<void> {
  return invoke<void>("configure_admin_api", { databaseUrl });
}

export function ensureAdminApiRuntime(): Promise<AdminApiRuntimeStatus> {
  return invoke("ensure_admin_api");
}

export function getAdminApiRuntimeStatus(): Promise<AdminApiRuntimeStatus> {
  return invoke("admin_api_runtime_status");
}
