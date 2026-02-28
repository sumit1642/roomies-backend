import { Router } from "express";
import { pool } from "../db/client.js";
import { redis } from "../cache/client.js";

export const healthRouter = Router();

// GET /health
// Returns 200 if the server, database, and Redis are all reachable.
// Returns 503 if any dependency is down.
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
		await pool.query("SELECT 1");
	} catch {
		health.status = "degraded";
		health.services.database = "unreachable";
	}

	try {
		await redis.ping();
	} catch {
		health.status = "degraded";
		health.services.redis = "unreachable";
	}

	const statusCode = health.status === "ok" ? 200 : 503;
	res.status(statusCode).json(health);
});
