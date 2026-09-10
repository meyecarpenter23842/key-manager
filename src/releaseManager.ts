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

export interface R2CredentialProfileSummary {
  id: string;
  name: string;
  accountId: string;
  accessKeyPreview: string;
  hasSecret: boolean;
}

export interface R2CredentialBindingSummary {
  applicationId: string;
  credentialProfileId: string;
}

export interface R2CredentialState {
  profiles: R2CredentialProfileSummary[];
  bindings: R2CredentialBindingSummary[];
}

export interface SaveR2CredentialProfileInput {
  id: string | null;
  name: string;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function getReleaseManagerConfig(): Promise<ReleaseManagerConfig> {
  return invoke("get_release_manager_config");
}

export function saveReleaseManagerConfig(config: ReleaseManagerConfig): Promise<ReleaseManagerConfig> {
  return invoke("save_release_manager_config", { config });
}

export function packageKeyManager(newVersion: string, releaseNotes: string): Promise<PackageResult> {
  return invoke("package_key_manager_release_safe", { newVersion, releaseNotes });
}

export function deleteKeyManagerDraftRelease(version: string): Promise<void> {
  return invoke("delete_key_manager_draft_release", { version });
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

export function listR2CredentialProfiles(): Promise<R2CredentialState> {
  return invoke("list_r2_credential_profiles");
}

export function saveR2CredentialProfile(input: SaveR2CredentialProfileInput): Promise<R2CredentialProfileSummary> {
  return invoke("save_r2_credential_profile", { input });
}

export function deleteR2CredentialProfile(id: string): Promise<void> {
  return invoke("delete_r2_credential_profile", { id });
}

export function bindR2CredentialProfile(applicationId: string, credentialProfileId: string | null): Promise<void> {
  return invoke("bind_r2_credential_profile", { applicationId, credentialProfileId });
}
