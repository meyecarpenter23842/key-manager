import { useEffect, useMemo, useState, type FormEvent } from "react";

import { listApplications } from "./api";
import { Field, Modal, type ErrorHandler, type Notify } from "./components";
import { CheckIcon, RefreshIcon } from "./icons";
import { PackageIcon, UploadIcon } from "./releaseIcons";
import type { Application } from "./types";
import {
  checkKeyManagerUpdate,
  getReleaseManagerConfig,
  installKeyManagerUpdate,
  packageExternalApplication,
  packageKeyManager,
  saveReleaseManagerConfig,
  type ExternalReleaseProfile,
  type PackageResult,
  type ReleaseManagerConfig,
  type SelfUpdateStatus,
} from "./releaseManager";
import { formatFileSize, joinPatterns, nextPatchVersion, splitPatterns } from "./releaseUi";

function blankProfile(application: Application): ExternalReleaseProfile {
  return {
    applicationId: application.id,
    appCode: application.appCode,
    sourceDir: "",
    buildCommand: "",
    outputDir: "dist",
    versionFile: "package.json",
    versionField: "version",
    artifactPatterns: ["*.exe", "*.blockmap", "latest.yml"],
    manifestPatterns: ["latest.yml"],
    r2Bucket: "",
    r2Prefix: "",
  };
}

function resultSummary(result: PackageResult): string {
  const files = result.artifacts.map((artifact) => `${artifact.name} (${formatFileSize(artifact.size)})`).join("\n");
  return `${result.appCode} ${result.version}\n${result.destination}\n${files}\n\n${result.log}`.trim();
}

