// src/server.js

import "./config/env.js";

import { app } from "./app.js";
import { pool } from "./db/client.js";
import { redis, connectRedis } from "./cache/client.js";
import { logger } from "./logger/index.js";
import { config } from "./config/env.js";

const start = async () => {
	try {
		await pool.query("SELECT 1");
		logger.info("PostgreSQL connected");

		await connectRedis();
		logger.info("Redis connected");

		const server = app.listen(config.PORT, () => {
			logger.info(`Server running on port ${config.PORT} [${config.NODE_ENV}]`);
		});

		// ─── Graceful shutdown ──────────────────────────────────────────────────
		// Captures the server instance and tears down cleanly on SIGINT / SIGTERM.
		// Stops accepting new connections, waits for in-flight requests to finish,
		// then closes the DB pool and Redis connection before exiting.
		//
		// Redis must be explicitly disconnected — Azure Cache for Redis tracks
		// open connections per instance, and in rolling restarts or scale-in events
		// leaving connections open can exhaust the connection limit on the new
		// instance before the old one's TCP connections time out on their own.
		const shutdown = (signal) => async () => {
			logger.info(`${signal} received — shutting down gracefully`);

			server.close(async (err) => {
				if (err) {
					logger.fatal({ err }, "Error closing HTTP server");
					process.exit(1);
				}

				// Close PostgreSQL pool — waits for in-flight queries to complete
				// then releases all connections back to the server.
				try {
					await pool.end();
					logger.info("PostgreSQL pool closed");
				} catch (poolErr) {
					logger.error({ err: poolErr }, "Error closing PostgreSQL pool");
				}

				// Disconnect Redis — sends QUIT to the server so it can clean up
				// the connection immediately rather than waiting for a TCP timeout.
				// Use quit() rather than disconnect() so any pending commands that
				// were queued before the signal arrived are flushed first.
				try {
					await redis.quit();
					logger.info("Redis connection closed");
				} catch (redisErr) {
					logger.error({ err: redisErr }, "Error closing Redis connection");
				}

				logger.info("Shutdown complete");
				process.exit(0);
			});

			// Force exit if shutdown takes longer than 10 seconds
			setTimeout(() => {
				logger.fatal("Shutdown timeout exceeded — forcing exit");
				process.exit(1);
			}, 10_000).unref();
		};

		process.on("SIGINT", shutdown("SIGINT"));
		process.on("SIGTERM", shutdown("SIGTERM"));
	} catch (err) {
		logger.fatal({ err }, "Server failed to start");
		process.exit(1);
	}
};

process.on("unhandledRejection", (err) => {
	logger.fatal({ err }, "Unhandled promise rejection — shutting down");
	process.exit(1);
});

process.on("uncaughtException", (err) => {
	logger.fatal({ err }, "Uncaught exception — shutting down");
	process.exit(1);
});

start();
