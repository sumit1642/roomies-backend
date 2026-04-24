

import { Router } from "express";
import { pool } from "../db/client.js";
import { redis } from "../cache/client.js";
import { logger } from "../logger/index.js";

export const healthRouter = Router();

const PROBE_TIMEOUT_MS = 3000;













const isTimeoutError = (err) => {
	if (!err) return false;

	
	if (err.code === "ETIMEDOUT" || err.code === "ECONNABORTED" || err.code === "ESOCKETTIMEDOUT") {
		return true;
	}

	
	if (err.name === "TimeoutError" || err.name === "AbortError") {
		return true;
	}

	
	
	
	if (typeof err.message === "string" && /timed?\s*out/i.test(err.message)) {
		return true;
	}

	return false;
};





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
