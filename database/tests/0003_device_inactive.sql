-- 0003_device_inactive.sql
-- Verifies the Phase 6 distinction between client deactivation and admin revocation.

BEGIN;

DO $test$
DECLARE
  v_app_id uuid;
  v_license_id uuid;
  v_labels text[];
BEGIN
  SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
  INTO v_labels
  FROM pg_type t
  JOIN pg_enum e ON e.enumtypid = t.oid
  WHERE t.typname = 'device_status';

  IF NOT ('INACTIVE' = ANY(v_labels)) THEN
    RAISE EXCEPTION 'device_status is missing INACTIVE: %', v_labels;
  END IF;

  INSERT INTO applications (name, app_code)
  VALUES ('Phase 6 DB Test', 'PHASE6_DB_TEST')
  RETURNING id INTO v_app_id;

  INSERT INTO licenses (
    application_id, license_key_hash, license_key_preview, license_type, max_devices, status
  ) VALUES (
    v_app_id, decode(repeat('66', 32), 'hex'), '****-6666', 'LIFETIME', 1, 'ACTIVE'
  ) RETURNING id INTO v_license_id;

  INSERT INTO devices (license_id, device_id, status)
  VALUES (v_license_id, 'inactive-device', 'INACTIVE');

  BEGIN
    INSERT INTO devices (license_id, device_id, status, revoked_at)
    VALUES (v_license_id, 'bad-inactive-device', 'INACTIVE', now());
    RAISE EXCEPTION 'INACTIVE device with revoked_at was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  RAISE NOTICE 'Phase 6 device inactive schema tests passed';
END;
$test$;

ROLLBACK;
