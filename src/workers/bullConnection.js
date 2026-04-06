// src/workers/bullConnection.js
//
// Single source of truth for BullMQ Redis connection options, parsed from the
// validated `config.REDIS_URL` at startup.
//
// ─── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
//
// BullMQ's Queue and Worker constructors accept a `connection` object rather
// than a URL string, so we must decompose the URL ourselves. The original code
// in queue.js and mediaProcessor.js/notificationWorker.js each did this inline,
// but both implementations only extracted host, port, password, and TLS — they
// silently dropped:
//
//   • `username`  — required when the Redis instance uses ACL auth (Redis 6+)
//                   with a non-default user (anything other than "default").
//                   Omitting it causes authentication failure on ACL-secured
//                   clusters while the main app-level `redis` client still works
//                   because node-redis v5 accepts a full connection URL directly.
//
//   • `db`        — the database index encoded in the URL pathname (e.g. "/1").
//                   Redis supports 16 databases (0-15) by default. If the main
//                   app uses DB 1 via its URL but BullMQ silently defaults to 0,
//                   jobs are enqueued in a completely different keyspace from
//                   where the worker is listening, causing silent queue failures
//                   that are very hard to diagnose.
//
// This module parses all five relevant fields in one place so both queue.js and
// notificationWorker.js (and mediaProcessor.js) can import the result instead
// of duplicating the logic.
//
// ─── STRICT DB PATH PARSING ───────────────────────────────────────────────────
//
// The WHATWG URL API parses a Redis URL like `redis://host:6379/1` into a
// pathname of "/1". After stripping the leading slash, the DB index is the
// remaining string. We previously used parseInt() to extract it, which has the
// same partial-parse problem as in hardDeleteCleanup.js: parseInt("1abc", 10)
// silently returns 1, routing BullMQ to DB 1 when the operator probably made a
// typo and meant the default DB 0 (or to catch and fix the misconfiguration).
//
// The fix applies the same guard used for SOFT_DELETE_RETENTION_DAYS:
//   - Only empty/root pathnames ("" or "/") are treated as DB 0 silently.
//   - Any non-empty remainder must match /^[0-9]+$/ (pure decimal digits).
//   - Anything else → logger.warn + fall back to DB 0.
//
// This means `redis://host:6379/1abc` now emits a warning instead of silently
// using DB 1, and `redis://host:6379/1` continues to work as before.
//
// ─── BACKWARD COMPATIBILITY ───────────────────────────────────────────────────
//
// Simple URLs like `redis://:password@host:6379` continue to work unchanged:
//   - username is undefined when the userinfo contains no name (":" prefix)
//   - db defaults to 0 when the pathname is empty or "/"
//   - tls is undefined (not {}) when protocol is "redis:", keeping BullMQ's
//     own TLS-off default

import { config } from "../config/env.js";
import { logger } from "../logger/index.js";

// Accepts only a contiguous run of decimal digits — no sign, no exponent,
// no whitespace, no trailing characters. This is the same pattern used in
// hardDeleteCleanup.js for SOFT_DELETE_RETENTION_DAYS, keeping the two
// parsing strategies consistent across the codebase.
const STRICT_DECIMAL_INTEGER_RE = /^[0-9]+$/;

// Parse once at module load time. config.REDIS_URL is already Zod-validated as
// a valid URL, so `new URL(...)` will not throw here. We still wrap it in a
// try/catch so any future refactor that runs this before Zod validation doesn't
// crash without a meaningful message.
let _bullConnection;

try {
	const parsed = new URL(config.REDIS_URL);

	// ─── DB index parsing ──────────────────────────────────────────────────────
	//
	// Strip the leading "/" from the pathname to isolate the DB index segment.
	// The WHATWG URL API always includes the leading slash in pathname, so for
	//   redis://host:6379/1   → pathname="/1"  → rawDbSegment="1"
	//   redis://host:6379/    → pathname="/"   → rawDbSegment=""
	//   redis://host:6379     → pathname=""    → rawDbSegment=""
	const rawDbSegment = parsed.pathname.replace(/^\//, "");

	let db = 0;

	if (rawDbSegment !== "") {
		// Non-empty segment — must be a pure decimal integer.
		if (!STRICT_DECIMAL_INTEGER_RE.test(rawDbSegment)) {
			// Partial-parse case: something like "/1abc" would give rawDbSegment="1abc".
			// parseInt() would have silently returned 1; we reject it and fall back to 0.
			logger.warn(
				{
					redisUrl: config.REDIS_URL.replace(/:\/\/[^@]+@/, "://***@"), // redact credentials in log
					rawPathname: parsed.pathname,
					rawDbSegment,
					fallback: 0,
					hint: "The DB path segment must be a plain decimal integer (e.g. '/1' for DB 1, or omit for DB 0)",
				},
				`bullConnection: REDIS_URL pathname "${parsed.pathname}" is not a valid DB index — falling back to DB 0`,
			);
			// db stays 0 (already set above)
		} else {
			// Pure decimal string — Number() conversion is safe here.
			const _parsed = Number(rawDbSegment);

			if (!Number.isFinite(_parsed) || _parsed < 0) {
				// This branch is theoretically unreachable because the regex already
				// ensures non-empty decimal digits, but we guard defensively in case
				// of a very large number that exceeds Number's safe integer range.
				logger.warn(
					{ rawDbSegment, fallback: 0 },
					"bullConnection: parsed DB index is not a valid non-negative integer — falling back to DB 0",
				);
				// db stays 0
			} else {
				db = _parsed;
			}
		}
	}

	// ─── ACL username ──────────────────────────────────────────────────────────
	//
	// Extract the ACL username from URL userinfo. The WHATWG URL API percent-
	// decodes the username for us. An empty string means no explicit user was
	// specified — we omit the field entirely so BullMQ uses its own default
	// ("default"), matching the behaviour of passing no username at all.
	const username = parsed.username.length > 0 ? parsed.username : undefined;

	// Password may also be empty for unauthenticated local Redis instances.
	const password = parsed.password.length > 0 ? parsed.password : undefined;

	// ─── TLS ──────────────────────────────────────────────────────────────────
	//
	// ioredis (which BullMQ uses internally) enables TLS when the `tls` option
	// is a truthy object. Passing `tls: {}` is sufficient — ioredis infers the
	// host/port from the sibling fields and applies default TLS settings.
	// We only set it for "rediss:" (the TLS variant of the Redis scheme).
	const tls = parsed.protocol === "rediss:" ? {} : undefined;

	_bullConnection = {
		host: parsed.hostname,
		port: parseInt(parsed.port || "6379", 10),
		...(username !== undefined && { username }),
		...(password !== undefined && { password }),
		...(tls !== undefined && { tls }),
		// Only include db when it is non-zero to avoid overriding BullMQ's default
		// with a redundant zero, keeping the connection object minimal and clear.
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
	// This branch should be unreachable in normal operation because config.js
	// validates REDIS_URL as a valid URL at startup (Zod exits the process on
	// failure). We guard defensively so any future change to the startup order
	// surfaces a clear error instead of a cryptic downstream crash.
	logger.fatal({ err }, "bullConnection: failed to parse REDIS_URL — cannot start workers");
	process.exit(1);
}

// Export as a frozen object so no module can accidentally mutate the shared
// connection config (e.g. setting tls: null in a test without restoring it).
export const bullConnection = Object.freeze(_bullConnection);
