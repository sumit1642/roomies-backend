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
import { closeRateLimitRedisClient } from "./middleware/rateLimiter.js";
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
		// Cron jobs are registered after Redis and the DB are confirmed healthy.
		// Each register* function returns a node-cron ScheduledTask so we can call
		// task.stop() during graceful shutdown.
		const cronTasks = [registerListingExpiryCron(), registerExpiryWarningCron(), registerHardDeleteCleanupCron()];

		const server = app.listen(config.PORT, () => {
			logger.info(`Server running on port ${config.PORT} [${config.NODE_ENV}]`);
		});

		// ─── Re-entrancy guard ────────────────────────────────────────────────────
		let isShuttingDown = false;

		// Shutdown order: HTTP (start drain) → cron → workers → queues →
		//                 rate-limit Redis → PostgreSQL → Redis → exit.
		//
		// Cron tasks are stopped IMMEDIATELY after initiating server.close() but
		// BEFORE awaiting the server drain to complete. This is important: a cron
		// job that fires while we are waiting for in-flight HTTP requests to drain
		// could enqueue new BullMQ jobs AFTER the workers have started closing.
		// Stopping cron first closes that window. The server.close() drain proceeds
		// concurrently — HTTP handlers still finish, but no new cron work starts.
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

			// Step 1: Begin draining HTTP connections. server.close() stops accepting
			// new connections but lets in-flight requests finish. We do NOT await it
			// yet — we stop cron first (see rationale above).
			const serverClosePromise = new Promise((resolve, reject) => {
				server.close((err) => {
					if (err) reject(err);
					else resolve();
				});
			});

			// Step 2: Stop cron jobs immediately so no new maintenance work starts
			// while the rest of the shutdown is in progress. node-cron.stop() is
			// synchronous — it cancels future ticks but does not interrupt a job
			// that is currently executing. Those will complete or be abandoned when
			// the process exits via the 10-second timeout above.
			for (const task of cronTasks) {
				try {
					task.stop();
				} catch (cronErr) {
					logger.error({ err: cronErr }, "Error stopping cron task");
				}
			}
			logger.info("Cron jobs stopped");

			// Step 3: Await the HTTP server drain now that cron is stopped.
			try {
				await serverClosePromise;
				logger.info("HTTP server closed");
			} catch (err) {
				logger.fatal({ err }, "Error closing HTTP server");
				process.exit(1);
			}

			// Step 4: Close BullMQ workers (drain in-flight jobs, then disconnect).
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

			// Step 5: Close BullMQ queues (Redis connections used by the queue registry).
			try {
				await closeAllQueues();
				logger.info("BullMQ queues closed");
			} catch (queueErr) {
				logger.error({ err: queueErr }, "Error closing BullMQ queues");
			}

			// Step 6: Close the dedicated rate-limit Redis client. Without this the
			// socket stays open and Node will not exit cleanly.
			await closeRateLimitRedisClient();

			// Step 7: Close the PostgreSQL pool.
			try {
				await pool.end();
				logger.info("PostgreSQL pool closed");
			} catch (poolErr) {
				logger.error({ err: poolErr }, "Error closing PostgreSQL pool");
			}

			// Step 8: Close the main Redis connection (used by sessions, BullMQ store).
			try {
				await redis.close();
				logger.info("Redis connection closed");
			} catch (redisErr) {
				logger.error({ err: redisErr }, "Error closing Redis connection");
			}

			logger.info("Shutdown complete");
			process.exit(0);
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
