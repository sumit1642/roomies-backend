// tests/setup/testDb.js
//
// Truncates every application table between tests so each test starts from a
// clean slate, without paying the cost of re-running migrations per test.
// schema_migrations is deliberately excluded — it tracks which migrations
// have been applied, not application data, and truncating it would make the
// migration runner think nothing has been applied yet.

import { pool } from "../../src/db/client.js";

export const resetDb = async () => {
	const { rows } = await pool.query(
		`SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
	);
	const tables = rows.map((r) => `"${r.tablename}"`).join(", ");
	if (tables) await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
};
