// src/middleware/contactRevealGate.js
//
// ─── CONTACT REVEAL ACCESS POLICY ────────────────────────────────────────────
//
// Two-tier access model:
//
//   VERIFIED USERS (authenticated + isEmailVerified === true)
//     → Unlimited reveals. Full contact bundle (email + whatsapp_phone).
//
//   GUESTS / UNVERIFIED USERS
//     → Up to 10 email-only reveals in a 30-day rolling window. On the 11th
//       attempt the middleware short-circuits with CONTACT_REVEAL_LIMIT_REACHED.
//
// ─── COUNTING STRATEGY ───────────────────────────────────────────────────────
//
// Primary counter: Redis, keyed on a SHA-256 fingerprint of IP + User-Agent.
// Fallback: HttpOnly cookie mirror count for Redis-unavailable scenarios.
//
// ─── ATOMICITY FIX ───────────────────────────────────────────────────────────
//
// The previous INCR → conditional EXPIRE pattern was non-atomic: a process crash
// between the two calls could leave the key with no TTL, making it permanent.
// This version uses a Lua script that performs INCR and SET-TTL-IF-NEW atomically
// in a single round-trip. The Lua script runs on the Redis server, so it is
// guaranteed to be atomic — no interleaving is possible between the two operations.
//
// ─── COLLISION MONITORING ────────────────────────────────────────────────────
//
// IP+UA fingerprints can collide in shared-NAT environments (university campuses,
// corporate proxies). A high count from a single fingerprint may indicate either
// a scraper or heavy NAT collision. We emit a structured warning when the counter
// crosses a configurable threshold (default 50) so operators can investigate.

import crypto from "crypto";
import { redis } from "../cache/client.js";
import { logger } from "../logger/index.js";

const COOKIE_NAME = "contactRevealAnonCount";
const MAX_FREE_REVEALS = 10;
const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days, fixed from first reveal
const LOGIN_REDIRECT_PATH = "/login/signup";

// Emit a warning when a single fingerprint exceeds this count. This is above
// MAX_FREE_REVEALS so it fires even after the quota is enforced, helping detect
// shared-IP saturation or abuse patterns.
const HIGH_COUNT_WARNING_THRESHOLD = 50;

// Lua script: atomically INCR the key and set TTL only on the first increment.
// KEYS[1] = the Redis key
// ARGV[1] = TTL in seconds (only applied when the key is brand-new)
//
// Returns the new count (integer).
//
// Why Lua? Redis guarantees that Lua scripts are atomic — no other Redis command
// can run between INCR and the EXPIRE check. This closes the gap where a process
// crash between two separate commands could leave a key without a TTL.
const INCR_WITH_INITIAL_TTL_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[1]))
end
return count
`;

const anonFingerprint = (req) => {
	const ip = req.ip ?? "unknown-ip";
	const ua = req.get("user-agent") ?? "unknown-ua";
	return crypto.createHash("sha256").update(`${ip}|${ua}`).digest("hex");
};

const limitReachedResponse = (res) =>
	res.status(401).json({
		status: "error",
		message: "Free contact reveal limit reached. Please log in or sign up to continue.",
		code: "CONTACT_REVEAL_LIMIT_REACHED",
		loginRedirect: LOGIN_REDIRECT_PATH,
	});

export const contactRevealGate = async (req, res, next) => {
	// ── Tier 1: verified user — unlimited, full bundle ────────────────────────
	if (req.user?.isEmailVerified === true) {
		req.contactReveal = { emailOnly: false, verified: true };
		return next();
	}

	// ── Tier 2: guest / unverified — quota-gated, email only ─────────────────

	// Read the cookie count first. If it already shows the limit has been
	// reached we can short-circuit without touching Redis.
	const cookieCount = Number.parseInt(req.cookies?.[COOKIE_NAME] ?? "0", 10);
	const safeCookieCount = Number.isFinite(cookieCount) ? cookieCount : 0;

	if (safeCookieCount >= MAX_FREE_REVEALS) {
		logger.debug({ fingerprint: "cookie-blocked" }, "contactRevealGate: guest blocked by cookie count");
		return limitReachedResponse(res);
	}

	let redisCount = null;
	const fingerprint = anonFingerprint(req);
	const redisKey = `contactRevealAnon:${fingerprint}`;

	if (redis?.isOpen) {
		try {
			// Atomic INCR + conditional EXPIRE via Lua script. This replaces the
			// previous non-atomic INCR → conditional EXPIRE sequence that could leave
			// a key without a TTL if the process crashed between the two calls.
			redisCount = await redis.eval(INCR_WITH_INITIAL_TTL_SCRIPT, {
				keys: [redisKey],
				arguments: [String(TTL_SECONDS)],
			});

			// ── High-count collision/abuse monitoring ─────────────────────────────
			// Emit a structured warning when a single fingerprint crosses the
			// threshold. This helps operators detect shared-NAT saturation (where
			// many legitimate users share one IP) or deliberate scraping.
			if (redisCount > HIGH_COUNT_WARNING_THRESHOLD) {
				logger.warn(
					{
						event: "guest_contact_reveal_high_count",
						fingerprintHash: fingerprint,
						count: redisCount,
						threshold: HIGH_COUNT_WARNING_THRESHOLD,
						route: req.path,
						userId: req.user?.userId ?? null,
					},
					`contactRevealGate: fingerprint count ${redisCount} exceeds threshold ${HIGH_COUNT_WARNING_THRESHOLD} — possible NAT collision or abuse`,
				);
			}

			logger.debug(
				{
					event: "guest_contact_reveal_attempt",
					fingerprintHash: fingerprint,
					count: redisCount,
					allowed: redisCount <= MAX_FREE_REVEALS,
					userId: req.user?.userId ?? null,
				},
				"contactRevealGate: guest reveal attempt",
			);

			if (redisCount > MAX_FREE_REVEALS) {
				logger.debug(
					{ fingerprintHash: fingerprint, count: redisCount },
					"contactRevealGate: guest blocked by Redis count",
				);
				return limitReachedResponse(res);
			}
		} catch (redisErr) {
			// Redis unavailable — fall back to cookie-only enforcement.
			logger.warn(
				{ err: redisErr.message },
				"contactRevealGate: Redis unavailable — falling back to cookie-only enforcement",
			);
		}
	}

	// Increment and set the mirror cookie.
	const nextCount = safeCookieCount + 1;
	res.cookie(COOKIE_NAME, String(nextCount), {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax",
		maxAge: TTL_SECONDS * 1000,
	});

	req.contactReveal = { emailOnly: true, verified: false };
	return next();
};
