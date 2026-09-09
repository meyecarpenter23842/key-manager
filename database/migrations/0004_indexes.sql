-- 0004_indexes.sql

-- Admin authentication lookup is case-insensitive without requiring the citext extension.
CREATE UNIQUE INDEX uq_admins_email_ci ON admins (lower(email));
CREATE INDEX idx_admins_status ON admins (status);

CREATE INDEX idx_applications_status ON applications (status);

CREATE INDEX idx_customers_email_ci ON customers (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX idx_customers_phone ON customers (phone) WHERE phone IS NOT NULL;

-- A raw license key must never map to more than one license, regardless of application.
CREATE UNIQUE INDEX uq_licenses_key_hash ON licenses (license_key_hash);
CREATE INDEX idx_licenses_application_status ON licenses (application_id, status);
CREATE INDEX idx_licenses_customer ON licenses (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_licenses_active_expiry ON licenses (expires_at)
  WHERE license_type = 'SUBSCRIPTION' AND status = 'ACTIVE';

-- uq_devices_license_device from the table definition prevents duplicate device fingerprints.
CREATE INDEX idx_devices_license_status ON devices (license_id, status);
CREATE INDEX idx_devices_last_seen ON devices (last_seen_at DESC);

CREATE INDEX idx_license_events_license_created ON license_events (license_id, created_at DESC);
CREATE INDEX idx_license_events_type_created ON license_events (event_type, created_at DESC);
CREATE INDEX idx_license_events_device_created ON license_events (device_id, created_at DESC)
  WHERE device_id IS NOT NULL;

CREATE INDEX idx_audit_logs_created ON audit_logs (created_at DESC);
CREATE INDEX idx_audit_logs_actor_created ON audit_logs (actor_admin_id, created_at DESC)
  WHERE actor_admin_id IS NOT NULL;
CREATE INDEX idx_audit_logs_target_created ON audit_logs (target_type, target_id, created_at DESC);
CREATE INDEX idx_audit_logs_request_id ON audit_logs (request_id) WHERE request_id IS NOT NULL;
