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
// ─── QUOTA TIMING FIX ────────────────────────────────────────────────────────
//
// The previous implementation incremented the Redis counter and set the cookie
// BEFORE the downstream controller ran. This meant a 404 (user not found) or
// any other non-2xx response still consumed one of the caller's 10 reveals,
// which is incorrect — only successful reveals should count against the quota.
//
// Fix: quota is incremented via a res.on("finish") hook that fires AFTER the
// response is sent. The hook inspects res.statusCode and only charges quota on
// 2xx responses. The cookie mirror is also written in this hook using the
// Redis-authoritative count, not the stale safeCookieCount + 1 value.
//
// ─── ATOMICITY ───────────────────────────────────────────────────────────────
//
// The previous INCR → conditional EXPIRE pattern was non-atomic: a process
// crash between the two calls could leave the key with no TTL, making it
// permanent. This version uses a Lua script that performs INCR and SET-TTL-IF-NEW
// atomically in a single round-trip.
//
// ─── COLLISION MONITORING ────────────────────────────────────────────────────
//
// IP+UA fingerprints can collide in shared-NAT environments. We emit a structured
// warning when the counter crosses a configurable threshold (default 50) so
// operators can investigate.

import crypto from "crypto";
import { redis } from "../cache/client.js";
import { logger } from "../logger/index.js";

const COOKIE_NAME = "contactRevealAnonCount";
const MAX_FREE_REVEALS = 10;
const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days, fixed from first reveal
const LOGIN_REDIRECT_PATH = "/login/signup";

// Emit a warning when a single fingerprint exceeds this count.
const HIGH_COUNT_WARNING_THRESHOLD = 50;

