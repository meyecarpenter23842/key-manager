-- 0001_schema_constraints.sql
-- Runs inside a transaction and rolls back all test fixtures.

BEGIN;

DO $test$
DECLARE
  v_admin_id uuid;
  v_app_id uuid;
  v_app2_id uuid;
  v_customer_id uuid;
  v_license_id uuid;
  v_hash bytea := decode(repeat('11', 32), 'hex');
  v_labels text[];
  v_missing text;
BEGIN
  SELECT string_agg(expected_table, ', ' ORDER BY expected_table)
  INTO v_missing
  FROM unnest(ARRAY[
    'applications',
    'customers',
    'licenses',
    'devices',
    'license_events',
    'admins',
    'audit_logs'
  ]) AS expected_table
  WHERE to_regclass('public.' || expected_table) IS NULL;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing core tables: %', v_missing;
  END IF;

  SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
  INTO v_labels
  FROM pg_type t
  JOIN pg_enum e ON e.enumtypid = t.oid
  WHERE t.typname = 'license_status';

  IF v_labels IS DISTINCT FROM ARRAY['ACTIVE', 'EXPIRED', 'REVOKED', 'ARCHIVED']::text[] THEN
    RAISE EXCEPTION 'unexpected license_status values: %', v_labels;
  END IF;

  IF to_regclass('public.uq_licenses_key_hash') IS NULL
     OR to_regclass('public.idx_licenses_application_status') IS NULL
     OR to_regclass('public.idx_licenses_active_expiry') IS NULL
     OR to_regclass('public.idx_devices_license_status') IS NULL THEN
    RAISE EXCEPTION 'required license/device indexes are missing';
  END IF;

  INSERT INTO admins (email, password_hash, role)
  VALUES ('owner@example.test', '$argon2id$test-only-hash-material', 'OWNER')
  RETURNING id INTO v_admin_id;

  INSERT INTO applications (name, app_code)
  VALUES ('Test App', 'TEST_APP')
  RETURNING id INTO v_app_id;

  BEGIN
    INSERT INTO applications (name, app_code) VALUES ('Duplicate', 'TEST_APP');
    RAISE EXCEPTION 'duplicate applications.app_code was accepted';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;

  INSERT INTO applications (name, app_code)
  VALUES ('Test App Two', 'TEST_APP_2')
  RETURNING id INTO v_app2_id;

  INSERT INTO customers (name, email)
  VALUES ('Test Customer', 'customer@example.test')
  RETURNING id INTO v_customer_id;

  INSERT INTO licenses (
    application_id,
    customer_id,
    license_key_hash,
    license_key_preview,
    license_type,
    expires_at,
    max_devices,
    status,
    created_by_admin_id
  ) VALUES (
    v_app_id,
    v_customer_id,
    v_hash,
    '****-1111',
    'LIFETIME',
    NULL,
    1,
    'ACTIVE',
    v_admin_id
  ) RETURNING id INTO v_license_id;

  BEGIN
    INSERT INTO licenses (
      application_id, license_key_hash, license_key_preview,
      license_type, expires_at, max_devices
    ) VALUES (
      v_app_id,
      decode(repeat('22', 32), 'hex'),
      '****-2222',
      'LIFETIME',
      now() + interval '30 days',
      1
    );
    RAISE EXCEPTION 'LIFETIME license with expires_at was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO licenses (
      application_id, license_key_hash, license_key_preview,
      license_type, expires_at, max_devices
    ) VALUES (
      v_app_id,
      decode(repeat('33', 32), 'hex'),
      '****-3333',
      'SUBSCRIPTION',
      NULL,
      1
    );
    RAISE EXCEPTION 'SUBSCRIPTION license without expires_at was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO licenses (
      application_id, license_key_hash, license_key_preview,
      license_type, expires_at, max_devices
    ) VALUES (
      v_app2_id,
      v_hash,
      '****-1111',
      'LIFETIME',
      NULL,
      1
    );
    RAISE EXCEPTION 'duplicate license hash across applications was accepted';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO licenses (
      application_id, license_key_hash, license_key_preview,
      license_type, expires_at, max_devices
    ) VALUES (
      gen_random_uuid(),
      decode(repeat('44', 32), 'hex'),
      '****-4444',
      'LIFETIME',
      NULL,
      1
    );
    RAISE EXCEPTION 'license with unknown application was accepted';
  EXCEPTION
    WHEN foreign_key_violation THEN NULL;
  END;

  INSERT INTO devices (license_id, device_id, device_name)
  VALUES (v_license_id, 'device-1', 'Primary device');

  BEGIN
    INSERT INTO devices (license_id, device_id) VALUES (v_license_id, 'device-1');
    RAISE EXCEPTION 'duplicate device for the same license was accepted';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO devices (license_id, device_id, status, revoked_at)
    VALUES (v_license_id, 'device-2', 'REVOKED', NULL);
    RAISE EXCEPTION 'REVOKED device without revoked_at was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  INSERT INTO license_events (
    license_id, event_type, actor_type, actor_admin_id, metadata
  ) VALUES (
    v_license_id, 'LICENSE_CREATED', 'ADMIN', v_admin_id, '{"source":"schema-test"}'::jsonb
  );

  INSERT INTO audit_logs (
    actor_type, actor_admin_id, action, target_type, target_id, request_id
  ) VALUES (
    'ADMIN', v_admin_id, 'LICENSE_CREATED', 'LICENSE', v_license_id, 'schema-test-request'
  );

  RAISE NOTICE 'Phase 1 schema constraint tests passed';
END;
$test$;

ROLLBACK;
