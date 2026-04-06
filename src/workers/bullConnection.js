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
// notificationWorker.js (and mediaProcessor.js, which also parses inline) can
// import the result instead of duplicating the logic.
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

// Parse once at module load time. config.REDIS_URL is already Zod-validated as
// a valid URL, so `new URL(...)` will not throw here. We still wrap it in a
// try/catch so any future refactor that runs this before Zod validation doesn't
// crash without a meaningful message.
let _bullConnection;

try {
	const parsed = new URL(config.REDIS_URL);

	// Extract the database index from the URL pathname. The WHATWG URL standard
	// encodes the Redis DB number as the first path segment, e.g. "/1" for DB 1.
	// We strip the leading "/" and fall back to 0 for empty or root-only paths.
	const rawPath = parsed.pathname.replace(/^\//, ""); // strip leading "/"
	const db = rawPath.length > 0 ? parseInt(rawPath, 10) : 0;
	const safeDb = Number.isFinite(db) && db >= 0 ? db : 0;

	// Extract the ACL username from URL userinfo. The WHATWG URL API percent-
	// decodes the username for us. An empty string means no explicit user was
	// specified — we omit the field entirely so BullMQ uses its own default
	// ("default"), matching the behaviour of passing no username at all.
	const username = parsed.username.length > 0 ? parsed.username : undefined;

	// Password may also be empty for unauthenticated local Redis instances.
	const password = parsed.password.length > 0 ? parsed.password : undefined;

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
		...(safeDb !== 0 && { db: safeDb }),
	};

	logger.debug(
		{
			host: _bullConnection.host,
			port: _bullConnection.port,
			hasUsername: username !== undefined,
			hasPassword: password !== undefined,
			tls: tls !== undefined,
			db: safeDb,
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
