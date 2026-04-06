// src/middleware/authenticate.js

import jwt from "jsonwebtoken";
import { config } from "../config/env.js";
import { AppError } from "./errorHandler.js";
import { findUserById } from "../db/utils/auth.js";
import { redis } from "../cache/client.js";
import { pool } from "../db/client.js";
import { casRefreshToken, parseTtlSeconds, verifyRefreshTokenPayload } from "../services/auth.service.js";

const INACTIVE_STATUSES = new Set(["suspended", "banned", "deactivated"]);
const ACCESS_TTL_SECONDS = parseTtlSeconds(config.JWT_EXPIRES_IN, 15 * 60);
const REFRESH_TTL_SECONDS = parseTtlSeconds(config.JWT_REFRESH_EXPIRES_IN, 7 * 24 * 60 * 60);

// Cookie options are module-scope constants because a cookie set with a given
// sameSite/secure configuration must be cleared or replaced with the exact same
// flags — mismatched options cause browsers to treat them as different cookies.
const ACCESS_COOKIE_OPTIONS = {
	httpOnly: true,
	secure: config.NODE_ENV === "production",
	sameSite: "strict",
	maxAge: ACCESS_TTL_SECONDS * 1000,
};
const REFRESH_COOKIE_OPTIONS = {
	httpOnly: true,
	secure: config.NODE_ENV === "production",
	sameSite: "strict",
	maxAge: REFRESH_TTL_SECONDS * 1000,
};

const refreshTokenKey = (userId, sid) => `refreshToken:${userId}:${sid}`;

// Extracts the access token from req.cookies.accessToken (priority) or the
// Authorization: Bearer header. Returns { token, source } or null.
// Cookie takes priority so browser clients always use the secure HttpOnly path.
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

// Attempts a silent refresh when the access token cookie is expired.
// Uses verifyRefreshTokenPayload (which migrates legacy tokens that lack a sid)
// rather than raw jwt.verify, so users with pre-sid tokens are not forced to
// re-login when their access token expires.
//
// On success: issues a new access token and rotates the refresh token via CAS,
// sets replacement cookies, and returns { userId, sid }.
// On any failure: returns null — the caller will respond with 401.
const attemptSilentRefresh = async (req, res) => {
	const refreshToken = req.cookies?.refreshToken;
	if (!refreshToken) return null;

	let refreshPayload;
	try {
		// verifyRefreshTokenPayload handles legacy tokens (no sid) by migrating them
		// to the per-session key scheme. Raw jwt.verify would reject those tokens,
		// forcing a re-login unnecessarily.
		refreshPayload = await verifyRefreshTokenPayload(refreshToken);
	} catch {
		return null;
	}

	if (!refreshPayload?.userId || !refreshPayload?.sid) {
		return null;
	}

	// Verify the token is still stored in Redis (not revoked via logout/revokeSession).
	const storedToken = await redis.get(refreshTokenKey(refreshPayload.userId, refreshPayload.sid));
	if (!storedToken || storedToken !== refreshToken) {
		return null;
	}

	// Load fresh user state — the refresh token payload can be up to 7 days old.
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
		{ userId: refreshPayload.userId, email: userRows[0].email, roles, sid: refreshPayload.sid },
		config.JWT_SECRET,
		{ expiresIn: ACCESS_TTL_SECONDS },
	);
	const newRefreshToken = jwt.sign(
		{ userId: refreshPayload.userId, sid: refreshPayload.sid },
		config.JWT_REFRESH_SECRET,
		{ expiresIn: REFRESH_TTL_SECONDS },
	);
	const expiryTimestamp = Math.floor(Date.now() / 1000) + REFRESH_TTL_SECONDS;

	const rotated = await casRefreshToken(
		refreshPayload.userId,
		refreshPayload.sid,
		refreshToken,
		newRefreshToken,
		REFRESH_TTL_SECONDS,
		expiryTimestamp,
	);
	if (!rotated) {
		return null;
	}

	res.cookie("accessToken", newAccessToken, ACCESS_COOKIE_OPTIONS);
	res.cookie("refreshToken", newRefreshToken, REFRESH_COOKIE_OPTIONS);

	return { userId: refreshPayload.userId, sid: refreshPayload.sid };
};

// Verifies the access token, loads the user from DB, and attaches req.user.
// Cookie-source expired tokens trigger a silent refresh (browser UX).
// Header-source expired tokens return 401 immediately (Android handles refresh explicitly).
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
			if (err.name === "TokenExpiredError" && source === "cookie") {
				const session = await attemptSilentRefresh(req, res);
				if (!session?.userId) {
					return next(new AppError("Session expired", 401));
				}
				payload = session;
			} else {
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
