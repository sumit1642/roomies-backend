// src/routes/health.js

import { Router } from "express";
import { pool } from "../db/client.js";
import { redis } from "../cache/client.js";
import { logger } from "../logger/index.js";

export const healthRouter = Router();

const PROBE_TIMEOUT_MS = 3000;

// ─── Timeout error detection ──────────────────────────────────────────────────
//
// Checks whether an error represents a timeout rather than a connectivity or
// other failure. A string-match on err.message is brittle because error messages
// are not part of any stable contract — they differ across Node.js versions,
// pg versions, and Redis client versions, and they can change without notice.
//
// We check in priority order:
//   1. Well-known error codes (ETIMEDOUT, ECONNABORTED) — the most reliable signal.
//   2. Well-known error names (TimeoutError) — used by some promise-based libraries.
//   3. Instance checks against built-in timeout error types — future-proofing.
//   4. Case-insensitive regex on the message — last resort for anything else.
const isTimeoutError = (err) => {
	if (!err) return false;

	// Explicit error codes set by the OS or Node.js networking layer.
	if (err.code === "ETIMEDOUT" || err.code === "ECONNABORTED" || err.code === "ESOCKETTIMEDOUT") {
		return true;
	}

	// Error name used by some promise-based timeout wrappers and newer runtimes.
	if (err.name === "TimeoutError" || err.name === "AbortError") {
		return true;
	}

	// Fall back to a case-insensitive pattern match on the message as a last
	// resort. This catches the message produced by our own withTimeout() helper
	// ("... probe timed out after ...") as well as any third-party timeout messages.
	if (typeof err.message === "string" && /timed?\s*out/i.test(err.message)) {
		return true;
	}

	return false;
};

// ─── withTimeout ──────────────────────────────────────────────────────────────
//
// Races a promise against a timeout and clears the timer either way to prevent
// accumulating live timer handles across high-frequency health-check calls.
const withTimeout = (promise, label) => {
	let timeoutId;

	const timeoutPromise = new Promise((_, reject) => {
		timeoutId = setTimeout(
			() => reject(new Error(`${label} probe timed out after ${PROBE_TIMEOUT_MS}ms`)),
			PROBE_TIMEOUT_MS,
		);
	});

	const guardedPromise = promise.finally(() => clearTimeout(timeoutId));

	return Promise.race([guardedPromise, timeoutPromise]);
};

// GET /api/v1/health
// Returns 200 if server, database, and Redis are all reachable.
// Returns 503 if any dependency is degraded or timed out.
//
// Error details are logged server-side and never exposed in the response body
// to avoid leaking internal topology (hostnames, ports, SSL details, etc.).
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
		health.services.database = isTimeoutError(err) ? "timeout" : "unhealthy";
	}

	try {
		await withTimeout(redis.ping(), "redis");
	} catch (err) {
		logger.error({ err }, "Health probe: redis unreachable");
		health.status = "degraded";
		health.services.redis = isTimeoutError(err) ? "timeout" : "unhealthy";
	}

	res.status(health.status === "ok" ? 200 : 503).json(health);
});
