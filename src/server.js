// src/server.js
// Bootstrap: connects PostgreSQL, Redis, the media worker, and the notification
// worker, starts the HTTP server, and tears everything down cleanly in
// dependency-reverse order on SIGINT/SIGTERM.

import "./config/env.js";

import { app } from "./app.js";
import { pool } from "./db/client.js";
import { redis, connectRedis } from "./cache/client.js";
import { logger } from "./logger/index.js";
import { config } from "./config/env.js";
import { startMediaWorker } from "./workers/mediaProcessor.js";
import { startNotificationWorker } from "./workers/notificationWorker.js";
import { closeAllQueues } from "./workers/queue.js";

const start = async () => {
	try {
		await pool.query("SELECT 1");
		logger.info("PostgreSQL connected");

		await connectRedis();
		logger.info("Redis connected");

		// Both workers must start after Redis is ready — BullMQ uses Redis as its
		// backing store. Store both instances so shutdown can call .close() on each
		// before Redis disconnects. Closing a worker tells BullMQ to stop pulling
		// new jobs and to wait for any in-flight job to finish gracefully.
		const mediaWorker = startMediaWorker();
		const notificationWorker = startNotificationWorker();

		const server = app.listen(config.PORT, () => {
			logger.info(`Server running on port ${config.PORT} [${config.NODE_ENV}]`);
		});

		// Shutdown order: HTTP → workers → queues → PostgreSQL → Redis.
		// Workers and queues must close before Redis because in-flight jobs still
		// need the Redis connection. Redis closes last to avoid exhausting Azure
		// connection limits on repeated restarts.
		const shutdown = (signal) => async () => {
			logger.info(`${signal} received — shutting down gracefully`);

			server.close(async (err) => {
				if (err) {
					logger.fatal({ err }, "Error closing HTTP server");
					process.exit(1);
				}

				// Drain active jobs before closing — worker.close() blocks until the
				// current job finishes, respecting the job retry/fail contract.
				try {
					await mediaWorker.close();
					logger.info("Media worker closed");
				} catch (workerErr) {
					logger.error({ err: workerErr }, "Error closing media worker");
				}

				try {
					await notificationWorker.close();
					logger.info("Notification worker closed");
				} catch (workerErr) {
					logger.error({ err: workerErr }, "Error closing notification worker");
				}

				// Close all BullMQ Queue connections — Promise.allSettled inside
				// closeAllQueues() ensures every queue gets a close attempt even if
				// one fails.
				try {
					await closeAllQueues();
					logger.info("BullMQ queues closed");
				} catch (queueErr) {
					logger.error({ err: queueErr }, "Error closing BullMQ queues");
				}

				// pool.end() waits for in-flight queries to complete before releasing
				// connections back to the pool.
				try {
					await pool.end();
					logger.info("PostgreSQL pool closed");
				} catch (poolErr) {
					logger.error({ err: poolErr }, "Error closing PostgreSQL pool");
				}

				// redis.close() is the correct node-redis v5 method — flushes pending
				// commands before tearing down the TCP connection (quit() is deprecated
				// in Redis 7.2+).
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
