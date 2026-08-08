// tests/setup/testDb.js
//
// Truncates every application table between tests so each test starts from a
// clean slate, without paying the cost of re-running migrations per test.
// schema_migrations is deliberately excluded — it tracks which migrations
// have been applied, not application data, and truncating it would make the
// migration runner think nothing has been applied yet.
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
	const { rows } = await pool.query(
		`SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
	);
	const tables = rows.map((r) => `"${r.tablename}"`).join(", ");
	if (tables) await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);

	assertTestRedisUrl();
	await redis.flushDb();
};
