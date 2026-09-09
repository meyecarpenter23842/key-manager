# Offline License Signing v1

Phase 7 adds a bounded offline entitlement to the existing Public License API without changing request payloads or database schema. Signing is asymmetric Ed25519: the Key Manager server owns the private key and Desktop Apps embed only one or more trusted public keys.

## Server configuration

Offline signing is disabled unless `OFFLINE_SIGNING_ENABLED=true`.

Required when enabled:

- `OFFLINE_SIGNING_KEY_ID`: stable identifier for the active Ed25519 signing key, 1-64 safe characters.
- Exactly one of:
  - `OFFLINE_SIGNING_PRIVATE_KEY_FILE`: path to a PKCS#8 PEM private key supplied by a server secret mount/file provider. This is preferred.
  - `OFFLINE_SIGNING_PRIVATE_KEY`: PKCS#8 PEM private key supplied by a server-only secret environment variable. Literal `\n` sequences are accepted.

Never put the private key in `VITE_*`, the frontend bundle, a Desktop App, logs, API responses, source control, or plaintext database columns. When signing is enabled, server startup fails if the key id is missing, both key sources are set, the key cannot be read, or the key is not a valid Ed25519 private key.

Example key generation for a deployment operator:

```powershell
openssl genpkey -algorithm ED25519 -out key-manager-offline-private.pem
openssl pkey -in key-manager-offline-private.pem -pubout -out key-manager-offline-public.pem
```

Store the private file in the server secret store/mount outside the repository. The corresponding public key may be embedded in Desktop Apps.

## API response

When signing is enabled and the application's `offlineGraceSeconds` is greater than zero, successful `activate`, `validate`, and `heartbeat` responses gain an additive `offline` object:

```json
{
  "offline": {
    "token": "base64url(header).base64url(payload).base64url(signature)",
    "algorithm": "Ed25519",
    "keyId": "km-ed25519-2026-01",
    "issuedAt": "2030-01-01T00:00:00.000Z",
    "offlineValidUntil": "2030-01-02T00:00:00.000Z"
  }
}
```

`deactivate` never issues a replacement offline token. If `offlineGraceSeconds=0`, the application remains online-only and no `offline` object is returned. If signing is disabled globally, Phase 6 response shape remains unchanged.

## Signed token contract

The compact token uses a JWS-style three-segment representation. The signature covers the exact ASCII bytes of `base64url(header) + "." + base64url(payload)` using Ed25519.

Header:

```json
{
  "alg": "EdDSA",
  "typ": "KM-OFFLINE",
  "kid": "km-ed25519-2026-01"
}
```

Payload schema v1:

```json
{
  "schema_version": 1,
  "license_id": "license-uuid",
  "app_id": "application-uuid",
  "app_code": "DESKTOP_PRO",
  "device_id": "stable-device-fingerprint",
  "issued_at": "2030-01-01T00:00:00.000Z",
  "expires_at": "2030-02-01T00:00:00.000Z",
  "offline_valid_until": "2030-01-02T00:00:00.000Z"
}
```

For lifetime licenses, `expires_at` is `null`. Lifetime does not mean unlimited offline use: `offline_valid_until` still bounds the entitlement. For subscriptions, `offline_valid_until` is the earlier of application grace (`issued_at + offlineGraceSeconds`) and the subscription `expires_at`.

The payload never contains the raw license key or its hash. It is bound to application + license + device. A Desktop App must reject a cryptographically valid token when its expected `app_id`/`app_code`, `license_id`, or `device_id` does not match.

## Refresh strategy

Every successful online `activate`, `validate`, or `heartbeat` is a refresh point and replaces the previously stored offline token. A Desktop App should normally heartbeat while online and atomically persist the newest token together with the successful response's `serverTime` and its local trusted-time state.

When the device reconnects, it must call the normal online API before extending offline use. The server re-evaluates application status, license status/expiry, minimum version, and device status before issuing a new token. Clients cannot create, modify, or extend an entitlement themselves because they do not possess the private key.

## Revocation semantics

A server cannot instantly revoke a previously signed token while the machine is completely offline. The maximum revocation delay is therefore the remaining time until `offline_valid_until`.

Consequences:

- Keep `offlineGraceSeconds` intentionally short and application-specific.
- License `REVOKED`, `ARCHIVED`, or `EXPIRED` receives no new token.
- Device `REVOKED` receives no new token and cannot self-reactivate.
- As soon as connectivity returns, `validate`/`heartbeat` must be attempted; a revoke then takes effect immediately through the online API.
- A token already issued before the revoke may remain usable offline only until its signed boundary. This is an explicit availability-versus-revocation tradeoff, not immediate revocation.

## Desktop clock and rollback handling

Signature verification alone does not make the local system clock trustworthy. Do not implement offline acceptance as only `Date.now() < offline_valid_until`.

Recommended MVP state after every successful online response:

- signed token;
- `serverTime` from that response (which equals the token `issued_at` for refreshed offline entitlements);
- current wall-clock sample;
- current monotonic-clock sample for the running process;
- a persisted high-water mark of the greatest trusted time already observed.

While the same process is running, estimate trusted time as `serverTimeAtSync + monotonicElapsed`, not from the wall clock. Persist the trusted-time high-water mark periodically and on clean shutdown.

After restart while offline, monotonic time has reset. Use the persisted online wall-clock anchor only as a bounded fallback:

1. If the current wall clock moved backwards beyond a small tolerance relative to the stored wall-clock/high-water state, treat it as rollback and require an online refresh.
2. Otherwise derive a candidate from the last server-time anchor plus non-negative wall-clock elapsed time.
3. Clamp the candidate so trusted time never moves below the persisted high-water mark.
4. Reject offline use once trusted time reaches `offline_valid_until` (or `expires_at`, which the server already caps into that boundary).
5. If trusted-time state is missing, corrupt, inconsistent, or suspicious, fail closed to online validation instead of granting a new grace window.

This is an MVP mitigation, not absolute anti-tamper security. A hostile user with full control of local storage can still attack persisted clock state. Stronger future options include OS-protected storage, TPM/secure enclave counters, or short grace windows combined with frequent online refresh.

## Key rotation

`kid` identifies the key used for a token. Desktop Apps should ship a small public-key ring keyed by `kid`.

Safe rotation order:

1. Release Desktop versions containing both the current public key and the next public key.
2. Wait until the required client population has the new public key.
3. Change the server active private key and `OFFLINE_SIGNING_KEY_ID` to the new key.
4. Keep the previous public key in clients at least until every token signed by it must have passed `offline_valid_until`.
5. Remove the old public key in a later Desktop release.

The server only needs the active private signing key for Phase 7. Old private keys do not need to remain online merely to validate client tokens; Desktop verification uses public keys.
