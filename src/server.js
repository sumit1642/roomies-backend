// src/server.js
// Bootstrap: connects PostgreSQL, Redis, the media worker, and the notification
// worker, registers cron maintenance jobs, starts the HTTP server, and tears
// everything down cleanly in dependency-reverse order on SIGINT/SIGTERM.

import "./config/env.js";

import { app } from "./app.js";
import { pool } from "./db/client.js";
import { redis, connectRedis } from "./cache/client.js";
import { logger } from "./logger/index.js";
import { config } from "./config/env.js";
import { startMediaWorker } from "./workers/mediaProcessor.js";
import { startNotificationWorker } from "./workers/notificationWorker.js";
import { closeAllQueues } from "./workers/queue.js";
import { registerListingExpiryCron } from "./cron/listingExpiry.js";
import { registerExpiryWarningCron } from "./cron/expiryWarning.js";
import { registerHardDeleteCleanupCron } from "./cron/hardDeleteCleanup.js";

const start = async () => {
	try {
		await pool.query("SELECT 1");
		logger.info("PostgreSQL connected");

		await connectRedis();
		logger.info("Redis connected");

		// Both workers must start after Redis is ready — BullMQ uses Redis as its
		// backing store. Store both instances so shutdown can call .close() on each
		// before Redis disconnects.
		const mediaWorker = startMediaWorker();
		const notificationWorker = startNotificationWorker();

		// ── Cron jobs ─────────────────────────────────────────────────────────────
		//
		// Cron jobs are registered after Redis and the DB are confirmed healthy so
		// any job that runs immediately on registration has a working DB pool and
		// queue connection available. Each register* function returns a node-cron
		// ScheduledTask so we can call task.stop() during graceful shutdown.
		//
		// node-cron tasks hold no async work open after stop() — they are lightweight
		// timer wrappers and do not need to be awaited during shutdown.
		const cronTasks = [registerListingExpiryCron(), registerExpiryWarningCron(), registerHardDeleteCleanupCron()];

		const server = app.listen(config.PORT, () => {
			logger.info(`Server running on port ${config.PORT} [${config.NODE_ENV}]`);
		});

		// ─── Re-entrancy guard ────────────────────────────────────────────────────
		let isShuttingDown = false;

		// Shutdown order: HTTP → cron → workers → queues → PostgreSQL → Redis.
		// Cron jobs are stopped before workers so a running job does not try to
		// enqueue to BullMQ after the workers have started draining. Workers are
		// closed before queues for the same reason — the worker must finish its
		// in-flight job (which may enqueue notifications) before the queue
		// connection it would write to is torn down.
		const shutdown = (signal) => async () => {
			if (isShuttingDown) {
				logger.warn(`${signal} received again during shutdown — ignoring duplicate signal`);
				return;
			}
			isShuttingDown = true;

			logger.info(`${signal} received — shutting down gracefully`);

			setTimeout(() => {
				logger.fatal("Shutdown timeout exceeded — forcing exit");
				process.exit(1);
			}, 10_000).unref();

			server.close(async (err) => {
				if (err) {
					logger.fatal({ err }, "Error closing HTTP server");
					process.exit(1);
				}

				// Stop all cron jobs. node-cron.stop() prevents future ticks but does
				// not interrupt a job that is currently executing — those will complete
				// naturally (or be abandoned when the process exits if they exceed the
				// 10-second timeout above).
				for (const task of cronTasks) {
					try {
						task.stop();
					} catch (cronErr) {
						logger.error({ err: cronErr }, "Error stopping cron task");
					}
				}
				logger.info("Cron jobs stopped");

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

				try {
					await closeAllQueues();
					logger.info("BullMQ queues closed");
				} catch (queueErr) {
					logger.error({ err: queueErr }, "Error closing BullMQ queues");
				}

				try {
					await pool.end();
					logger.info("PostgreSQL pool closed");
				} catch (poolErr) {
					logger.error({ err: poolErr }, "Error closing PostgreSQL pool");
				}

				try {
					await redis.close();
					logger.info("Redis connection closed");
				} catch (redisErr) {
					logger.error({ err: redisErr }, "Error closing Redis connection");
				}

				logger.info("Shutdown complete");
				process.exit(0);
			});
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
