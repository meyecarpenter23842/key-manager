-- 0002_admin_auth.sql
BEGIN;

DO $$
DECLARE
  owner_id uuid;
BEGIN
  INSERT INTO admins (email, password_hash, role)
  VALUES ('owner-auth-test@example.com', 'scrypt$32768$8$1$fake-salt$fake-password-digest', 'OWNER')
  RETURNING id INTO owner_id;

  BEGIN
    INSERT INTO admin_sessions (admin_id, token_hash, expires_at)
    VALUES (owner_id, decode(repeat('00', 31), 'hex'), now() + interval '1 hour');
    RAISE EXCEPTION 'expected token hash length constraint to fail';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  INSERT INTO admin_sessions (admin_id, token_hash, expires_at)
  VALUES (owner_id, decode(repeat('01', 32), 'hex'), now() + interval '1 hour');

  BEGIN
    INSERT INTO admin_sessions (admin_id, token_hash, expires_at)
    VALUES (owner_id, decode(repeat('01', 32), 'hex'), now() + interval '2 hours');
    RAISE EXCEPTION 'expected duplicate token hash to fail';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO admin_sessions (admin_id, token_hash, expires_at)
    VALUES (owner_id, decode(repeat('02', 32), 'hex'), now() - interval '1 minute');
    RAISE EXCEPTION 'expected expired-on-create session to fail';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

ROLLBACK;