export function ReleaseManagerPage({ onError, notify }: { onError: ErrorHandler; notify: Notify }) {
  const [config, setConfig] = useState<ReleaseManagerConfig | null>(null);
  const [applications, setApplications] = useState<Application[]>([]);
  const [update, setUpdate] = useState<SelfUpdateStatus | null>(null);
  const [newVersion, setNewVersion] = useState("");
  const [releaseNotes, setReleaseNotes] = useState("");
  const [editing, setEditing] = useState<ExternalReleaseProfile | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState("");

  useEffect(() => {
    void Promise.all([
      getReleaseManagerConfig(),
      listApplications({ limit: 100, offset: 0 }),
      checkKeyManagerUpdate().catch(() => null),
    ])
      .then(([loadedConfig, loadedApplications, loadedUpdate]) => {
        setConfig(loadedConfig);
        setApplications(loadedApplications.applications);
        setUpdate(loadedUpdate);
        setNewVersion((current) => current || nextPatchVersion(loadedUpdate?.currentVersion));
      })
      .catch(onError);
  }, [onError]);

  const profileByApplication = useMemo(
    () => new Map((config?.externalProfiles ?? []).map((profile) => [profile.applicationId, profile])),
    [config],
  );

  async function saveConfig(next = config) {
    if (!next) return;
    try {
      setBusy("save");
      const saved = await saveReleaseManagerConfig(next);
      setConfig(saved);
      notify("Đã lưu Advanced settings");
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setBusy(null);
    }
  }

  async function runKeyManagerPackage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const version = newVersion.trim();
    const notes = releaseNotes.trim();
    if (!version || !notes) return;
    try {
      setBusy("key-manager-package");
      const result = await packageKeyManager(version, notes);
      setLog(resultSummary(result));
      notify(`Đã đóng gói Key Manager ${result.version}`, result.destination);
      const nextUpdate = await checkKeyManagerUpdate();
      setUpdate(nextUpdate);
      setNewVersion(nextPatchVersion(result.version));
      setReleaseNotes("");
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setBusy(null);
    }
  }

  async function checkUpdate() {
    try {
      setBusy("check-update");
      const status = await checkKeyManagerUpdate();
      setUpdate(status);
      notify(status.available ? `Có bản mới ${status.latestVersion}` : "Key Manager đang ở bản mới nhất");
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setBusy(null);
    }
  }

  async function installUpdate() {
    if (!update?.available || !window.confirm(`Cập nhật Key Manager lên ${update.latestVersion}? Ứng dụng sẽ tự đóng và mở lại.`)) return;
    try {
      setBusy("install-update");
      await installKeyManagerUpdate();
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
      setBusy(null);
    }
  }

  function openProfile(application: Application) {
    setEditing(profileByApplication.get(application.id) ?? blankProfile(application));
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config || !editing) return;
    const data = new FormData(event.currentTarget);
    const profile: ExternalReleaseProfile = {
      ...editing,
      sourceDir: String(data.get("sourceDir") || "").trim(),
      buildCommand: String(data.get("buildCommand") || "").trim(),
      outputDir: String(data.get("outputDir") || "").trim(),
      versionFile: String(data.get("versionFile") || "").trim(),
      versionField: String(data.get("versionField") || "").trim(),
      artifactPatterns: splitPatterns(String(data.get("artifactPatterns") || "")),
      manifestPatterns: splitPatterns(String(data.get("manifestPatterns") || "")),
      r2Bucket: String(data.get("r2Bucket") || "").trim(),
      r2Prefix: String(data.get("r2Prefix") || "").trim(),
    };
    const externalProfiles = config.externalProfiles.filter((item) => item.applicationId !== profile.applicationId);
    const next = { ...config, externalProfiles: [...externalProfiles, profile] };
    setConfig(next);
    setEditing(null);
    await saveConfig(next);
  }

  async function packageExternal(application: Application) {
    try {
      setBusy(`external:${application.id}`);
      const result = await packageExternalApplication(application.id);
      setLog(resultSummary(result));
      notify(`Đã build & publish ${application.name} ${result.version}`, result.destination);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setBusy(null);
    }
  }

  if (!config) {
    return <div className="page"><div className="panel release-loading">Đang tải Build & Update…</div></div>;
  }

  return (
    <div className="page release-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow dark">BUILD & UPDATE</span>
          <h1>Đóng gói & cập nhật</h1>
          <p>Key Manager phát hành local; các Desktop App khác build rồi publish trực tiếp lên Cloudflare R2.</p>
        </div>
      </div>

      <section className="panel release-panel release-local-panel">
        <div className="release-panel-heading">
          <div>
            <h2>Key Manager · LOCAL</h2>
            <p>Nhập version mới và release notes. Key Manager tự đồng bộ source, build NSIS và publish release hoàn chỉnh.</p>
          </div>
          <span className="release-mode local">LOCAL</span>
        </div>

        <form className="release-local-form" onSubmit={(event) => void runKeyManagerPackage(event)}>
          <div className="release-current-version">
            <span>Version hiện tại</span>
            <strong>{update?.currentVersion ?? "0.1.0"}</strong>
          </div>
          <Field label="Version mới" hint="SemVer dạng major.minor.patch, ví dụ 0.1.1">
            <input
              value={newVersion}
              onChange={(event) => setNewVersion(event.target.value)}
              placeholder="0.1.1"
              autoComplete="off"
              required
            />
          </Field>
          <Field label="Release notes" hint="Nội dung này được ghi vào manifest local của release">
            <textarea
              value={releaseNotes}
              onChange={(event) => setReleaseNotes(event.target.value)}
              rows={5}
              placeholder="Mô tả ngắn những thay đổi trong bản mới…"
              required
            />
          </Field>
          <div className="release-actions primary-flow">
            <button className="button primary" type="submit" disabled={Boolean(busy) || !newVersion.trim() || !releaseNotes.trim()}>
              <PackageIcon size={17} /> {busy === "key-manager-package" ? "Đang đóng gói…" : "Đóng gói bản mới"}
            </button>
          </div>
        </form>

        <details className="release-advanced">
          <summary>Advanced settings</summary>
          <p className="release-advanced-note">Chỉ cần mở khi đổi máy build hoặc thay cấu trúc source/output.</p>
          <div className="form-grid two">
            <Field label="Source folder"><input value={config.keyManagerSourceDir} onChange={(event) => setConfig({ ...config, keyManagerSourceDir: event.target.value })} /></Field>
            <Field label="Update folder"><input value={config.keyManagerUpdateDir} onChange={(event) => setConfig({ ...config, keyManagerUpdateDir: event.target.value })} /></Field>
            <Field label="Build command"><input value={config.keyManagerBuildCommand} onChange={(event) => setConfig({ ...config, keyManagerBuildCommand: event.target.value })} /></Field>
            <Field label="Build output"><input value={config.keyManagerOutputDir} onChange={(event) => setConfig({ ...config, keyManagerOutputDir: event.target.value })} /></Field>
          </div>
          <div className="release-actions">
            <button className="button ghost" type="button" disabled={Boolean(busy)} onClick={() => void saveConfig()}>
              <CheckIcon size={17} /> {busy === "save" ? "Đang lưu…" : "Lưu Advanced settings"}
            </button>
          </div>
        </details>

        <div className="release-status-grid">
          <div><span>Version local mới nhất</span><strong>{update?.latestVersion ?? "Chưa có"}</strong></div>
          <div><span>Installer</span><strong>{update?.installerName ?? "—"}</strong><small>{formatFileSize(update?.installerSize)}</small></div>
          <div><span>Kho update</span><strong>{config.keyManagerUpdateDir}</strong></div>
        </div>
        <div className="release-update-actions">
          <button className="button ghost" type="button" disabled={Boolean(busy)} onClick={() => void checkUpdate()}>
            <RefreshIcon size={17} /> {busy === "check-update" ? "Đang kiểm tra…" : "Kiểm tra cập nhật"}
          </button>
          {update?.available ? (
            <button className="button primary" type="button" disabled={Boolean(busy)} onClick={() => void installUpdate()}>
              Cập nhật lên {update.latestVersion}
            </button>
          ) : null}
        </div>
      </section>

      <section className="panel release-panel">
        <div className="release-panel-heading">
          <div>
            <h2>Ứng dụng khác · R2</h2>
            <p>Mỗi app có source/build/output riêng. Artifact upload trước, manifest như latest.yml upload cuối.</p>
          </div>
          <span className="release-mode r2">R2</span>
        </div>
        <div className="r2-secret-note">
          R2 secret không lưu trong UI. Máy build phải có <code>R2_ACCOUNT_ID</code>, <code>R2_ACCESS_KEY_ID</code>, <code>R2_SECRET_ACCESS_KEY</code>.
        </div>
        <div className="release-app-list">
          {applications.map((application) => {
            const profile = profileByApplication.get(application.id);
            return (
              <div className="release-app-row" key={application.id}>
                <div className="cell-title">
                  <span className="app-avatar large-avatar">{application.appCode.slice(0, 2)}</span>
                  <div><strong>{application.name}</strong><small>{application.appCode} · {application.currentVersion || "chưa có version"}</small></div>
                </div>
                <div className="release-profile-summary">
                  {profile ? <><strong>{profile.r2Bucket}</strong><small>{profile.buildCommand}</small></> : <span>Chưa cấu hình build/R2</span>}
                </div>
                <div className="release-row-actions">
                  <button className="button ghost" type="button" onClick={() => openProfile(application)}>Cấu hình</button>
                  <button className="button primary" type="button" disabled={!profile || Boolean(busy)} onClick={() => void packageExternal(application)}>
                    <UploadIcon size={16} /> {busy === `external:${application.id}` ? "Đang publish…" : "Đóng gói & Upload R2"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {log ? <section className="panel release-log"><div className="release-panel-heading"><div><h2>Build / Publish log</h2><p>Output gần nhất để đối chiếu khi build hoặc upload lỗi.</p></div></div><pre>{log}</pre></section> : null}

      {editing ? (
        <Modal title={`Cấu hình release · ${editing.appCode}`} subtitle="Cấu hình này chỉ lưu local trên máy chạy Key Manager." onClose={() => setEditing(null)} wide>
          <form className="modal-form" onSubmit={(event) => void saveProfile(event)}>
            <div className="form-grid two">
              <Field label="Source folder"><input name="sourceDir" defaultValue={editing.sourceDir} required /></Field>
              <Field label="Build output"><input name="outputDir" defaultValue={editing.outputDir} required /></Field>
            </div>
            <Field label="Build command"><input name="buildCommand" defaultValue={editing.buildCommand} required /></Field>
            <div className="form-grid two">
              <Field label="Version file"><input name="versionFile" defaultValue={editing.versionFile} required /></Field>
              <Field label="Version field"><input name="versionField" defaultValue={editing.versionField} required /></Field>
            </div>
            <div className="form-grid two">
              <Field label="Artifact patterns" hint="Phân cách bằng dấu phẩy, ; hoặc xuống dòng"><textarea name="artifactPatterns" rows={3} defaultValue={joinPatterns(editing.artifactPatterns)} required /></Field>
              <Field label="Manifest/publish pointer" hint="Các file này luôn upload cuối"><textarea name="manifestPatterns" rows={3} defaultValue={joinPatterns(editing.manifestPatterns)} required /></Field>
            </div>
            <div className="form-grid two">
              <Field label="R2 bucket"><input name="r2Bucket" defaultValue={editing.r2Bucket} required /></Field>
              <Field label="R2 prefix"><input name="r2Prefix" defaultValue={editing.r2Prefix} placeholder="page-auto" /></Field>
            </div>
            <div className="modal-actions">
              <button className="button ghost" type="button" onClick={() => setEditing(null)}>Hủy</button>
              <button className="button primary" type="submit"><CheckIcon size={17} /> Lưu cấu hình</button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
