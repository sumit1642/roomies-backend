





import { Router } from "express";
import { redis } from "../cache/client.js";
import { logger } from "../logger/index.js";

export const testUtilsRouter = Router();











testUtilsRouter.post("/reset-rate-limits", async (req, res, next) => {
	try {
		
		
		const keys = await redis.keys("rl:*");

		if (keys.length === 0) {
			return res.json({
				status: "success",
				message: "No rate limit keys found — nothing to reset",
				deletedCount: 0,
			});
		}

		
		
		await redis.del(keys);

		logger.info({ deletedKeys: keys, count: keys.length }, "testUtils: rate limit keys cleared");

		res.json({
			status: "success",
			message: `Rate limits cleared`,
			deletedCount: keys.length,
			deletedKeys: keys, 
		});
	} catch (err) {
		next(err);
	}
});
