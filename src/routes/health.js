// src/routes/health.js

import { Router } from "express";
import { pool } from "../db/client.js";
import { redis } from "../cache/client.js";
import { logger } from "../logger/index.js";

export const healthRouter = Router();

const PROBE_TIMEOUT_MS = 3000;

// Races a promise against a timeout and clears the timer either way.
//
// The previous implementation using a bare Promise.race() left the setTimeout
// handle running even after the primary promise settled. Under high-frequency
// probe traffic (e.g. Azure load balancer hitting /health every few seconds),
// this means accumulating live timer handles that are never cleaned up — a slow
// but real memory and event-loop pressure leak.
//
// The fix: capture the timeoutId and call clearTimeout() in a .finally() block
// on the primary promise, so the timer is cancelled as soon as the operation
// succeeds or fails — whichever comes first. The timeout promise is still there
// to win the race if the primary hangs, but if the primary settles normally the
// timeout handle is discarded immediately.
const withTimeout = (promise, label) => {
	let timeoutId;

	const timeoutPromise = new Promise((_, reject) => {
		timeoutId = setTimeout(
			() => reject(new Error(`${label} probe timed out after ${PROBE_TIMEOUT_MS}ms`)),
			PROBE_TIMEOUT_MS,
		);
	});

	// Wrap the primary promise so that, regardless of whether it resolves or
	// rejects, the pending timeout handle is cleared before the result propagates.
	const guardedPromise = promise.finally(() => clearTimeout(timeoutId));

	return Promise.race([guardedPromise, timeoutPromise]);
};

// GET /api/v1/health
// Returns 200 if server, database, and Redis are all reachable.
// Returns 503 if any dependency is degraded or timed out.
healthRouter.get("/", async (req, res) => {
	const health = {
		status: "ok",
		timestamp: new Date().toISOString(),
		services: {
			database: "ok",
			redis: "ok",
		},
	};

	try {
		await withTimeout(pool.query("SELECT 1"), "database");
	} catch (err) {
		logger.error({ err }, "Health probe: database unreachable");
		health.status = "degraded";
		health.services.database = err.message;
	}

	try {
		await withTimeout(redis.ping(), "redis");
	} catch (err) {
		logger.error({ err }, "Health probe: redis unreachable");
		health.status = "degraded";
		health.services.redis = err.message;
	}

	res.status(health.status === "ok" ? 200 : 503).json(health);
});
