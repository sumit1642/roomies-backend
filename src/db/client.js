import pg from "pg";
import { config } from "../config/env.js";
import { logger } from "../logger/index.js";

const { Pool } = pg;

const parsedPoolMax = Number.parseInt(process.env.DB_POOL_MAX ?? "", 10);
const DB_POOL_MAX = Number.isInteger(parsedPoolMax) && parsedPoolMax > 0 ? parsedPoolMax : 10;

export const pool = new Pool({
	connectionString: config.DATABASE_URL,
	max: DB_POOL_MAX,
	idleTimeoutMillis: 30_000,
	connectionTimeoutMillis: 5_000,
});

pool.on("connect", () => {
	logger.debug("pg pool: new client connected");
});

const fatalCodes = new Set(["ECONNREFUSED", "ENOTFOUND"]);

pool.on("error", (err) => {
	logger.error({ err }, "pg pool: unexpected error on idle client");
	if (fatalCodes.has(err.code)) {
		logger.fatal({ err }, "pg pool: unrecoverable connection error — shutting down");
		process.exit(1);
	}
});

export const query = (text, params) => pool.query(text, params);
