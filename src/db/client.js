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

// for example, the PostgreSQL backend process was killed, or the TCP connection
// was dropped by a network device. In these cases pg has already removed the
// bad client from the pool and will open a fresh connection on the next query.
//
// The previous behaviour was to unconditionally call process.exit(1) here,
// which crashes the entire server for what is often a fully recoverable event.
// A transient backend crash during a low-traffic window would take the whole
// Node process down unnecessarily.
//
// The revised behaviour: log the error so it is visible in Pino / Azure Monitor,
// then check whether the error is genuinely fatal (no way to recover) before
// deciding to exit. For most idle-client errors, logging is sufficient — pg
// will self-heal on the next request. We only exit if the error carries an
// explicit fatal flag or an ECONNREFUSED code, which indicates the database
// server itself is gone and no further queries can succeed anyway.
pool.on("error", (err) => {
	logger.error({ err }, "pg pool: unexpected error on idle client");

	if (fatalCodes.has(err.code)) {
		logger.fatal({ err }, "pg pool: unrecoverable connection error — shutting down");
		process.exit(1);
	}
});

// ENOTFOUND means DNS resolution failed — the host does not exist.
// Both are unrecoverable at runtime; defined once at module scope to avoid
// reallocating on every error event.
const fatalCodes = new Set(["ECONNREFUSED", "ENOTFOUND"]);

export const query = (text, params) => pool.query(text, params);
