-- 0009_application_icon.sql
-- Store a small, normalized application icon directly with application metadata.

ALTER TABLE applications
ADD COLUMN icon_data_url text;

ALTER TABLE applications
ADD CONSTRAINT ck_applications_icon_data_url
CHECK (
  icon_data_url IS NULL
  OR (
    octet_length(icon_data_url) <= 262144
    AND icon_data_url ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$'
  )
);
