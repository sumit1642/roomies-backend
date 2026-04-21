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

// ─── Cross-origin cookie policy ───────────────────────────────────────────────
//
// In production the frontend (Vercel) and backend (Render) are on different
// domains. Browsers apply the following rules:
//
//   sameSite: "strict"  → cookie is NEVER sent cross-site, even with
//                          credentials: "include". Auth breaks completely.
//   sameSite: "lax"     → cookie is sent on top-level navigations (GET) but
//                          NOT on cross-origin fetch with credentials. Still
//                          broken for API calls.
//   sameSite: "none"    → sent on all cross-site requests, but REQUIRES
//                          secure: true (HTTPS only).
//
// In practice, for a cross-domain SPA + API architecture the correct approach
// is to use sameSite: "none" + secure: true in production so the browser
// actually sends the cookie on every credentialed fetch.
//
// We also support the X-Client-Transport: bearer header (sent by the frontend
// in production). When present, the auth controller returns tokens in the JSON
// body AND sets cookies. The frontend stores tokens in memory/sessionStorage
// and sends them as Authorization: Bearer headers — completely bypassing the
// cross-domain cookie problem.
//
// Cookie options for each environment:
//   development  → sameSite: "lax",  secure: false  (localhost HTTP)
//   production   → sameSite: "none", secure: true   (cross-domain HTTPS)

const IS_PROD = config.NODE_ENV === "production";

export const ACCESS_COOKIE_OPTIONS = {
	httpOnly: true,
	secure: IS_PROD,
	sameSite: IS_PROD ? "none" : "lax",
	maxAge: ACCESS_TTL_SECONDS * 1000,
};

export const REFRESH_COOKIE_OPTIONS = {
	httpOnly: true,
	secure: IS_PROD,
	sameSite: IS_PROD ? "none" : "lax",
	maxAge: REFRESH_TTL_SECONDS * 1000,
};

const refreshTokenKey = (userId, sid) => `refreshToken:${userId}:${sid}`;

const extractToken = (req) => {
	// Authorization: Bearer <token> takes priority over cookies for
	// cross-origin clients that use the bearer transport.
	const authHeader = req.headers.authorization;
	if (authHeader && authHeader.startsWith("Bearer ")) {
		return { token: authHeader.slice(7), source: "header" };
	}

	const cookieToken = req.cookies?.accessToken;
	if (cookieToken) {
		return { token: cookieToken, source: "cookie" };
	}

	return null;
};

const attemptSilentRefresh = async (req, res) => {
	const refreshToken = req.cookies?.refreshToken;
	if (!refreshToken) return null;

	let refreshPayload;
	try {
		refreshPayload = await verifyRefreshTokenPayload(refreshToken);
	} catch {
		return null;
	}

	if (!refreshPayload?.userId || !refreshPayload?.sid) {
		return null;
	}

	const storedToken = await redis.get(refreshTokenKey(refreshPayload.userId, refreshPayload.sid));
	if (!storedToken || storedToken !== refreshToken) {
		return null;
	}

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
			// Only attempt silent cookie-based refresh for cookie-sourced tokens.
			// Header-sourced tokens (bearer transport) handle refresh client-side.
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
