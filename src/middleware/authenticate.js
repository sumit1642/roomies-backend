// src/middleware/authenticate.js

import jwt from "jsonwebtoken";
import { config } from "../config/env.js";
import { AppError } from "./errorHandler.js";
import { findUserById } from "../db/utils/auth.js";
import { redis } from "../cache/client.js";
import { pool } from "../db/client.js";
import { casRefreshToken, parseTtlSeconds } from "../services/auth.service.js";

const INACTIVE_STATUSES = new Set(["suspended", "banned", "deactivated"]);

// used in auth.controller.js — a cookie set with sameSite:'strict' must also be
// cleared/replaced with sameSite:'strict'. Inconsistent options cause browsers to
// treat them as different cookies, leaving the old one in place.
//
// Defined at module scope for the same reason as INACTIVE_STATUSES — allocated
// once, reused on every silent refresh rather than on every request that doesn't
// need it.
const ACCESS_COOKIE_OPTIONS = {
	httpOnly: true,
	secure: config.NODE_ENV === "production",
	sameSite: "strict",
	maxAge: parseTtlSeconds(config.JWT_EXPIRES_IN, 15 * 60) * 1000,
};
const REFRESH_COOKIE_OPTIONS = {
	httpOnly: true,
	secure: config.NODE_ENV === "production",
	sameSite: "strict",
	maxAge: parseTtlSeconds(config.JWT_REFRESH_EXPIRES_IN, 7 * 24 * 60 * 60) * 1000,
};
const REFRESH_TTL = parseTtlSeconds(config.JWT_REFRESH_EXPIRES_IN, 7 * 24 * 60 * 60);
const refreshTokenKey = (userId, sid) => `refreshToken:${userId}:${sid}`;

//
// Priority chain: cookie first, then Authorization header.
//
// Why this order? Cookies are the more secure transport — they are HttpOnly and
// cannot be read or exfiltrated by JavaScript. If the request carries an access
// token cookie, that is the browser client and we use the secure path. If the
// cookie is absent but a Bearer header is present, that is the Android client
// (or any API consumer) managing its own token lifecycle.
//
// Returns { token, source } where source is 'cookie' or 'header'.
// Returns null if neither is present.
const extractToken = (req) => {
	const cookieToken = req.cookies?.accessToken;
	if (cookieToken) {
		return { token: cookieToken, source: "cookie" };
	}

	const authHeader = req.headers.authorization;
	if (authHeader && authHeader.startsWith("Bearer ")) {
		return { token: authHeader.slice(7), source: "header" };
	}

	return null;
};

