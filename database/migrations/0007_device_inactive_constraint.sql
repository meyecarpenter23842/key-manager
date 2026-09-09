-- 0007_device_inactive_constraint.sql
-- Keep revoked_at reserved for administrative revocation while allowing
-- client-initiated deactivation to release a device slot without blocking
-- future activation of the same device.

ALTER TABLE devices
  DROP CONSTRAINT ck_devices_revocation_state;

ALTER TABLE devices
  ADD CONSTRAINT ck_devices_revocation_state CHECK (
    (status = 'ACTIVE' AND revoked_at IS NULL)
    OR
    (status = 'INACTIVE' AND revoked_at IS NULL)
    OR
    (status = 'REVOKED' AND revoked_at IS NOT NULL AND revoked_at >= activated_at)
  );
