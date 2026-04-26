-- Active: 1777192065763@@127.0.0.1@5432@roomies_db
-- Migration 005: Roommate matching support
--
-- Adds opt-in roommate-seeking flag and bio to student_profiles.
-- Creates roommate_blocks so students can hide specific users from their feed.

ALTER TABLE student_profiles
ADD COLUMN IF NOT EXISTS looking_for_roommate BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS roommate_bio TEXT,
ADD COLUMN IF NOT EXISTS looking_updated_at TIMESTAMPTZ;

-- Sparse index — only indexes rows that are actively seeking.
-- The roommate feed query filters on this exact condition so the index is hit on every feed request.
CREATE INDEX IF NOT EXISTS idx_student_roommate_lookup ON student_profiles (
    looking_updated_at DESC,
    user_id
)
WHERE
    looking_for_roommate = TRUE
    AND deleted_at IS NULL;

-- Block table — bidirectional blocking is handled at the service layer
-- by checking both (blocker=caller, blocked=candidate) and vice-versa.
CREATE TABLE IF NOT EXISTS roommate_blocks (
    blocker_id UUID NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
    blocked_id UUID NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (blocker_id, blocked_id),
    CONSTRAINT chk_no_self_block CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_roommate_blocks_blocker ON roommate_blocks (blocker_id);

CREATE INDEX IF NOT EXISTS idx_roommate_blocks_blocked ON roommate_blocks (blocked_id);