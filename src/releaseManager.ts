import { invoke } from "@tauri-apps/api/core";

export interface ExternalReleaseProfile {
  applicationId: string;
  appCode: string;
  sourceDir: string;
  buildCommand: string;
  outputDir: string;
  versionFile: string;
  versionField: string;
  artifactPatterns: string[];
  manifestPatterns: string[];
  r2Bucket: string;
  r2Prefix: string;
}

export interface ReleaseManagerConfig {
  keyManagerSourceDir: string;
  keyManagerBuildCommand: string;
  keyManagerOutputDir: string;
  keyManagerUpdateDir: string;
  externalProfiles: ExternalReleaseProfile[];
}

export interface ReleaseArtifact {
  name: string;
  path: string;
  size: number;
}

export interface PackageResult {
  appCode: string;
  version: string;
  destination: string;
  artifacts: ReleaseArtifact[];
  log: string;
}

export interface SelfUpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  available: boolean;
  installerName: string | null;
  installerSize: number | null;
  updateDir: string;
}

export function getReleaseManagerConfig(): Promise<ReleaseManagerConfig> {
  return invoke("get_release_manager_config");
}

export function saveReleaseManagerConfig(config: ReleaseManagerConfig): Promise<ReleaseManagerConfig> {
  return invoke("save_release_manager_config", { config });
}

export function packageKeyManager(): Promise<PackageResult> {
  return invoke("package_key_manager");
}

export function checkKeyManagerUpdate(): Promise<SelfUpdateStatus> {
  return invoke("check_key_manager_update");
}

export function installKeyManagerUpdate(): Promise<void> {
  return invoke("install_key_manager_update");
}

export function packageExternalApplication(applicationId: string): Promise<PackageResult> {
  return invoke("package_external_application", { applicationId });
}
