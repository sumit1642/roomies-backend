007 (revised): Fix roommate_blocks FK cascade + redundant index + CHECK constraint
--
-- ORIGINAL migration dropped and recreated the table, destroying all existing
-- block rows. This revision is data-safe: it uses ALTER TABLE to swap the FK
-- actions and add the CHECK constraint if absent.
--
-- Fixes applied:
--   1. Backfill looking_updated_at for rows where looking_for_roommate = TRUE
--   2. Add CHECK constraint chk_looking_has_timestamp (safe after backfill)
--   3. Replace RESTRICT FKs on roommate_blocks with CASCADE (non-destructive)
--   4. Add chk_no_self_block CHECK if absent
--   5. Drop redundant idx_roommate_blocks_blocker (PK already covers it)

-- Fix 1: Backfill timestamp
UPDATE student_profiles
SET looking_updated_at = NOW()
WHERE looking_for_roommate = TRUE
  AND looking_updated_at IS NULL;

-- Fix 2: CHECK constraint on student_profiles
ALTER TABLE student_profiles
ADD CONSTRAINT chk_looking_has_timestamp CHECK (
    looking_for_roommate = FALSE
    OR looking_updated_at IS NOT NULL
);

-- Fix 3+4: Create roommate_blocks if it doesn't exist yet (fresh environment),
-- otherwise alter FKs in-place to preserve data.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'roommate_blocks'
    ) THEN
        CREATE TABLE roommate_blocks (
            blocker_id UUID NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
            blocked_id UUID NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (blocker_id, blocked_id),
            CONSTRAINT chk_no_self_block CHECK (blocker_id <> blocked_id)
        );
    ELSE
        -- Swap RESTRICT FKs to CASCADE without touching data
        ALTER TABLE roommate_blocks
            DROP CONSTRAINT IF EXISTS roommate_blocks_blocker_id_fkey,
            DROP CONSTRAINT IF EXISTS roommate_blocks_blocked_id_fkey;

        ALTER TABLE roommate_blocks
            ADD CONSTRAINT roommate_blocks_blocker_id_fkey
                FOREIGN KEY (blocker_id) REFERENCES users (user_id) ON DELETE CASCADE,
            ADD CONSTRAINT roommate_blocks_blocked_id_fkey
                FOREIGN KEY (blocked_id) REFERENCES users (user_id) ON DELETE CASCADE;

        -- Add self-block check only if it doesn't already exist
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

-- Fix 5: Drop redundant index (blocker_id is leftmost PK column)
DROP INDEX IF EXISTS idx_roommate_blocks_blocker;

-- Keep only the blocked_id index (needed for reverse lookups)
CREATE INDEX IF NOT EXISTS idx_roommate_blocks_blocked ON roommate_blocks (blocked_id);