//
// Only attempted when:
//   1. The access token came from a cookie (source === 'cookie')
//   2. The access token is expired (not malformed — expired is recoverable)
//   3. A refresh token cookie is present
//   4. The refresh token is valid and matches the Redis-stored value
//
// On success: issues a new access token, sets it as a replacement cookie on the
// outgoing response, and returns the userId from the validated refresh payload so
// the middleware can load the user and continue the request normally.
//
// On failure: returns null. The middleware then falls through to a 401.
// Failures here are not thrown — a silent-refresh failure means the session has
// genuinely ended (both tokens expired or refresh token revoked) and a 401 is
// the correct, expected outcome.
const attemptSilentRefresh = async (req, res) => {
	const refreshToken = req.cookies?.refreshToken;
	if (!refreshToken) return null;

	let refreshPayload;
	try {
		refreshPayload = jwt.verify(refreshToken, config.JWT_REFRESH_SECRET);
	} catch {
		// Expired or malformed refresh token — session is over, return null for 401
		return null;
	}

	if (!refreshPayload?.userId || !refreshPayload?.sid) {
		return null;
	}

	const storedToken = await redis.get(refreshTokenKey(refreshPayload.userId, refreshPayload.sid));
	if (!storedToken || storedToken !== refreshToken) {
		// Token has been revoked (logout from another device) — return null for 401
		return null;
	}

	// We sign a minimal payload here — the full user shape is loaded from the DB
	// below in the main middleware body, just as it is for a normal non-expired request.
	// This avoids any stale data from the refresh token payload being used as req.user.
	//
	// We need roles and email for the JWT payload. Load them fresh rather than
	// trusting the refresh token payload which was issued up to 7 days ago.
	const { rows: roleRows } = await pool.query(`SELECT role_name FROM user_roles WHERE user_id = $1`, [
		refreshPayload.userId,
	]);
	const { rows: userRows } = await pool.query(
		`SELECT email, account_status FROM users WHERE user_id = $1 AND deleted_at IS NULL`,
		[refreshPayload.userId],
	);

	if (!userRows.length) return null;
	if (INACTIVE_STATUSES.has(userRows[0].account_status)) return null;

	const roles = roleRows.map((r) => r.role_name);
	const newAccessToken = jwt.sign(
		{ userId: refreshPayload.userId, email: userRows[0].email, roles },
		config.JWT_SECRET,
		{ expiresIn: config.JWT_EXPIRES_IN },
	);
	const newRefreshToken = jwt.sign(
		{ userId: refreshPayload.userId, sid: refreshPayload.sid },
		config.JWT_REFRESH_SECRET,
		{ expiresIn: config.JWT_REFRESH_EXPIRES_IN },
	);

	const rotated = await casRefreshToken(
		refreshPayload.userId,
		refreshPayload.sid,
		refreshToken,
		newRefreshToken,
		REFRESH_TTL,
	);
	if (!rotated) {
		throw new AppError("Refresh token is invalid or has been revoked", 401);
	}
	res.cookie("accessToken", newAccessToken, ACCESS_COOKIE_OPTIONS);
	res.cookie("refreshToken", newRefreshToken, REFRESH_COOKIE_OPTIONS);

	return { userId: refreshPayload.userId, sid: refreshPayload.sid };
};

//
// Verifies the access token, loads the user from DB, and attaches req.user.
//
// Token source determines what happens on expiry:
//   cookie source  → attempt silent refresh transparently (browser UX)
//   header source  → return 401 immediately (Android handles refresh explicitly)
//
// Any failure — missing token, bad token, non-expired but invalid, user not
// found, inactive account — results in a 401.
export const authenticate = async (req, res, next) => {
	try {
		const extracted = extractToken(req);

		if (!extracted) {
			return next(new AppError("No token provided", 401));
		}

		const { token, source } = extracted;

		let payload;
		try {
			payload = jwt.verify(token, config.JWT_SECRET);
		} catch (err) {
			// On expiry, only browser clients (cookie source) get a silent refresh attempt.
			// Android (header source) receives a 401 and handles refresh itself.
			if (err.name === "TokenExpiredError" && source === "cookie") {
				const session = await attemptSilentRefresh(req, res);
				if (!session?.userId) {
					// Both tokens expired or refresh revoked — session is over
					return next(new AppError("Session expired", 401));
				}
				// Silent refresh succeeded — reconstruct a minimal payload so the rest
				// of the middleware can load the user from the DB normally.
				payload = session;
			} else {
				// JsonWebTokenError (malformed token) or header-source expiry —
				// propagate to global error handler for consistent 401 formatting.
				return next(err);
			}
		}

		const user = await findUserById(payload.userId);
		if (!user) {
			return next(new AppError("User not found", 401));
		}

		if (INACTIVE_STATUSES.has(user.account_status)) {
			return next(new AppError(`Account is ${user.account_status}`, 401));
		}

		// Attach req.user — shape used by every downstream middleware and handler.
		// Unchanged from before this branch — all existing handlers continue to work.
		req.user = {
			userId: user.user_id,
			sid: payload.sid ?? null,
			email: user.email,
			roles: user.roles,
			isEmailVerified: user.is_email_verified,
			accountStatus: user.account_status,
		};

		next();
	} catch (err) {
		next(err);
	}
};
