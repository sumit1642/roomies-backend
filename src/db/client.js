import pg from "pg";
import { config } from "../config/env.js";
import { logger } from "../logger/index.js";

const { Pool } = pg;

export const pool = new Pool({
	connectionString: config.DATABASE_URL,

	max: 20,

	idleTimeoutMillis: 30_000,

	connectionTimeoutMillis: 5_000,
});

pool.on("connect", () => {
	logger.debug("pg pool: new client connected");
});
















pool.on("error", (err) => {
	logger.error({ err }, "pg pool: unexpected error on idle client");

	if (fatalCodes.has(err.code)) {
		logger.fatal({ err }, "pg pool: unrecoverable connection error — shutting down");
		process.exit(1);
	}
});




const fatalCodes = new Set(["ECONNREFUSED", "ENOTFOUND"]);

export const query = (text, params) => pool.query(text, params);
