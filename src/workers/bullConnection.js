// Parses config.REDIS_URL into a BullMQ/ioredis connection object. Extracts
// host, port, username, password, TLS flag, and DB index. All five fields are
// derived here once at startup so queue.js and the worker files never duplicate
// this logic.
//
// Strict DB index parsing: the URL pathname segment after stripping "/" must be
// a pure decimal integer (/^[0-9]+$/). Partial-parse values like "1abc" that
// parseInt() would silently accept as 1 are rejected with a warn + fallback to
// DB 0. An empty or root-only pathname is treated as DB 0 without a warning.

import { config } from "../config/env.js";
import { logger } from "../logger/index.js";

const STRICT_DECIMAL_INTEGER_RE = /^[0-9]+$/;

let _bullConnection;

try {
	const parsed = new URL(config.REDIS_URL);

	// Strip the leading "/" so "redis://host/1" gives rawDbSegment = "1".
	const rawDbSegment = parsed.pathname.replace(/^\//, "");

	let db = 0;

	if (rawDbSegment !== "") {
		if (!STRICT_DECIMAL_INTEGER_RE.test(rawDbSegment)) {
			logger.warn(
				{
					redisUrl: config.REDIS_URL.replace(/:\/\/[^@]+@/, "://***@"),
					rawPathname: parsed.pathname,
					rawDbSegment,
					fallback: 0,
					hint: "The DB path segment must be a plain decimal integer (e.g. '/1' for DB 1, or omit for DB 0)",
				},
				`bullConnection: REDIS_URL pathname "${parsed.pathname}" is not a valid DB index — falling back to DB 0`,
			);
		} else {
			const _parsed = Number(rawDbSegment);

			// Number.isSafeInteger catches values beyond Number.MAX_SAFE_INTEGER that
			// Number.isFinite would accept, preventing silent precision loss on very
			// large DB indices (which are invalid anyway — Redis supports 0–15 by default).
			if (!Number.isSafeInteger(_parsed) || _parsed < 0) {
				logger.warn(
					{ rawDbSegment, fallback: 0 },
					"bullConnection: parsed DB index is not a valid non-negative integer — falling back to DB 0",
				);
			} else {
				db = _parsed;
			}
		}
	}

	const username = parsed.username.length > 0 ? parsed.username : undefined;
	const password = parsed.password.length > 0 ? parsed.password : undefined;

	// "rediss:" (double-s) signals TLS. Passing tls: {} is sufficient — ioredis
	// infers host/port from the sibling fields and applies default TLS settings.
	const tls = parsed.protocol === "rediss:" ? {} : undefined;

	_bullConnection = {
		host: parsed.hostname,
		port: parseInt(parsed.port || "6379", 10),
		...(username !== undefined && { username }),
		...(password !== undefined && { password }),
		...(tls !== undefined && { tls }),
		...(db !== 0 && { db }),
	};

	logger.debug(
		{
			host: _bullConnection.host,
			port: _bullConnection.port,
			hasUsername: username !== undefined,
			hasPassword: password !== undefined,
			tls: tls !== undefined,
			db,
		},
		"BullMQ Redis connection options parsed",
	);
} catch (err) {
	logger.fatal({ err }, "bullConnection: failed to parse REDIS_URL — cannot start workers");
	process.exit(1);
}

export const bullConnection = Object.freeze(_bullConnection);
