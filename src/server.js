// src/server.js
//
// Bootstrap: connects PostgreSQL, Redis, all BullMQ workers, the CDC outbox
// drainer, and cron maintenance jobs, then starts the HTTP server. Tears
// everything down cleanly in dependency-reverse order on SIGINT/SIGTERM.

import "./config/env.js";

import { app } from "./app.js";
import { pool } from "./db/client.js";
import { redis, connectRedis } from "./cache/client.js";
import { logger } from "./logger/index.js";
import { config } from "./config/env.js";
import { startMediaWorker } from "./workers/mediaProcessor.js";
import { startNotificationWorker } from "./workers/notificationWorker.js";
import { startEmailWorker } from "./workers/emailWorker.js";
import { startVerificationEventWorker } from "./workers/verificationEventWorker.js";
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

		// ── BullMQ workers ────────────────────────────────────────────────────
		// All workers start after Redis is ready — BullMQ uses Redis as its
		// backing store. Each returns a handle used for clean shutdown.
		const mediaWorker = startMediaWorker();
		const notificationWorker = startNotificationWorker();
		const emailWorker = startEmailWorker();

		// ── CDC outbox drainer ────────────────────────────────────────────────
		// The verification event worker polls the verification_event_outbox table
		// (written by the Postgres trigger trg_verification_status_changed) and
		// dispatches in-app notifications + emails for verification status changes.
		// Crucially, this worker fires regardless of whether the DB change came
		// from the API or from a direct SQL script — the trigger doesn't care.
		const verificationEventWorker = startVerificationEventWorker();

		// ── Cron jobs ─────────────────────────────────────────────────────────
		// Registered after Redis and DB are confirmed healthy. Each register*
		// function returns a node-cron ScheduledTask for clean task.stop() on
		// shutdown.
		const cronTasks = [registerListingExpiryCron(), registerExpiryWarningCron(), registerHardDeleteCleanupCron()];

		const server = app.listen(config.PORT, () => {
			logger.info(`Server running on port ${config.PORT} [${config.NODE_ENV}]`);
		});

		// ── Re-entrancy guard ─────────────────────────────────────────────────
		let isShuttingDown = false;

		// Shutdown order:
		//   1. Stop accepting new HTTP connections (server.close)
		//   2. Stop cron so no new maintenance work starts
		//   3. Await HTTP drain completion
		//   4. Close BullMQ workers (drain in-flight jobs)
		//   5. Stop the CDC outbox drainer (polling loop)
		//   6. Close BullMQ queue registry (Redis connections)
		//   7. Close rate-limit Redis client
		//   8. Close PostgreSQL pool
		//   9. Close main Redis connection
		//   10. Exit
		//
		// Cron is stopped before awaiting HTTP drain (step 2 before step 3) to
		// close the window where a cron job could fire and enqueue new BullMQ
		// jobs after the workers have already started closing.
		const shutdown = (signal) => async () => {
			if (isShuttingDown) {
				logger.warn(`${signal} received again during shutdown — ignoring duplicate signal`);
				return;
			}
			isShuttingDown = true;

			logger.info(`${signal} received — shutting down gracefully`);
			let serverCloseFailed = false;

			// Force exit if graceful shutdown takes longer than 10 seconds.
			setTimeout(() => {
				logger.fatal("Shutdown timeout exceeded — forcing exit");
				process.exit(1);
			}, 10_000).unref();

			// Step 1: begin draining HTTP connections.
			const serverClosePromise = new Promise((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});

			// Step 2: stop cron jobs immediately.
			for (const task of cronTasks) {
				try {
					task.stop();
				} catch (cronErr) {
					logger.error({ err: cronErr }, "Error stopping cron task");
				}
			}
			logger.info("Cron jobs stopped");

			// Step 3: await HTTP drain.
			try {
				await serverClosePromise;
				logger.info("HTTP server closed");
			} catch (err) {
				serverCloseFailed = true;
				logger.error({ err }, "Error closing HTTP server — continuing shutdown cleanup");
			}

			// Step 4: close BullMQ workers.
			for (const [name, worker] of [
				["Media", mediaWorker],
				["Notification", notificationWorker],
				["Email", emailWorker],
			]) {
				try {
					await worker.close();
					logger.info(`${name} worker closed`);
				} catch (err) {
					logger.error({ err }, `Error closing ${name} worker`);
				}
			}

			// Step 5: stop the CDC outbox drainer (synchronous — just clears the interval).
			try {
				verificationEventWorker.close();
				logger.info("Verification event worker stopped");
			} catch (err) {
				logger.error({ err }, "Error stopping verification event worker");
			}

			// Step 6: close BullMQ queue registry.
			try {
				await closeAllQueues();
				logger.info("BullMQ queues closed");
			} catch (err) {
				logger.error({ err }, "Error closing BullMQ queues");
			}

			// Step 7: close rate-limit Redis client.
			try {
				await closeRateLimitRedisClient();
				logger.info("Rate-limit Redis client closed");
			} catch (err) {
				logger.error({ err }, "Error closing rate-limit Redis client");
			}

			// Step 8: close PostgreSQL pool.
			try {
				await pool.end();
				logger.info("PostgreSQL pool closed");
			} catch (err) {
				logger.error({ err }, "Error closing PostgreSQL pool");
			}

			// Step 9: close main Redis connection.
			try {
				await redis.close();
				logger.info("Redis connection closed");
			} catch (err) {
				logger.error({ err }, "Error closing Redis connection");
			}

			logger.info("Shutdown complete");
			process.exit(serverCloseFailed ? 1 : 0);
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