// Lua script: atomically INCR the key and set TTL only on the first increment.
// Returns the new count (integer).
const INCR_WITH_INITIAL_TTL_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[1]))
end
return count
`;

let warnedMissingTrustProxy = false;

const anonFingerprint = (req) => {
	const trustProxy = req.app?.get?.("trust proxy");
	const xForwardedFor = req.headers?.["x-forwarded-for"];
	const trustProxyEnabled = Boolean(trustProxy);

	let ip = req.ip ?? "unknown-ip";
	if (!trustProxyEnabled && typeof xForwardedFor === "string" && xForwardedFor.trim()) {
		if (!warnedMissingTrustProxy) {
			warnedMissingTrustProxy = true;
			logger.warn(
				{ trustProxy, reqIp: req.ip, xForwardedFor },
				"contactRevealGate: X-Forwarded-For present but trust proxy disabled; using forwarded fallback IP",
			);
		}
		const forwardedIp = xForwardedFor.split(",")[0]?.trim();
		if (forwardedIp) ip = forwardedIp;
	}

	const ua = req.get("user-agent") ?? "unknown-ua";
	return crypto.createHash("sha256").update(`${ip}|${ua}`).digest("hex");
};

const limitReachedResponse = (res) =>
	res.status(429).json({
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

	// Read the cookie count for a quick pre-check. If the cookie already shows
	// the limit has been reached we can short-circuit without touching Redis.
	const cookieCount = Number.parseInt(req.cookies?.[COOKIE_NAME] ?? "0", 10);
	const safeCookieCount = Number.isFinite(cookieCount) ? cookieCount : 0;

	if (safeCookieCount >= MAX_FREE_REVEALS) {
		logger.debug({ fingerprint: "cookie-blocked" }, "contactRevealGate: guest blocked by cookie count");
		return limitReachedResponse(res);
	}

	// ── Redis pre-check (read only, no increment yet) ─────────────────────────
	//
	// Before allowing the request through, check whether the caller has already
	// exhausted their quota. We do NOT increment here — incrementing happens only
	// after a successful 2xx response via the res.on("finish") hook below.
	//
	// This pre-check is a best-effort guard using the current Redis count. It
	// prevents obviously over-limit callers from even reaching the controller,
	// which is valuable for scraper mitigation. The definitive increment (which
	// enforces the quota for this specific reveal) happens post-response.
	const fingerprint = anonFingerprint(req);
	const redisKey = `contactRevealAnon:${fingerprint}`;

	if (redis?.isOpen) {
		try {
			const currentCount = await redis.get(redisKey);
			const parsedCount = currentCount !== null ? Number.parseInt(currentCount, 10) : 0;

			if (parsedCount >= MAX_FREE_REVEALS) {
				logger.debug(
					{ fingerprintHash: fingerprint, count: parsedCount },
					"contactRevealGate: guest blocked by Redis pre-check",
				);
				return limitReachedResponse(res);
			}
		} catch (redisErr) {
			// Redis unavailable — fall through to cookie-only enforcement.
			// The post-response hook will also degrade gracefully.
			logger.warn(
				{ err: redisErr.message },
				"contactRevealGate: Redis pre-check unavailable — falling back to cookie-only enforcement",
			);
		}
	}

	// ── Register post-response quota hook ─────────────────────────────────────
	//
	// Quota is charged only after a SUCCESSFUL (2xx) response. This means:
	//   - 404 (user not found) → quota NOT consumed
	//   - 500 (server error) → quota NOT consumed
	//   - 200 (reveal successful) → quota IS consumed
	//
	// The hook fires asynchronously after the response is sent. Any error in
	// the hook is logged but does not affect the already-sent response.
	res.on("finish", async () => {
		if (res.statusCode < 200 || res.statusCode >= 300) {
			// Non-2xx: the reveal did not succeed. Do not charge quota.
			return;
		}

		if (redis?.isOpen) {
			try {
				// Atomic INCR + conditional EXPIRE. Returns the new count.
				const newCount = await redis.eval(INCR_WITH_INITIAL_TTL_SCRIPT, {
					keys: [redisKey],
					arguments: [String(TTL_SECONDS)],
				});

				// Collision/abuse monitoring
				if (newCount > HIGH_COUNT_WARNING_THRESHOLD) {
					logger.warn(
						{
							event: "guest_contact_reveal_high_count",
							fingerprintHash: fingerprint,
							count: newCount,
							threshold: HIGH_COUNT_WARNING_THRESHOLD,
							route: req.path,
							userId: req.user?.userId ?? null,
						},
						`contactRevealGate: fingerprint count ${newCount} exceeds threshold — possible NAT collision or abuse`,
					);
				}

				logger.debug(
					{
						event: "guest_contact_reveal_charged",
						fingerprintHash: fingerprint,
						count: newCount,
						userId: req.user?.userId ?? null,
					},
					"contactRevealGate: quota charged post-response",
				);

				// Write the Redis-authoritative count to the cookie mirror.
				// Using the value Redis just returned (not safeCookieCount + 1)
				// ensures the cookie stays in sync even if the cookie was cleared
				// mid-session. This is the correct authoritative value.
				res.cookie(COOKIE_NAME, String(newCount), {
					httpOnly: true,
					secure: process.env.NODE_ENV === "production",
					sameSite: "lax",
					maxAge: TTL_SECONDS * 1000,
				});
			} catch (redisErr) {
				// Fire-and-forget — the response is already sent. Log and continue.
				logger.warn(
					{ err: redisErr.message },
					"contactRevealGate: post-response Redis increment failed — cookie fallback used",
				);
				// Fallback: increment the cookie-based count even if Redis failed.
				// This degrades gracefully: Redis is the enforcer when available,
				// cookie is the last line of defense.
				res.cookie(COOKIE_NAME, String(safeCookieCount + 1), {
					httpOnly: true,
					secure: process.env.NODE_ENV === "production",
					sameSite: "lax",
					maxAge: TTL_SECONDS * 1000,
				});
			}
		} else {
			// Redis not available — use cookie-only fallback count.
			res.cookie(COOKIE_NAME, String(safeCookieCount + 1), {
				httpOnly: true,
				secure: process.env.NODE_ENV === "production",
				sameSite: "lax",
				maxAge: TTL_SECONDS * 1000,
			});
		}
	});

	// Attach the gate context for the controller. emailOnly=true for all
	// guests and unverified users — the controller and service respect this.
	req.contactReveal = { emailOnly: true, verified: false };
	return next();
};
