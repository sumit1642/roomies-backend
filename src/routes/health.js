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
//
// ─── WHY WE SANITISE THE RESPONSE ────────────────────────────────────────────
//
// Raw Node/pg/redis error messages can contain infrastructure details that
// external clients have no business seeing: internal hostnames, port numbers,
// SSL certificate error details, Azure connection string fragments, and so on.
// Leaking these in a public HTTP response is an information-disclosure
// vulnerability — it gives an attacker a precise map of your internal topology
// from a single unauthenticated probe.
//
// We already log the full error object (with all its detail) via logger.error,
// which goes to your structured log aggregator (Pino → Azure Monitor / stdout).
// That is exactly the right audience for detailed failure context. The HTTP
// response audience is a load balancer, a status-page service, or a developer
// checking health — none of them need the raw error string.
//
// The public response therefore uses a fixed vocabulary of sanitised statuses:
//   "ok"        — the probe succeeded
//   "unhealthy" — the probe failed for any reason other than timeout
//   "timeout"   — the probe timed out waiting for a response
//
// These three values are expressive enough for any downstream consumer to act
// on (restart a service, page on-call, mark the instance out of rotation) while
// revealing nothing about the internal failure mechanism.
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
		// Log the full, unredacted error internally — this is where infrastructure
		// detail belongs. The response gets a sanitised status only.
		logger.error({ err }, "Health probe: database unreachable");
		health.status = "degraded";
		health.services.database = err.message?.includes("timed out") ? "timeout" : "unhealthy";
	}

	try {
		await withTimeout(redis.ping(), "redis");
	} catch (err) {
		logger.error({ err }, "Health probe: redis unreachable");
		health.status = "degraded";
		health.services.redis = err.message?.includes("timed out") ? "timeout" : "unhealthy";
	}

	res.status(health.status === "ok" ? 200 : 503).json(health);
});
