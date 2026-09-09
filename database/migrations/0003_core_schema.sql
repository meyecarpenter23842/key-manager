-- 0003_core_schema.sql

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  role admin_role NOT NULL DEFAULT 'STAFF',
  status admin_status NOT NULL DEFAULT 'ACTIVE',
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_admins_email_not_blank CHECK (btrim(email) <> ''),
  CONSTRAINT ck_admins_password_hash_not_plain CHECK (char_length(password_hash) >= 20)
);

CREATE TABLE applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  app_code varchar(32) NOT NULL,
  description text,
  current_version varchar(64),
  minimum_version varchar(64),
  status application_status NOT NULL DEFAULT 'ACTIVE',
  offline_grace_seconds integer NOT NULL DEFAULT 86400,
  default_device_limit smallint NOT NULL DEFAULT 1,
  default_duration_days integer NOT NULL DEFAULT 30,
  allow_lifetime boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_applications_app_code UNIQUE (app_code),
  CONSTRAINT ck_applications_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT ck_applications_app_code_format CHECK (app_code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  CONSTRAINT ck_applications_offline_grace CHECK (offline_grace_seconds BETWEEN 0 AND 2592000),
  CONSTRAINT ck_applications_default_device_limit CHECK (default_device_limit > 0),
  CONSTRAINT ck_applications_default_duration CHECK (default_duration_days > 0)
);

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text,
  email text,
  company text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_customers_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT ck_customers_phone_not_blank CHECK (phone IS NULL OR btrim(phone) <> ''),
  CONSTRAINT ck_customers_email_not_blank CHECK (email IS NULL OR btrim(email) <> '')
);

CREATE TABLE licenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  license_key_hash bytea NOT NULL,
  license_key_preview varchar(32) NOT NULL,
  license_type license_type NOT NULL,
  expires_at timestamptz,
  max_devices smallint NOT NULL,
  status license_status NOT NULL DEFAULT 'ACTIVE',
  note text,
  created_by_admin_id uuid REFERENCES admins(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_licenses_key_hash_strength CHECK (octet_length(license_key_hash) >= 32),
  CONSTRAINT ck_licenses_key_preview CHECK (char_length(license_key_preview) BETWEEN 4 AND 32),
  CONSTRAINT ck_licenses_max_devices CHECK (max_devices > 0),
  CONSTRAINT ck_licenses_type_expiry CHECK (
    (license_type = 'LIFETIME' AND expires_at IS NULL)
    OR
    (license_type = 'SUBSCRIPTION' AND expires_at IS NOT NULL)
  )
);

COMMENT ON COLUMN licenses.license_key_hash IS
  'Cryptographic digest/HMAC of the raw license key. Raw license keys must not be persisted.';
COMMENT ON COLUMN licenses.license_key_preview IS
  'Non-secret masked/partial representation for admin display; never store the full raw key here.';

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id uuid NOT NULL REFERENCES licenses(id) ON DELETE RESTRICT,
  device_id text NOT NULL,
  device_name text,
  os text,
  app_version varchar(64),
  status device_status NOT NULL DEFAULT 'ACTIVE',
  activated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT uq_devices_license_device UNIQUE (license_id, device_id),
  CONSTRAINT ck_devices_device_id_not_blank CHECK (btrim(device_id) <> ''),
  CONSTRAINT ck_devices_last_seen CHECK (last_seen_at >= activated_at),
  CONSTRAINT ck_devices_revocation_state CHECK (
    (status = 'ACTIVE' AND revoked_at IS NULL)
    OR
    (status = 'REVOKED' AND revoked_at IS NOT NULL AND revoked_at >= activated_at)
  )
);

CREATE TABLE license_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id uuid NOT NULL REFERENCES licenses(id) ON DELETE RESTRICT,
  device_id uuid REFERENCES devices(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  actor_type actor_type NOT NULL,
  actor_admin_id uuid REFERENCES admins(id) ON DELETE RESTRICT,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_license_events_event_type_not_blank CHECK (btrim(event_type) <> ''),
  CONSTRAINT ck_license_events_actor CHECK (
    (actor_type = 'ADMIN' AND actor_admin_id IS NOT NULL)
    OR
    (actor_type <> 'ADMIN' AND actor_admin_id IS NULL)
  ),
  CONSTRAINT ck_license_events_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type actor_type NOT NULL,
  actor_admin_id uuid REFERENCES admins(id) ON DELETE RESTRICT,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid,
  ip_address inet,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_audit_logs_action_not_blank CHECK (btrim(action) <> ''),
  CONSTRAINT ck_audit_logs_target_type_not_blank CHECK (btrim(target_type) <> ''),
  CONSTRAINT ck_audit_logs_request_id_not_blank CHECK (request_id IS NULL OR btrim(request_id) <> ''),
  CONSTRAINT ck_audit_logs_actor CHECK (
    (actor_type = 'ADMIN' AND actor_admin_id IS NOT NULL)
    OR
    (actor_type <> 'ADMIN' AND actor_admin_id IS NULL)
  ),
  CONSTRAINT ck_audit_logs_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TRIGGER trg_admins_updated_at
BEFORE UPDATE ON admins
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_applications_updated_at
BEFORE UPDATE ON applications
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_customers_updated_at
BEFORE UPDATE ON customers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_licenses_updated_at
BEFORE UPDATE ON licenses
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
