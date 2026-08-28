-- Down for 016: Admin user account-status audit columns
-- Reversible — additive-only migration (new nullable columns + one FK).
-- Drop order: constraint first (though DROP COLUMN would cascade-drop it
-- anyway), then columns.

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_status_changed_by_fkey;

ALTER TABLE users
    DROP COLUMN IF EXISTS status_changed_by,
    DROP COLUMN IF EXISTS status_changed_at,
    DROP COLUMN IF EXISTS status_reason;
