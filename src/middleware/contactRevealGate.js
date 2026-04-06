// src/middleware/contactRevealGate.js
//
// ─── CONTACT REVEAL ACCESS POLICY ────────────────────────────────────────────
//
// This middleware sits between optionalAuthenticate and the reveal controller.
// It enforces a two-tier access model:
//
//   VERIFIED USERS (authenticated + isEmailVerified === true)
//     → Unlimited reveals. Pass straight through. The controller will return
//       the full contact bundle (email + whatsapp_phone).
//
//   GUESTS / UNVERIFIED USERS (unauthenticated, or authenticated but unverified)
//     → Up to 10 email-only reveals in a 30-day rolling window. On the 11th
//       attempt the middleware short-circuits with CONTACT_REVEAL_LIMIT_REACHED.
//       The controller will return email only (no whatsapp_phone) for callers
//       in this tier — this is signalled via req.contactReveal.emailOnly = true.
//
// ─── COUNTING STRATEGY ───────────────────────────────────────────────────────
//
// The primary counter lives in Redis, keyed on a SHA-256 fingerprint of the
// caller's IP address and User-Agent string. This survives cookie clears.
// A mirror count is stored in an HttpOnly cookie as a fallback so the gate
// continues to function if Redis is temporarily unavailable (fail-open with
// cookie-only enforcement rather than fail-closed blocking all guests).
//
// Every request to a reveal endpoint increments the counter, regardless of
// which target ID is being revealed. Client-side caching (in-memory, tab-scoped)
// is expected to prevent redundant requests for already-revealed contacts within
// a session — the backend does not deduplicate by target ID.
//
// The 30-day TTL is set on the first increment and is not renewed on subsequent
// ones. This means the window is fixed from the guest's first reveal, not rolling
// from their most recent one — a deliberate choice that makes the limit
// predictable and prevents indefinite extension through occasional use.
//
// ─── ANALYTICS ───────────────────────────────────────────────────────────────
//
// Every guest reveal attempt is logged as a structured event so visitor traffic
// can be analysed independently of the quota enforcement. The log entry includes
// the fingerprint hash (never the raw IP or UA), the current counter value, and
// whether the request was allowed or blocked. Wire these into your analytics
// pipeline when ready.

import crypto from "crypto";
import { redis } from "../cache/client.js";
import { logger } from "../logger/index.js";

const COOKIE_NAME = "contactRevealAnonCount";
const MAX_FREE_REVEALS = 10;
const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days, fixed from first reveal
const LOGIN_REDIRECT_PATH = "/login/signup";

// Produces a stable, opaque fingerprint for a guest caller. We hash rather than
// store raw values so the key never contains PII. The fingerprint will collide
// across users sharing an IP (e.g. NAT, office networks, university campuses)
// but that is an acceptable trade-off for this feature's threat model — we are
// rate-limiting casual scraping, not building a fraud detection system.
const anonFingerprint = (req) => {
	const ip = req.ip ?? "unknown-ip";
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
	//
	// isEmailVerified is populated by both authenticate and optionalAuthenticate.
	// A user who is logged in but has not verified their email falls through to
	// the guest tier below, which is intentional: verification is the threshold
	// for unlimited access, not mere registration.
	if (req.user?.isEmailVerified === true) {
		// Signal to the controller that the full contact bundle should be returned.
		req.contactReveal = { emailOnly: false, verified: true };
		return next();
	}

	// ── Tier 2: guest / unverified — quota-gated, email only ─────────────────

	// Read the cookie count first. If it already shows the limit has been
	// reached we can short-circuit without touching Redis, saving a network
	// round-trip on the hot rejection path.
	const cookieCount = Number.parseInt(req.cookies?.[COOKIE_NAME] ?? "0", 10);
	const safeCookieCount = Number.isFinite(cookieCount) ? cookieCount : 0;

	if (safeCookieCount >= MAX_FREE_REVEALS) {
		logger.debug({ fingerprint: "cookie-blocked" }, "contactRevealGate: guest blocked by cookie count");
		return limitReachedResponse(res);
	}

	// Attempt Redis-backed counting. We use a two-step INCR + conditional EXPIRE
	// so that the TTL is set only on the very first increment (counter === 1).
	// Subsequent increments within the 30-day window do not reset the expiry,
	// keeping the window fixed from the guest's first reveal attempt.
	let redisCount = null;
	const fingerprint = anonFingerprint(req);
	const redisKey = `contactRevealAnon:${fingerprint}`;

	if (redis?.isOpen) {
		try {
			redisCount = await redis.incr(redisKey);

			// Set the TTL only on first increment. If we always called EXPIRE we
			// would keep sliding the window forward on every reveal, allowing
			// indefinite extension through occasional use.
			if (redisCount === 1) {
				await redis.expire(redisKey, TTL_SECONDS);
			}

			// Analytics: log every guest reveal attempt with current counter value.
			// Use the hashed fingerprint, never raw IP or UA.
			logger.info(
				{
					event: "guest_contact_reveal_attempt",
					fingerprintHash: fingerprint,
					count: redisCount,
					allowed: redisCount <= MAX_FREE_REVEALS,
					userId: req.user?.userId ?? null, // null for unauthenticated guests
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
			// Redis is unavailable. Fall back to cookie-only enforcement.
			// We already checked the cookie above and it was under the limit,
			// so we allow the request through. The cookie will be incremented
			// below as the sole tracking mechanism until Redis recovers.
			logger.warn(
				{ err: redisErr.message },
				"contactRevealGate: Redis unavailable — falling back to cookie-only enforcement",
			);
		}
	}

	// Increment and set the mirror cookie. We write this regardless of whether
	// Redis succeeded so the cookie always reflects the most recent known count.
	// The cookie is HttpOnly to prevent client-side tampering, but it is the
	// weaker of the two controls — a sophisticated user could clear it. Redis is
	// the authoritative counter when available.
	const nextCount = safeCookieCount + 1;
	res.cookie(COOKIE_NAME, String(nextCount), {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax", // lax (not strict) so the cookie survives navigation from external links
		maxAge: TTL_SECONDS * 1000,
	});

	// Signal to the controller that only email should be returned, not WhatsApp.
	req.contactReveal = { emailOnly: true, verified: false };
	return next();
};
