-- Active: 1777192065763@@127.0.0.1@5432@roomies_db
-- Migration 007: Fix roommate_blocks FK cascade + redundant index + CHECK constraint
--
-- Fixes applied from migration 005:
--   1. Add CHECK constraint: looking_for_roommate = TRUE requires looking_updated_at IS NOT NULL
--   2. Change roommate_blocks FKs from ON DELETE RESTRICT to ON DELETE CASCADE
--   3. Drop redundant idx_roommate_blocks_blocker (covered by PK on blocker_id, blocked_id)
--
-- Revised approach (safe for environments that already have data in roommate_blocks):
--   Instead of DROP TABLE + recreate (which destroys all block rows), we use
--   ALTER TABLE to swap FK actions and add the CHECK constraint in-place.
--   A fresh environment that has no roommate_blocks table yet gets a CREATE TABLE.

-- Fix 1: Backfill timestamp — required before adding the CHECK constraint.
UPDATE student_profiles
SET looking_updated_at = NOW()
WHERE looking_for_roommate = TRUE
  AND looking_updated_at IS NULL;

-- Add CHECK constraint (safe now that all TRUE rows have a timestamp).
ALTER TABLE student_profiles
ADD CONSTRAINT chk_looking_has_timestamp CHECK (
    looking_for_roommate = FALSE
    OR looking_updated_at IS NOT NULL
);

-- Fix 2 + 3: Create roommate_blocks with CASCADE if it doesn't exist yet
-- (fresh environment), otherwise alter FKs in-place to preserve existing data.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'roommate_blocks'
    ) THEN
        -- Fresh environment: create with correct constraints from the start.
        CREATE TABLE roommate_blocks (
            blocker_id UUID NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
            blocked_id UUID NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (blocker_id, blocked_id),
            CONSTRAINT chk_no_self_block CHECK (blocker_id <> blocked_id)
        );
    ELSE
        -- Existing environment: swap RESTRICT FKs to CASCADE without touching data.
        ALTER TABLE roommate_blocks
            DROP CONSTRAINT IF EXISTS roommate_blocks_blocker_id_fkey,
            DROP CONSTRAINT IF EXISTS roommate_blocks_blocked_id_fkey;

        ALTER TABLE roommate_blocks
            ADD CONSTRAINT roommate_blocks_blocker_id_fkey
                FOREIGN KEY (blocker_id) REFERENCES users (user_id) ON DELETE CASCADE,
            ADD CONSTRAINT roommate_blocks_blocked_id_fkey
                FOREIGN KEY (blocked_id) REFERENCES users (user_id) ON DELETE CASCADE;

        -- Add self-block check only if it doesn't already exist.
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.check_constraints
            WHERE constraint_name = 'chk_no_self_block'
        ) THEN
            ALTER TABLE roommate_blocks
                ADD CONSTRAINT chk_no_self_block CHECK (blocker_id <> blocked_id);
        END IF;
    END IF;
END;
$$;

-- Fix 3: Drop redundant index (blocker_id is the leftmost column of the PK,
-- so the PK index already satisfies all blocker_id lookups).
DROP INDEX IF EXISTS idx_roommate_blocks_blocker;

-- Keep only the blocked_id index (needed for reverse-lookup: "who is blocking me").
CREATE INDEX IF NOT EXISTS idx_roommate_blocks_blocked ON roommate_blocks (blocked_id);