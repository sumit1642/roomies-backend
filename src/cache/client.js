

import { createClient } from "redis";
import { config } from "../config/env.js";
import { logger } from "../logger/index.js";

const MAX_RETRY_ATTEMPTS = 10;

const reconnectStrategy = (retries) => {
	if (retries >= MAX_RETRY_ATTEMPTS) {
		return new Error(`Redis reconnect failed after ${MAX_RETRY_ATTEMPTS} attempts — giving up`);
	}
	const backoffMs = Math.min(100 * Math.pow(2, retries), 3_000);
	logger.warn({ retries, backoffMs }, "Redis reconnecting");
	return backoffMs;
};

export const redis = createClient({
	url: config.REDIS_URL,
	socket: {
		connectTimeout: 5_000,

		keepAlive: 5_000,

		reconnectStrategy,
	},
});

redis.on("error", (err) => {
	logger.error({ err }, "Redis client error");
});

redis.on("connect", () => {
	logger.debug("Redis client connected");
});

redis.on("reconnecting", () => {
	logger.warn("Redis client reconnecting");
});

export const connectRedis = async () => {
	await redis.connect();
};
