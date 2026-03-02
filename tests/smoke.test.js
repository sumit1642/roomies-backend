// tests/smoke.test.js
//
// This test has one job: prove that the test environment is wired together
// correctly BEFORE you write any real tests. It verifies:
//
//   1. ENV_FILE=.env.test was set before env.js loaded (globalSetup worked)
//   2. The app module imports without throwing (no misconfigured middleware)
//   3. The health endpoint responds with both services ok
//
// If this test fails, nothing else will work. Fix this first.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import supertest from "supertest";
import { createClient } from "redis";
import { app } from "../src/app.js";
import { config } from "../src/config/env.js";
import { pool } from "./setup/dbHelpers.js";

// Each test file owns its own Redis client rather than sharing the singleton
// from src/cache/client.js. This avoids connection state leaking between
// files and makes the lifecycle (connect in beforeAll, close in afterAll)
// explicit and local to this file.
let redis;
const request = supertest(app);

beforeAll(async () => {
	redis = createClient({ url: config.REDIS_URL });
	await redis.connect();
});

afterAll(async () => {
	await redis.close();
	await pool.end();
});

describe("Test environment smoke test", () => {
	it("loaded .env.test — DATABASE_URL points at the test database", () => {
		// If globalSetup failed to set ENV_FILE before env.js loaded, this
		// would contain 'roomies_db' (the dev database) instead of 'roomies_test'.
		// A failure here means ENV_FILE was not honoured — check globalSetup.js.
		expect(config.DATABASE_URL).toMatch(/roomies_test/);
	});

	it("GET /api/v1/health returns 200 with both services ok", async () => {
		const res = await request.get("/api/v1/health");

		// 503 means either the test DB doesn't exist (run roomies_db_setup.sql
		// against roomies_test) or Redis /1 is not reachable.
		expect(res.status).toBe(200);
		expect(res.body.status).toBe("ok");
		expect(res.body.services.database).toBe("ok");
		expect(res.body.services.redis).toBe("ok");
	});
});
