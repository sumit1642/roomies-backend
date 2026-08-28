-- Down for 016b: validating a constraint is not reversible in any meaningful
-- sense (there is no "unvalidated" state to go back to that isn't just 016's
-- own state before this ran, and Postgres has no ALTER TABLE ... INVALIDATE
-- CONSTRAINT). This file exists only so migrate.js's --rollback can locate a
-- down file and delete the schema_migrations row cleanly; it intentionally
-- performs no schema change.
SELECT 1;
