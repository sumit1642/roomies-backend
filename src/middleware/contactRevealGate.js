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
// ─── QUOTA TIMING — INTERCEPT BEFORE HEADERS ARE SENT ────────────────────────
//
// The original implementation incremented the Redis counter and wrote the cookie
// inside a `res.on("finish")` listener. The `finish` event fires AFTER the
// response has been completely flushed to the network, at which point
// `res.setHeader()` (called internally by `res.cookie()`) silently fails or
// throws ERR_HTTP_HEADERS_SENT — the cookie is never actually delivered to the
// browser, making the quota unenforceable.
//
// The fix wraps the three response-ending methods `res.json`, `res.send`, and
// `res.end` so that quota charging and cookie writing happen BEFORE the original
// method is invoked, while headers are still open. The wrapper is idempotent —
// once chargeQuota has run it unsets itself so it cannot fire twice even if
// downstream code calls both `res.json` and `res.end`.
//
// We only charge quota when `res.statusCode` is 2xx at call time (i.e. the
// controller produced a successful reveal). Non-2xx responses (404 user not
// found, 500 server error) do not consume a slot from the caller's allowance.
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

// ─── Response-interception helper ────────────────────────────────────────────
//
// Wraps res.json, res.send, and res.end so that chargeQuota() runs synchronously
// (for cookie writes) and asynchronously (for Redis) BEFORE the original method
// flushes the response. The wrapper is one-shot: after the first call it removes
// itself to prevent double-charging if the controller invokes multiple
// response-ending methods (which is unusual but possible with some error paths).
//
// Why wrap all three? Express's res.json calls res.send which calls res.end, but
// some middleware and error handlers call res.end directly. Wrapping all three
// ensures we never miss a response regardless of how it was terminated.
const installPreResponseHook = (res, safeCookieCount, fingerprint, redisKey) => {
	let charged = false;

	// chargeQuota attempts to increment the Redis counter and set the cookie.
	// It is called from within the wrapped response methods while headers are
	// still open, so res.cookie() works correctly.
	//
	// The function is intentionally synchronous for the cookie write (which is
	// a pure in-process header mutation) and fire-and-forget for the Redis EVAL
	// (which requires a network round-trip). Setting the cookie with the
	// optimistic new count (safeCookieCount + 1) before the Redis result returns
	// is correct because: (a) the cookie is only a best-effort pre-check that
	// avoids a Redis round-trip for obviously-over-limit callers, and (b) the
	// Redis counter is the authoritative source — a later request will read it
	// and correct any discrepancy.
	const chargeQuota = (res) => {
		if (charged) return;
		charged = true;

		// Optimistic cookie write using the current known count + 1. This is
		// done synchronously while headers are still open. If Redis returns a
		// different authoritative count, the cookie will be corrected on the
		// next successful reveal.
		res.cookie(COOKIE_NAME, String(safeCookieCount + 1), {
			httpOnly: true,
			secure: process.env.NODE_ENV === "production",
			sameSite: "lax",
			maxAge: TTL_SECONDS * 1000,
		});

		// Fire-and-forget Redis increment. If Redis is available, update the
		// authoritative counter and overwrite the cookie with the real count.
		// We do not await this because we are inside a response method and
		// cannot delay the response for a network call.
		if (redis?.isOpen) {
			redis
				.eval(INCR_WITH_INITIAL_TTL_SCRIPT, {
					keys: [redisKey],
					arguments: [String(TTL_SECONDS)],
				})
				.then((newCount) => {
					if (newCount > HIGH_COUNT_WARNING_THRESHOLD) {
						logger.warn(
							{
								event: "guest_contact_reveal_high_count",
								fingerprintHash: fingerprint,
								count: newCount,
								threshold: HIGH_COUNT_WARNING_THRESHOLD,
							},
							`contactRevealGate: fingerprint count ${newCount} exceeds threshold — possible NAT collision or abuse`,
						);
					}
					logger.debug(
						{
							event: "guest_contact_reveal_charged",
							fingerprintHash: fingerprint,
							count: newCount,
						},
						"contactRevealGate: quota charged",
					);
					// We cannot update the cookie here since the response has already
					// been sent. The Redis-authoritative count will be read on the next
					// request's pre-check and will self-correct any optimistic drift.
				})
				.catch((redisErr) => {
					logger.warn(
						{ err: redisErr.message },
						"contactRevealGate: async Redis increment failed — cookie-only fallback used",
					);
				});
		}
	};

	// Wrap the three response-ending methods. Each wrapper checks statusCode at
	// call time: only 2xx responses are charged. The original method is always
	// called regardless of whether charging happened.
	const wrapMethod = (methodName) => {
		const original = res[methodName].bind(res);
		res[methodName] = (...args) => {
			const code = res.statusCode;
			if (code >= 200 && code < 300) {
				chargeQuota(res);
			}
			// Restore originals before calling to prevent infinite recursion if
			// the original method itself calls another wrapped method.
			res.json = originalJson;
			res.send = originalSend;
			res.end = originalEnd;
			return original(...args);
		};
	};

	// Capture original references before any wrapping occurs so the restore
	// inside each wrapper points to the genuine originals, not another wrapper.
	const originalJson = res.json.bind(res);
	const originalSend = res.send.bind(res);
	const originalEnd = res.end.bind(res);

	wrapMethod("json");
	wrapMethod("send");
	wrapMethod("end");
};

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
	// after a successful 2xx response via the pre-response hook below.
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
			logger.warn(
				{ err: redisErr.message },
				"contactRevealGate: Redis pre-check unavailable — falling back to cookie-only enforcement",
			);
		}
	}

	// ── Install pre-response hook ─────────────────────────────────────────────
	//
	// The hook wraps res.json / res.send / res.end so that quota charging and
	// cookie writing happen BEFORE headers are flushed. This replaces the
	// previous res.on("finish") approach which called res.cookie() after headers
	// were already sent (ERR_HTTP_HEADERS_SENT).
	installPreResponseHook(res, safeCookieCount, fingerprint, redisKey);

	// Attach the gate context for the controller. emailOnly=true for all
	// guests and unverified users — the controller and service respect this.
	req.contactReveal = { emailOnly: true, verified: false };
	return next();
};
