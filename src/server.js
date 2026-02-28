// config/env.js runs its Zod validation the moment it is imported.
// If any environment variable is missing or wrong, process.exit(1) fires here
// before a single route or database connection is attempted.
import "./config/env.js";

import { app } from "./app.js";
import { pool } from "./db/client.js";
import { connectRedis } from "./cache/client.js";
import { logger } from "./logger/index.js";
import { config } from "./config/env.js";

const start = async () => {
	try {
		// Verify database is reachable before accepting traffic.
		// A failed query here means the server won't start — better than
		// starting and serving 500s on every request.
		await pool.query("SELECT 1");
		logger.info("PostgreSQL connected");

		// Connect Redis client — must be called once before any redis.get/set calls.
		await connectRedis();
		logger.info("Redis connected");

		// Start accepting HTTP connections only after all dependencies are up.
		app.listen(config.PORT, () => {
			logger.info(`Server running on port ${config.PORT} [${config.NODE_ENV}]`);
		});
	} catch (err) {
		logger.fatal({ err }, "Server failed to start");
		process.exit(1);
	}
};

// Handle unhandled promise rejections globally — log and exit.
// Without this, a crashed async function might go silently unnoticed.
process.on("unhandledRejection", (err) => {
	logger.fatal({ err }, "Unhandled promise rejection — shutting down");
	process.exit(1);
});

process.on("uncaughtException", (err) => {
	logger.fatal({ err }, "Uncaught exception — shutting down");
	process.exit(1);
});

start();
