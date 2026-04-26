-- Active: 1777192065763@@127.0.0.1@5432@roomies_db
-- Migration 003: Add profile_photo_url to pg_owner_profiles
--
-- student_profiles already has this column from migration 001.
-- pg_owner_profiles was missing it; adding it here so PG owners can upload
-- a profile photo through the same endpoint pattern as students.

ALTER TABLE pg_owner_profiles
    ADD COLUMN IF NOT EXISTS profile_photo_url TEXT;