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

		const mediaWorker = startMediaWorker();
		const notificationWorker = startNotificationWorker();
		const emailWorker = startEmailWorker();

		const verificationEventWorker = startVerificationEventWorker();

		const cronTasks = [registerListingExpiryCron(), registerExpiryWarningCron(), registerHardDeleteCleanupCron()];

		const server = app.listen(config.PORT, () => {
			logger.info(`Server running on port ${config.PORT} [${config.NODE_ENV}]`);
		});

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

			setTimeout(() => {
				logger.fatal("Shutdown timeout exceeded — forcing exit");
				process.exit(1);
			}, 10_000).unref();

			const serverClosePromise = new Promise((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});

			for (const task of cronTasks) {
				try {
					task.stop();
				} catch (cronErr) {
					logger.error({ err: cronErr }, "Error stopping cron task");
				}
			}
			logger.info("Cron jobs stopped");

			try {
				await serverClosePromise;
				logger.info("HTTP server closed");
			} catch (err) {
				serverCloseFailed = true;
				logger.error({ err }, "Error closing HTTP server — continuing shutdown cleanup");
			}

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

			try {
				verificationEventWorker.close();
				logger.info("Verification event worker stopped");
			} catch (err) {
				logger.error({ err }, "Error stopping verification event worker");
			}

			try {
				await closeAllQueues();
				logger.info("BullMQ queues closed");
			} catch (err) {
				logger.error({ err }, "Error closing BullMQ queues");
			}

			try {
				await closeRateLimitRedisClient();
				logger.info("Rate-limit Redis client closed");
			} catch (err) {
				logger.error({ err }, "Error closing rate-limit Redis client");
			}

			try {
				await pool.end();
				logger.info("PostgreSQL pool closed");
			} catch (err) {
				logger.error({ err }, "Error closing PostgreSQL pool");
			}

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
