// src/server.js
// Bootstrap: connects PostgreSQL, Redis, and the media worker, starts the HTTP server,
// and tears everything down cleanly in dependency-reverse order on SIGINT/SIGTERM.

import "./config/env.js";

import { app } from "./app.js";
import { pool } from "./db/client.js";
import { redis, connectRedis } from "./cache/client.js";
import { logger } from "./logger/index.js";
import { config } from "./config/env.js";
import { startMediaWorker } from "./workers/mediaProcessor.js";
import { closeAllQueues } from "./workers/queue.js";

const start = async () => {
	try {
		await pool.query("SELECT 1");
		logger.info("PostgreSQL connected");

		await connectRedis();
		logger.info("Redis connected");

		// Worker must start after Redis is ready — BullMQ uses Redis as its backing store.
		// Store the instance so shutdown can call worker.close() before Redis disconnects.
		const mediaWorker = startMediaWorker();

		const server = app.listen(config.PORT, () => {
			logger.info(`Server running on port ${config.PORT} [${config.NODE_ENV}]`);
		});

		// Shutdown order: HTTP → worker → queues → PostgreSQL → Redis.
		// Worker and queues must close before Redis because in-flight jobs still need both.
		// Redis must close before the process exits to avoid exhausting Azure connection limits.
		const shutdown = (signal) => async () => {
			logger.info(`${signal} received — shutting down gracefully`);

			server.close(async (err) => {
				if (err) {
					logger.fatal({ err }, "Error closing HTTP server");
					process.exit(1);
				}

				// Drain the active job (if any) before closing queues — worker.close() blocks
				// until the current job finishes, respecting the job retry/fail contract.
				try {
					await mediaWorker.close();
					logger.info("Media worker closed");
				} catch (workerErr) {
					logger.error({ err: workerErr }, "Error closing media worker");
				}

				// Close all BullMQ Queue connections — uses Promise.allSettled so every
				// queue gets a close attempt even if one fails.
				try {
					await closeAllQueues();
					logger.info("BullMQ queues closed");
				} catch (queueErr) {
					logger.error({ err: queueErr }, "Error closing BullMQ queues");
				}

				// Pool.end() waits for in-flight queries to complete before releasing connections.
				try {
					await pool.end();
					logger.info("PostgreSQL pool closed");
				} catch (poolErr) {
					logger.error({ err: poolErr }, "Error closing PostgreSQL pool");
				}

				// redis.close() is the correct node-redis v5 method — flushes pending commands
				// before tearing down the TCP connection (quit() is deprecated in Redis 7.2+).
				try {
					await redis.close();
					logger.info("Redis connection closed");
				} catch (redisErr) {
					logger.error({ err: redisErr }, "Error closing Redis connection");
				}

				logger.info("Shutdown complete");
				process.exit(0);
			});

			// Safety net — force exit if graceful shutdown stalls beyond 10 seconds.
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
