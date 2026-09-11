import { useEffect, useMemo, useState, type FormEvent } from "react";

import { listApplications } from "./api";
import { Field, Modal, type ErrorHandler, type Notify } from "./components";
import { CheckIcon, RefreshIcon } from "./icons";
import { PackageIcon, UploadIcon } from "./releaseIcons";
import type { Application } from "./types";
import {
  bindR2CredentialProfile,
  checkKeyManagerUpdate,
  deleteKeyManagerDraftRelease,
  deleteR2CredentialProfile,
  getExternalReleaseStatus,
  getReleaseManagerConfig,
  installKeyManagerUpdate,
  listR2CredentialProfiles,
  packageExternalApplication,
  packageKeyManager,
  saveR2CredentialProfile,
  saveReleaseManagerConfig,
  type ExternalReleaseProfile,
  type PackageResult,
  type R2CredentialProfileSummary,
  type R2CredentialState,
  type ReleaseManagerConfig,
  type SelfUpdateStatus,
} from "./releaseManager";
import { formatFileSize, joinPatterns, nextPatchVersion, splitPatterns } from "./releaseUi";

interface R2CredentialEditor {
  id: string | null;
  name: string;
  accountId: string;
  accessKeyPreview: string;
  hasSecret: boolean;
}

interface ExternalPublishEditor {
  application: Application;
  currentVersion: string;
  newVersion: string;
  releaseNotes: string;
  destination: string;
}

const emptyR2State: R2CredentialState = { profiles: [], bindings: [] };

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

function blankR2Editor(): R2CredentialEditor {
  return { id: null, name: "", accountId: "", accessKeyPreview: "", hasSecret: false };
}

function editorFromR2Profile(profile: R2CredentialProfileSummary): R2CredentialEditor {
  return {
    id: profile.id,
    name: profile.name,
    accountId: profile.accountId,
    accessKeyPreview: profile.accessKeyPreview,
    hasSecret: profile.hasSecret,
  };
}

