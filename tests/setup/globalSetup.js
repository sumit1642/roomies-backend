// tests/setup/globalSetup.js
//
// Jest runs this file once in a fresh Node process BEFORE any test file is
// imported. The timing is critical: src/config/env.js reads and validates
// ENV_FILE at the moment it is first imported. If ENV_FILE is not set before
// that import happens, env.js loads .env.local and every test runs against
// your development database.
//
// Setting ENV_FILE here — before Jest loads any test module — guarantees
// that every subsequent import of src/config/env.js sees .env.test.

import pg from "pg";

export default async function globalSetup() {
	// Must be the very first line — before any src/ import.
	process.env.ENV_FILE = ".env.test";

	// ── Sanity check: verify we are pointed at the test database ─────────────
	//
	// If this fails, it means either:
	//   a) .env.test doesn't exist or DATABASE_URL is wrong
	//   b) roomies_test hasn't been created and seeded yet
	//
	// The error message is intentionally detailed so the developer knows exactly
	// what command to run rather than having to guess why tests won't start.
	//
	// We use a direct pg.Pool here rather than importing src/db/client.js because
	// the src/ modules haven't been loaded yet — that's the point of globalSetup.
	// We don't want side effects from loading application code at this stage.
	const { Pool } = pg;

	// dotenv isn't loaded yet at this stage (that happens when src/config/env.js
	// is first imported inside a test). We read the DATABASE_URL directly from
	// process.env after dotenv loads it — but we need it NOW to verify the DB.
	// Solution: load the test env file manually here just for the connection check.
	const { default: dotenv } = await import("dotenv");
	dotenv.config({ path: ".env.test" });

	const databaseUrl = process.env.DATABASE_URL;

	if (!databaseUrl) {
		throw new Error(
			"[globalSetup] DATABASE_URL is not set in .env.test.\n" +
				"Check that .env.test exists in the project root and contains DATABASE_URL.",
		);
	}

	// Verify the URL points at the test database, not the dev database.
	// This is a safety net — running tests against roomies_db would truncate
	// your development data on the first test run.
	if (!databaseUrl.includes("roomies_test")) {
		throw new Error(
			`[globalSetup] DATABASE_URL in .env.test does not point to the test database.\n` +
				`Expected a URL containing 'roomies_test', got: ${databaseUrl}\n` +
				`This check prevents tests from accidentally running against your dev database.`,
		);
	}

	const pool = new Pool({ connectionString: databaseUrl });

	try {
		// SELECT 1 confirms the database exists and is reachable.
		await pool.query("SELECT 1");

		// Confirm the schema has been applied by checking for the users table.
		// If this fails, roomies_db_setup.sql hasn't been run against roomies_test yet.
		const { rows } = await pool.query(`
			SELECT table_name
			FROM information_schema.tables
			WHERE table_schema = 'public'
			  AND table_name = 'users'
		`);

		if (!rows.length) {
			throw new Error(
				"[globalSetup] The test database exists but the schema has not been applied.\n" +
					"Run: psql -U <user> -d roomies_test -f roomies_db_setup.sql",
			);
		}

		console.log("[globalSetup] Test database verified ✓");
	} finally {
		await pool.end();
	}
}
