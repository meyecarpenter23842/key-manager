-- 0008_encrypted_license_keys.sql

ALTER TABLE licenses
ADD COLUMN license_key_ciphertext text;

COMMENT ON COLUMN licenses.license_key_ciphertext IS
  'AES-256-GCM encrypted raw license key envelope. NULL means the raw key was not retained (legacy license).';
