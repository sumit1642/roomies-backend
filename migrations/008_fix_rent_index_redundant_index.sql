-- Active: 1777192065763@@127.0.0.1@5432@roomies_db
-- Migration 008: Drop redundant idx_rent_index_lookup on rent_index
--
-- The UNIQUE constraint uq_rent_index (city, locality, room_type) already
-- creates a B-tree index covering the same columns. The explicit index
-- idx_rent_index_lookup is redundant and wastes storage + write overhead.

DROP INDEX IF EXISTS idx_rent_index_lookup;