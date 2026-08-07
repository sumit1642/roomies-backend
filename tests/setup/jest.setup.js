// tests/setup/jest.setup.js
//
// Runs once per test FILE (Jest gives each file its own module registry, so
// this setup — and the connections it opens — is effectively per-file, not
// global). app.js never calls connectRedis() itself; only server.js does,
// and tests never run server.js. So we connect explicitly here.
//
// resetDb() runs before every individual test (not just once per file) so
// tests never leak state into one another regardless of execution order
// within a file.

import { pool } from "../../src/db/client.js";
import { redis, connectRedis } from "../../src/cache/client.js";
import { closeRateLimitRedisClient } from "../../src/middleware/rateLimiter.js";
import { closeAllQueues } from "../../src/workers/queue.js";
import { resetDb } from "./testDb.js";
import request from "supertest";

let app;
beforeAll(async () => {
	({ app } = await import("../../src/app.js"));

	if (!redis.isOpen) {
		await connectRedis();
	}
});

beforeEach(async () => {
	await resetDb();
	await request(app).post("/api/v1/test-utils/reset-rate-limits");
});

// Each test FILE gets its own module registry (see comment above), so a
// global teardown script cannot reach the connections opened in this file —
// they have to be closed here, per file, or Jest hangs on open handles after
// the last suite finishes.
//
// rateLimiter.js opens its own independent Redis client as an import-time
// side effect (used by authLimiter/otpLimiter) — that has to be closed
// separately via its exported closeRateLimitRedisClient(), since it isn't
// the same client instance as cache/client.js's `redis` export.
//
// workers/queue.js lazily creates a BullMQ Queue (and its own ioredis
// connection) the first time enqueueNotification/enqueueEmail is called
// anywhere in the request path this test file exercised. Those connections
// are invisible until then, so closeAllQueues() is called defensively even
// in files that don't obviously touch a queue — a controller two layers
// deep may still enqueue something.
afterAll(async () => {
	await pool.end().catch(() => {});
	if (redis.isOpen) {
		await redis.quit().catch(() => {});
	}
	// closeRateLimitRedisClient() calls .quit() on rateLimiter.js's own client,
	// which starts connecting at import time (fire-and-forget, no await
	// available to us). If it's still mid-handshake when this runs, .quit()
	// can no-op without releasing the socket — give it a beat first.
	await new Promise((resolve) => setTimeout(resolve, 50));
	await closeRateLimitRedisClient().catch(() => {});
	await closeAllQueues().catch(() => {});
});
