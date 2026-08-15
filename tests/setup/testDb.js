// tests/setup/testDb.js
//
// Truncates every application table between tests so each test starts from a
// clean slate, without paying the cost of re-running migrations per test.
// schema_migrations is deliberately excluded — it tracks which migrations
// have been applied, not application data, and truncating it would make the
// migration runner think nothing has been applied yet.
//
// spatial_ref_sys is ALSO deliberately excluded, for the same reason:
// PostGIS installs this table into the public schema and seeds it with
// ~8,000 SRID projection definitions (including 4326/WGS84) as part of
// `CREATE EXTENSION postgis`. It is reference data owned by the extension,
// not application data — truncating it does not reset any test fixture, it
// just destroys PostGIS's own projection metadata for the rest of the test
// run. Root-caused via a real failure: every proximity-search query using
// `::geography` casts (ST_DWithin) started throwing
// "Cannot find SRID (4326) in spatial_ref_sys" as soon as any earlier test
// in the run had called resetDb() once, because the original blanket
// TRUNCATE (excluding only schema_migrations) wiped SRID 4326's row on the
// very first test and every one after ran against an empty table. Simple
// point construction (ST_SetSRID via sync_location_geometry()'s trigger)
// tolerates a missing SRID row, which is why listing/property creation never
// surfaced this — only ST_DWithin's geodetic distance math actually needs
// the projection lookup, so the bug was invisible until a suite exercised
// the proximity/lat-lng search path.
//
// ALSO flushes Redis. Postgres truncation alone was not sufficient isolation:
// refreshToken:* and userSessions:* keys (and anything else written to Redis
// during a test) persist for their full TTL and are NEVER cleared by
// TRUNCATE, since Redis is an entirely separate store. Across repeated
// `npm test` / manual jest invocations against the same long-lived
// docker-compose test-redis container, this caused keys to accumulate
// indefinitely (confirmed: 462 -> 490 refreshToken keys and 443 -> 470
// userSessions keys across two consecutive runs with no cleanup in between).
// That leftover state was the actual root cause of an intermittent
// logout/all test failure that looked like an application-level race
// condition but was really stale keys colliding with fresh test data and/or
// resource contention across hundreds of accumulated keys — the application
// code (casRefreshToken, logoutAll) was verified correct via direct Redis
// inspection during that investigation.
//
// redis.flushDb() clears only the CURRENTLY SELECTED logical database on the
// connected Redis instance — it does not touch other Redis servers. As a
// belt-and-suspenders guard against ever accidentally running this against a
// non-test environment, we hard-fail if REDIS_URL doesn't look like the
// known test instance (127.0.0.1:6380, per docker-compose.test.yml / .env.test).

import { pool } from "../../src/db/client.js";
import { redis } from "../../src/cache/client.js";
import { config } from "../../src/config/env.js";

// Tables that are reference/infrastructure data owned by an extension or the
// migration runner, never application state — must never be truncated
// between tests.
const NON_APPLICATION_TABLES = new Set([
	"schema_migrations",
	"spatial_ref_sys", // PostGIS SRID projection reference data (public schema)
]);

const assertTestRedisUrl = () => {
	let parsed;
	try {
		parsed = new URL(config.REDIS_URL);
	} catch {
		throw new Error(`resetDb: REDIS_URL is not a valid URL — refusing to flush. Got: ${config.REDIS_URL}`);
	}

	const isLocalTestInstance =
		(parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") && parsed.port === "6380";

	if (!isLocalTestInstance) {
		throw new Error(
			`resetDb: refusing to FLUSHDB — REDIS_URL (${config.REDIS_URL}) does not look like the ` +
				`known test-only Redis instance (127.0.0.1:6380, per docker-compose.test.yml). ` +
				`This guard exists so a misconfigured ENV_FILE can never cause a test run to wipe a real Redis instance.`,
		);
	}
};

export const resetDb = async () => {
	const { rows } = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
	const tables = rows
		.map((r) => r.tablename)
		.filter((name) => !NON_APPLICATION_TABLES.has(name))
		.map((name) => `"${name}"`)
		.join(", ");
	if (tables) await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);

	assertTestRedisUrl();
	await redis.flushDb();
};
