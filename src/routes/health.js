// src/routes/health.js

import { Router } from "express";
import { pool } from "../db/client.js";
import { redis } from "../cache/client.js";
import { logger } from "../logger/index.js";

export const healthRouter = Router();

const PROBE_TIMEOUT_MS = 3000;

// Races a promise against a timeout. Rejects with a timeout error if exceeded.
const withTimeout = (promise, label) =>
	Promise.race([
		promise,
		new Promise((_, reject) =>
			setTimeout(
				() => reject(new Error(`${label} probe timed out after ${PROBE_TIMEOUT_MS}ms`)),
				PROBE_TIMEOUT_MS,
			),
		),
	]);

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
