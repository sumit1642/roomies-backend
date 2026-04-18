// src/routes/testUtils.js
//
// Development-only utility endpoints for testing purposes.
// This entire router is ONLY mounted when NODE_ENV !== 'production'.
// It is never reachable in a deployed environment.

import { Router } from "express";
import { redis } from "../cache/client.js";
import { logger } from "../logger/index.js";

export const testUtilsRouter = Router();

// POST /api/v1/test-utils/reset-rate-limits
//
// Deletes all rate limiter keys from Redis for the requesting IP address.
// This lets Postman tests run the auth/OTP flows repeatedly without hitting
// the 10-requests-per-15-minutes ceiling that the real limiters enforce.
//
// Why scan instead of direct delete? Because the rate-limit-redis library
// appends the IP to the prefix, and we don't want to hardcode that format.
// Scanning for all keys matching "rl:*" and deleting them is more resilient
// to any future prefix changes in rateLimiter.js.
testUtilsRouter.post("/reset-rate-limits", async (req, res, next) => {
	try {
		// KEYS is fine in development (small dataset, no performance concern).
		// Never use KEYS in production — it blocks the Redis event loop.
		const keys = await redis.keys("rl:*");

		if (keys.length === 0) {
			return res.json({
				status: "success",
				message: "No rate limit keys found — nothing to reset",
				deletedCount: 0,
			});
		}

		// DEL accepts multiple keys in a single command — more efficient than
		// looping and calling DEL once per key.
		await redis.del(keys);

		logger.info({ deletedKeys: keys, count: keys.length }, "testUtils: rate limit keys cleared");

		res.json({
			status: "success",
			message: `Rate limits cleared`,
			deletedCount: keys.length,
			deletedKeys: keys, // helpful to see exactly what was wiped
		});
	} catch (err) {
		next(err);
	}
});
