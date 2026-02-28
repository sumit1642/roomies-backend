import { createClient } from "redis";
import { config } from "../config/env.js";
import { logger } from "../logger/index.js";

export const redis = createClient({
	url: config.REDIS_URL,
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

// Connect is called once in server.js during startup.
// Everything else in the app imports this already-connected client.
export const connectRedis = async () => {
	await redis.connect();
};