function resultSummary(result: PackageResult): string {
  const files = result.artifacts.map((artifact) => `${artifact.name} (${formatFileSize(artifact.size)})`).join("\n");
  return `${result.appCode} ${result.version}\n${result.destination}\n${files}\n\n${result.log}`.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ReleaseManagerPage({ onError, notify }: { onError: ErrorHandler; notify: Notify }) {
  const [config, setConfig] = useState<ReleaseManagerConfig | null>(null);
  const [applications, setApplications] = useState<Application[]>([]);
  const [r2State, setR2State] = useState<R2CredentialState>(emptyR2State);
  const [update, setUpdate] = useState<SelfUpdateStatus | null>(null);
  const [newVersion, setNewVersion] = useState("");
  const [releaseNotes, setReleaseNotes] = useState("");
  const [conflictVersion, setConflictVersion] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<ExternalPublishEditor | null>(null);
  const [editing, setEditing] = useState<ExternalReleaseProfile | null>(null);
  const [editingR2, setEditingR2] = useState<R2CredentialEditor | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState("");

  useEffect(() => {
    void Promise.all([
      getReleaseManagerConfig(),
      listApplications({ limit: 100, offset: 0 }),
      listR2CredentialProfiles().catch((error) => {
        onError(error instanceof Error ? error : new Error(String(error)));
        return emptyR2State;
      }),
      checkKeyManagerUpdate().catch(() => null),
    ])
      .then(([loadedConfig, loadedApplications, loadedR2State, loadedUpdate]) => {
        setConfig(loadedConfig);
        setApplications(loadedApplications.applications);
        setR2State(loadedR2State);
        setUpdate(loadedUpdate);
        setNewVersion((current) => current || nextPatchVersion(loadedUpdate?.currentVersion));
      })
      .catch(onError);
  }, [onError]);

  const profileByApplication = useMemo(
    () => new Map((config?.externalProfiles ?? []).map((profile) => [profile.applicationId, profile])),
    [config],
  );

  const r2ProfileById = useMemo(
    () => new Map(r2State.profiles.map((profile) => [profile.id, profile])),
    [r2State.profiles],
  );

  const r2BindingByApplication = useMemo(
    () => new Map(r2State.bindings.map((binding) => [binding.applicationId, binding.credentialProfileId])),
    [r2State.bindings],
  );

  const r2UsageCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const binding of r2State.bindings) {
      counts.set(binding.credentialProfileId, (counts.get(binding.credentialProfileId) ?? 0) + 1);
    }
    return counts;
  }, [r2State.bindings]);

  async function refreshR2State() {
    const next = await listR2CredentialProfiles();
    setR2State(next);
    return next;
  }

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
      setConflictVersion(null);
      const result = await packageKeyManager(version, notes);
      setLog(resultSummary(result));
      notify(`Đã đóng gói Key Manager ${result.version}`, result.destination);
      const nextUpdate = await checkKeyManagerUpdate();
      setUpdate(nextUpdate);
      setNewVersion(nextPatchVersion(result.version));
      setReleaseNotes("");
    } catch (error) {
      const message = errorMessage(error);
      setLog(message);
      if (message.includes("RELEASE_ALREADY_EXISTS:")) {
        setConflictVersion(version);
      }
      onError(error instanceof Error ? error : new Error(message));
    } finally {
      setBusy(null);
    }
  }

  async function deleteConflictingRelease() {
    if (!conflictVersion) return;
    if (!window.confirm(`Xóa release nháp ${conflictVersion}? Chỉ release không phải latest/source/running version mới được phép xóa.`)) return;
    try {
      setBusy("delete-draft-release");
      await deleteKeyManagerDraftRelease(conflictVersion);
      notify(`Đã xóa release nháp ${conflictVersion}`, "Có thể bấm Đóng gói bản mới lại với cùng version.");
      setConflictVersion(null);
      setUpdate(await checkKeyManagerUpdate());
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
    const selectedR2ProfileId = String(data.get("r2CredentialProfileId") || "").trim() || null;
    const externalProfiles = config.externalProfiles.filter((item) => item.applicationId !== profile.applicationId);
    const next = { ...config, externalProfiles: [...externalProfiles, profile] };

    try {
      setBusy("save-external-profile");
      const saved = await saveReleaseManagerConfig(next);
      await bindR2CredentialProfile(profile.applicationId, selectedR2ProfileId);
      setConfig(saved);
      await refreshR2State();
      setEditing(null);
      notify(`Đã lưu cấu hình ${profile.appCode}`);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setBusy(null);
    }
  }

  async function saveR2Profile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingR2) return;
    const data = new FormData(event.currentTarget);
    try {
      setBusy("save-r2-profile");
      await saveR2CredentialProfile({
        id: editingR2.id,
        name: String(data.get("name") || "").trim(),
        accountId: String(data.get("accountId") || "").trim(),
        accessKeyId: String(data.get("accessKeyId") || "").trim(),
        secretAccessKey: String(data.get("secretAccessKey") || "").trim(),
      });
      await refreshR2State();
      setEditingR2(null);
      notify(editingR2.id ? "Đã cập nhật tài khoản R2" : "Đã thêm tài khoản R2");
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setBusy(null);
    }
  }

  async function deleteR2Profile(profile: R2CredentialProfileSummary) {
    const usedBy = r2UsageCount.get(profile.id) ?? 0;
    if (usedBy > 0) {
      notify("Không thể xóa tài khoản R2 đang được sử dụng", `Hãy đổi tài khoản R2 cho ${usedBy} ứng dụng đang dùng profile này trước.`);
      return;
    }
    if (!window.confirm(`Xóa tài khoản R2 “${profile.name}”? Secret đã lưu trên máy này cũng sẽ bị xóa.`)) return;

    try {
      setBusy(`delete-r2:${profile.id}`);
      await deleteR2CredentialProfile(profile.id);
      await refreshR2State();
      notify(`Đã xóa tài khoản R2 ${profile.name}`);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setBusy(null);
    }
  }

  async function openExternalPublish(application: Application) {
    try {
      setBusy(`external-status:${application.id}`);
      const status = await getExternalReleaseStatus(application.id);
      setLog("");
      setPublishing({
        application,
        currentVersion: status.currentVersion,
        newVersion: nextPatchVersion(status.currentVersion),
        releaseNotes: "",
        destination: status.destination,
      });
    } catch (error) {
      const message = errorMessage(error);
      setLog(message);
      onError(error instanceof Error ? error : new Error(message));
    } finally {
      setBusy(null);
    }
  }

  async function runExternalPackage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!publishing) return;
    const version = publishing.newVersion.trim();
    const notes = publishing.releaseNotes.trim();
    if (!version || !notes) return;
    const application = publishing.application;
    try {
      setBusy(`external:${application.id}`);
      setLog("");
      const result = await packageExternalApplication(application.id, version, notes);
      setLog(resultSummary(result));
      setApplications((current) => current.map((item) => item.id === application.id ? { ...item, currentVersion: result.version } : item));
      setPublishing(null);
      notify(`Đã build & publish ${application.name} ${result.version}`, result.destination);
    } catch (error) {
      const message = errorMessage(error);
      setLog(message);
      onError(error instanceof Error ? error : new Error(message));
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
              onChange={(event) => {
                setNewVersion(event.target.value);
                if (conflictVersion && event.target.value.trim() !== conflictVersion) setConflictVersion(null);
              }}
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

        {conflictVersion ? (
          <div className="release-conflict" role="status">
            <div>
              <strong>Release {conflictVersion} đã tồn tại nhưng chưa được publish làm bản mới nhất.</strong>
              <small>Key Manager không tự ghi đè release cũ. Nếu đây là release nháp/lỗi từ lần test trước, xóa nó rồi đóng gói lại.</small>
            </div>
            <button className="button danger-soft" type="button" disabled={Boolean(busy)} onClick={() => void deleteConflictingRelease()}>
              {busy === "delete-draft-release" ? "Đang xóa…" : `Xóa release nháp ${conflictVersion}`}
            </button>
          </div>
        ) : null}

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
          <button
            className={update?.available ? "button primary" : "button secondary"}
            type="button"
            disabled={Boolean(busy) || !update?.available}
            onClick={() => void installUpdate()}
          >
            {update?.available
              ? `Cập nhật lên ${update.latestVersion}`
              : update
                ? "Không có bản cập nhật mới"
                : "Chưa có dữ liệu cập nhật"}
          </button>
        </div>
      </section>

      <section className="panel release-panel">
        <div className="release-panel-heading">
          <div>
            <h2>Ứng dụng khác · R2</h2>
            <p>Cấu hình source/build/output là cố định; version mới và release notes chỉ nhập khi phát hành. Artifact upload trước, manifest upload cuối.</p>
          </div>
          <span className="release-mode r2">R2</span>
        </div>

        <div className="r2-secret-note">
          Tài khoản R2 được lưu riêng trên máy này và mã hóa bằng Windows DPAPI. Secret không trả lại frontend sau khi lưu. Nếu một ứng dụng không chọn tài khoản R2, Key Manager mới dùng <code>R2_ACCOUNT_ID</code>, <code>R2_ACCESS_KEY_ID</code>, <code>R2_SECRET_ACCESS_KEY</code> làm fallback cho CI.
        </div>

        <div className="r2-vault">
          <div className="r2-vault-heading">
            <div>
              <strong>Tài khoản R2</strong>
              <small>Thêm nhiều tài khoản rồi chọn đúng tài khoản trong cấu hình từng ứng dụng.</small>
            </div>
            <button className="button ghost" type="button" disabled={Boolean(busy)} onClick={() => setEditingR2(blankR2Editor())}>
              + Thêm tài khoản R2
            </button>
          </div>

          {r2State.profiles.length ? (
            <div className="r2-profile-grid">
              {r2State.profiles.map((profile) => {
                const usedBy = r2UsageCount.get(profile.id) ?? 0;
                return (
                  <div className="r2-profile-card" key={profile.id}>
                    <div className="r2-profile-main">
                      <strong>{profile.name}</strong>
                      <small>Account: {profile.accountId}</small>
                      <small>Access key: {profile.accessKeyPreview} · Secret: {profile.hasSecret ? "Đã lưu" : "Chưa có"}</small>
                      <span>{usedBy ? `${usedBy} ứng dụng đang dùng` : "Chưa gắn ứng dụng"}</span>
                    </div>
                    <div className="r2-profile-actions">
                      <button className="button ghost" type="button" disabled={Boolean(busy)} onClick={() => setEditingR2(editorFromR2Profile(profile))}>Sửa</button>
                      <button className="button danger-soft" type="button" disabled={Boolean(busy) || usedBy > 0} onClick={() => void deleteR2Profile(profile)}>Xóa</button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="r2-profile-empty">Chưa có tài khoản R2. Thêm tài khoản đầu tiên để không phải cấu hình secret trong Windows Environment.</div>
          )}
        </div>

        <div className="release-app-list">
          {applications.map((application) => {
            const profile = profileByApplication.get(application.id);
            const credentialId = r2BindingByApplication.get(application.id);
            const credential = credentialId ? r2ProfileById.get(credentialId) : null;
            return (
              <div className="release-app-row" key={application.id}>
                <div className="cell-title">
                  <span className="app-avatar large-avatar">{application.appCode.slice(0, 2)}</span>
                  <div><strong>{application.name}</strong><small>{application.appCode} · {application.currentVersion || "chưa có version"}</small></div>
                </div>
                <div className="release-profile-summary">
                  {profile ? (
                    <>
                      <strong>{profile.r2Bucket}</strong>
                      <small>{credential ? `R2: ${credential.name}` : credentialId ? "R2 profile không còn tồn tại" : "R2: ENV / CI fallback"}</small>
                      <small>{profile.buildCommand}</small>
                    </>
                  ) : <span>Chưa cấu hình build/R2</span>}
                </div>
                <div className="release-row-actions">
                  <button className="button ghost" type="button" disabled={Boolean(busy)} onClick={() => openProfile(application)}>Cấu hình</button>
                  <button className="button primary" type="button" disabled={!profile || Boolean(busy)} onClick={() => void openExternalPublish(application)}>
                    <UploadIcon size={16} /> {busy === `external-status:${application.id}` ? "Đang đọc version…" : busy === `external:${application.id}` ? "Đang publish…" : "Phát hành R2"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {log ? <section className="panel release-log"><div className="release-panel-heading"><div><h2>Build / Publish log</h2><p>Output gần nhất, kể cả khi build/validate/upload lỗi.</p></div></div><pre>{log}</pre></section> : null}

      {publishing ? (
        <Modal title={`Phát hành · ${publishing.application.name}`} subtitle={`${publishing.application.appCode} · ${publishing.destination}`} onClose={() => setPublishing(null)} wide>
          <form className="modal-form" onSubmit={(event) => void runExternalPackage(event)}>
            <div className="release-current-version"><span>Version hiện tại</span><strong>{publishing.currentVersion}</strong></div>
            <Field label="Version mới" hint="SemVer major.minor.patch; phải lớn hơn version hiện tại">
              <input value={publishing.newVersion} onChange={(event) => setPublishing((current) => current ? { ...current, newVersion: event.target.value } : current)} placeholder={nextPatchVersion(publishing.currentVersion) || "1.0.1"} autoComplete="off" required />
            </Field>
            <Field label="Release notes" hint="Được truyền vào build và manifest JSON tương thích">
              <textarea value={publishing.releaseNotes} onChange={(event) => setPublishing((current) => current ? { ...current, releaseNotes: event.target.value } : current)} rows={5} placeholder="Mô tả ngắn những thay đổi trong bản mới…" required />
            </Field>
            <div className="r2-secret-note">Flow: bump version → build → validate → upload artifact → upload manifest cuối. Nếu fail, source version được rollback và log lỗi vẫn được giữ.</div>
            {log ? (
              <div className="release-modal-log" aria-live="polite">
                <strong>Build / Publish log</strong>
                <pre>{log}</pre>
              </div>
            ) : null}
            <div className="modal-actions">
              <button className="button ghost" type="button" onClick={() => setPublishing(null)}>Hủy</button>
              <button className="button primary" type="submit" disabled={Boolean(busy) || !publishing.newVersion.trim() || !publishing.releaseNotes.trim()}><UploadIcon size={17} /> {busy === `external:${publishing.application.id}` ? "Đang build & publish…" : "Đóng gói & Upload R2"}</button>
            </div>
          </form>
        </Modal>
      ) : null}

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
            <Field label="Tài khoản R2" hint="Chọn tài khoản đã lưu; để ENV / CI nếu máy build tự cấp R2_* environment variables.">
              <select name="r2CredentialProfileId" defaultValue={r2BindingByApplication.get(editing.applicationId) ?? ""}>
                <option value="">ENV / CI fallback</option>
                {r2State.profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name} · {profile.accountId}</option>)}
              </select>
            </Field>
            <div className="form-grid two">
              <Field label="R2 bucket"><input name="r2Bucket" defaultValue={editing.r2Bucket} required /></Field>
              <Field label="R2 prefix"><input name="r2Prefix" defaultValue={editing.r2Prefix} placeholder="Để trống nếu publish ở root bucket" /></Field>
            </div>
            <div className="modal-actions">
              <button className="button ghost" type="button" onClick={() => setEditing(null)}>Hủy</button>
              <button className="button primary" type="submit" disabled={Boolean(busy)}><CheckIcon size={17} /> {busy === "save-external-profile" ? "Đang lưu…" : "Lưu cấu hình"}</button>
            </div>
          </form>
        </Modal>
      ) : null}

      {editingR2 ? (
        <Modal
          title={editingR2.id ? `Sửa tài khoản R2 · ${editingR2.name}` : "Thêm tài khoản R2"}
          subtitle="Credential được mã hóa bằng Windows DPAPI và chỉ dùng trên user Windows hiện tại."
          onClose={() => setEditingR2(null)}
        >
          <form className="modal-form" onSubmit={(event) => void saveR2Profile(event)}>
            <Field label="Tên tài khoản"><input name="name" defaultValue={editingR2.name} placeholder="Ví dụ: Beauty Salon" required /></Field>
            <Field label="Account ID"><input name="accountId" defaultValue={editingR2.accountId} autoComplete="off" required /></Field>
            <Field label="Access Key ID" hint={editingR2.id ? `Đang lưu ${editingR2.accessKeyPreview}. Để trống nếu không đổi.` : undefined}>
              <input name="accessKeyId" autoComplete="off" required={!editingR2.id} placeholder={editingR2.id ? "Để trống để giữ key cũ" : "R2 Access Key ID"} />
            </Field>
            <Field label="Secret Access Key" hint={editingR2.id && editingR2.hasSecret ? "Secret đã được lưu. Để trống nếu không đổi." : undefined}>
              <input name="secretAccessKey" type="password" autoComplete="new-password" required={!editingR2.id} placeholder={editingR2.id ? "Để trống để giữ secret cũ" : "R2 Secret Access Key"} />
            </Field>
            <div className="modal-actions">
              <button className="button ghost" type="button" onClick={() => setEditingR2(null)}>Hủy</button>
              <button className="button primary" type="submit" disabled={Boolean(busy)}><CheckIcon size={17} /> {busy === "save-r2-profile" ? "Đang lưu…" : "Lưu tài khoản R2"}</button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
