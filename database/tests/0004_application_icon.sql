-- 0004_application_icon.sql

BEGIN;

DO $test$
DECLARE
  v_app_id uuid;
BEGIN
  INSERT INTO applications (name, app_code, icon_data_url)
  VALUES ('Icon App', 'ICON_APP', 'data:image/png;base64,iVBORw0KGgo=')
  RETURNING id INTO v_app_id;

  IF (SELECT icon_data_url FROM applications WHERE id = v_app_id)
     IS DISTINCT FROM 'data:image/png;base64,iVBORw0KGgo=' THEN
    RAISE EXCEPTION 'application icon_data_url was not persisted';
  END IF;

  BEGIN
    UPDATE applications
    SET icon_data_url = 'https://example.test/icon.png'
    WHERE id = v_app_id;
    RAISE EXCEPTION 'non-data application icon URL was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  RAISE NOTICE 'Application icon schema constraints passed';
END;
$test$;

ROLLBACK;
