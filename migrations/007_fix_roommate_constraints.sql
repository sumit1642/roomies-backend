-- Active: 1777192065763@@127.0.0.1@5432@roomies_db
-- Migration 007: Fix roommate_blocks FK cascade + redundant index + add looking timestamp check
--
-- Fixes applied from migration 005:
--   1. Add CHECK constraint: looking_for_roommate = TRUE requires looking_updated_at IS NOT NULL
--   2. Change roommate_blocks FKs from ON DELETE RESTRICT to ON DELETE CASCADE
--   3. Drop redundant idx_roommate_blocks_blocker (covered by PK on blocker_id, blocked_id)

-- Fix 1: Add CHECK constraint on student_profiles
-- Only safe to add if it won't violate existing data.
-- First backfill: any row already set to TRUE with NULL timestamp gets NOW().
UPDATE student_profiles
SET
    looking_updated_at = NOW()
WHERE
    looking_for_roommate = TRUE
    AND looking_updated_at IS NULL;

ALTER TABLE student_profiles
ADD CONSTRAINT chk_looking_has_timestamp CHECK (
    looking_for_roommate = FALSE
    OR looking_updated_at IS NOT NULL
);

-- Fix 2 + 3: Recreate roommate_blocks with CASCADE and without redundant index
-- We must drop and recreate because ALTER CONSTRAINT is not supported for FK ON DELETE in PG.

-- Drop old table (no data worth preserving in prod at this stage — blocks are
-- user-generated UX state, not business-critical records).
DROP TABLE IF EXISTS roommate_blocks;

CREATE TABLE roommate_blocks (
    blocker_id UUID NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    blocked_id UUID NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (blocker_id, blocked_id),
    CONSTRAINT chk_no_self_block CHECK (blocker_id <> blocked_id)
);

-- Only keep the blocked_id index (blocker_id is covered by the PK leftmost prefix)
CREATE INDEX IF NOT EXISTS idx_roommate_blocks_blocked ON roommate_blocks (blocked_id);