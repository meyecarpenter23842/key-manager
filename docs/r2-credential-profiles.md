# R2 Credential Profiles

Key Manager can store multiple Cloudflare R2 credential sets on the Windows machine that performs Desktop App releases.

## Why

A single process-wide `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` is not practical when different Desktop Apps publish to different Cloudflare accounts or access tokens. Credential Profiles let each application select its own saved R2 identity while keeping the existing environment-variable flow as a CI fallback.

## Storage and security

Saved R2 profiles are not written into `release-manager.json` and are never stored as plaintext.

Key Manager serializes the local credential vault and encrypts the entire payload with Windows DPAPI under the current Windows user. The encrypted file is stored under the Tauri app config directory as:

```text
r2-credentials.dat
```

Consequences:

- another Windows user cannot normally decrypt the vault;
- copying the encrypted file to another machine/user is not a credential migration mechanism;
- the frontend never receives the full Access Key ID or Secret Access Key after save;
- list responses expose only profile name, Account ID, a masked Access Key preview and whether a secret exists;
- editing a profile may leave Access Key ID / Secret blank to preserve the existing encrypted values.

DPAPI protects credentials at rest for the local Windows operator account. It does not protect against malware or an already-compromised Windows user session.

## Application binding

Each application may bind to one R2 Credential Profile. The binding is stored inside the encrypted vault together with the credentials.

When publishing an external application:

1. Key Manager resolves the selected R2 profile before starting the build.
2. The application build command runs without injecting the saved R2 secrets.
3. After artifacts are validated, Key Manager decrypts the selected values in memory.
4. `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` are added only to the `r2-upload.mjs` child process.
5. Artifact files are uploaded first and manifest/publish-pointer files are uploaded last as before.

A credential profile cannot be deleted while an application is bound to it.

## CI fallback

If an application has no saved R2 profile selected, the existing environment variables remain supported:

```text
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
```

This is intended for CI or build machines where secrets are injected by the runner. Saved local profiles take precedence whenever an application is bound to one.

## Example

For Salon:

```text
R2 account: Beauty Salon
R2 bucket: beauty-salon
R2 prefix: (empty when latest.json lives at the bucket root)
```

For another application using a different Cloudflare identity:

```text
R2 account: Page Auto
R2 bucket: page-auto
R2 prefix: releases
```

No R2 secret is required in Windows Environment for either app once its local credential profile is saved and selected.
