-- 0006_device_inactive_status.sql
-- Add a non-destructive client deactivation state. This must be committed
-- before any constraint references the new enum value.

ALTER TYPE device_status ADD VALUE 'INACTIVE';
