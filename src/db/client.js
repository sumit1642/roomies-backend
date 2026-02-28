import pg from "pg";
import { config } from "../config/env.js";
import { logger } from "../logger/index.js";

const { Pool } = pg;

// One pool for the entire process — never create a new Pool per request.
// pg manages the connection lifecycle internally.
export const pool = new Pool({
	connectionString: config.DATABASE_URL,

	// Max connections in the pool.
	// Keep this below your PostgreSQL max_connections setting.
	max: 20,

	// How long (ms) a client can sit idle before being closed.
	idleTimeoutMillis: 30_000,

	// How long (ms) to wait for a connection before throwing an error.
	connectionTimeoutMillis: 5_000,
});

// Log when a new client connects — useful for spotting connection leaks
pool.on("connect", () => {
	logger.debug("pg pool: new client connected");
});

pool.on("error", (err) => {
	logger.error({ err }, "pg pool: unexpected error on idle client");
	process.exit(1);
});

// Convenience wrapper — for simple one-shot queries outside of transactions.
// For transactions, check out a client directly: pool.connect()
export const query = (text, params) => pool.query(text, params);
