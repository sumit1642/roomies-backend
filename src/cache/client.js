// src/cache/client.js

import { createClient } from "redis";
import { config } from "../config/env.js";
import { logger } from "../logger/index.js";

// ─── Retry configuration ────────────────────────────────────────────────────
// Without explicit retry settings the redis package uses its own defaults,
// which can mean infinite retries with no backoff — a runaway reconnect loop
// that hammers a recovering Redis server and floods the logs.
//
// Strategy: exponential backoff starting at 100ms, capped at 3 seconds,
// giving up entirely after 10 consecutive failures. At that point the error
// surfaces to the health check and the on("error") handler, making the
// problem visible rather than silently retrying forever.
//
// In production (Azure Cache for Redis), transient network blips are normal
// during deployments and scaling events. 10 retries × ~3s cap gives roughly
// 30 seconds of recovery window before we declare the connection dead.
const MAX_RETRY_ATTEMPTS = 10;

const reconnectStrategy = (retries) => {
	if (retries >= MAX_RETRY_ATTEMPTS) {
		// Returning an Error instance tells the redis client to stop retrying
		// and emit a final "error" event with this message.
		return new Error(`Redis reconnect failed after ${MAX_RETRY_ATTEMPTS} attempts — giving up`);
	}

	// Exponential backoff: 100ms, 200ms, 400ms … capped at 3000ms.
	// Math.min prevents the wait from growing unboundedly on a prolonged outage.
	const backoffMs = Math.min(100 * Math.pow(2, retries), 3_000);
	logger.warn({ retries, backoffMs }, "Redis reconnecting");
	return backoffMs;
};

export const redis = createClient({
	url: config.REDIS_URL,
	socket: {
		// How long (ms) to wait for the initial TCP connection before failing.
		// Without this the client can hang indefinitely if the Redis host is
		// unreachable — which blocks server startup and health checks.
		connectTimeout: 5_000,

		// Keep the TCP connection alive at the OS level. Prevents the connection
		// from being silently dropped by Azure's load balancer after idle periods.
		keepAlive: 5_000,

		// Called every time the client needs to reconnect after a dropped connection.
		// Returning a number schedules the next attempt after that many ms.
		// Returning an Error stops retrying entirely.
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

// Connect is called once in server.js during startup.
// Everything else in the app imports this already-connected client.
export const connectRedis = async () => {
	await redis.connect();
};
