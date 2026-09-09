-- 0005_admin_sessions.sql

CREATE TABLE admin_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_admin_sessions_token_hash UNIQUE (token_hash),
  CONSTRAINT ck_admin_sessions_token_hash CHECK (octet_length(token_hash) = 32),
  CONSTRAINT ck_admin_sessions_expiry CHECK (expires_at > created_at),
  CONSTRAINT ck_admin_sessions_last_seen CHECK (last_seen_at >= created_at),
  CONSTRAINT ck_admin_sessions_revoked_at CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CONSTRAINT ck_admin_sessions_user_agent CHECK (user_agent IS NULL OR btrim(user_agent) <> '')
);

CREATE INDEX idx_admin_sessions_admin_active
  ON admin_sessions (admin_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX idx_admin_sessions_expiry
  ON admin_sessions (expires_at)
  WHERE revoked_at IS NULL;
