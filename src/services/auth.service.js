// src/services/auth.service.js

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import { config } from "../config/env.js";
import { pool } from "../db/client.js";
import { redis } from "../cache/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";
import { findUserByEmail, findUserByGoogleId } from "../db/utils/auth.js";
import { findInstitutionByDomain } from "../db/utils/institutions.js";
import { sendOtpEmail } from "./email.service.js";

// ─── Google OAuth client ──────────────────────────────────────────────────────
const googleOAuthClient = config.GOOGLE_CLIENT_ID ? new OAuth2Client(config.GOOGLE_CLIENT_ID) : null;

// ─── Account status guard ─────────────────────────────────────────────────────
const INACTIVE_ACCOUNT_STATUSES = new Set(["suspended", "banned", "deactivated"]);

// ─── Token helpers ───────────────────────────────────────────────────────────

const issueAccessToken = (userId, email, roles, sid) =>
	jwt.sign({ userId, email, roles, sid }, config.JWT_SECRET, {
		expiresIn: config.JWT_EXPIRES_IN,
	});

const issueRefreshToken = (userId, sid) =>
	jwt.sign({ userId, sid }, config.JWT_REFRESH_SECRET, {
		expiresIn: config.JWT_REFRESH_EXPIRES_IN,
	});

const issueSessionId = () => crypto.randomUUID();

const refreshTokenKey = (userId, sid) => `refreshToken:${userId}:${sid}`;
const userSessionsKey = (userId) => `userSessions:${userId}`;

export const parseTtlSeconds = (expiresIn, fallbackSeconds = 7 * 24 * 60 * 60) => {
	if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
		return Math.floor(expiresIn);
	}

	const value = String(expiresIn ?? "").trim();
	if (!value) return fallbackSeconds;

	// jsonwebtoken accepts numeric strings too. We interpret plain digits as
	// seconds so env values like JWT_EXPIRES_IN=900 behave as expected.
	if (/^\d+$/.test(value)) {
		return Number.parseInt(value, 10);
	}

	const match = value.match(/^(\d+)([smhd])$/i);
	if (!match) return fallbackSeconds;
	const [, amount, unit] = match;
	const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
	return Number.parseInt(amount, 10) * multipliers[unit.toLowerCase()];
};

const REFRESH_TTL = parseTtlSeconds(config.JWT_REFRESH_EXPIRES_IN);

const buildTokenResponse = (userId, sid, email, roles, isEmailVerified) => {
	const accessToken = issueAccessToken(userId, email, roles, sid);
	const refreshToken = issueRefreshToken(userId, sid);
	return { accessToken, refreshToken, user: { userId, email, roles, isEmailVerified }, sid };
};

const storeRefreshToken = async (userId, sid, refreshToken) => {
	const expiryTimestamp = Math.floor(Date.now() / 1000) + REFRESH_TTL;
	const multi = redis.multi();
	multi.setEx(refreshTokenKey(userId, sid), REFRESH_TTL, refreshToken);
	multi.zAdd(userSessionsKey(userId), { score: expiryTimestamp, value: sid });
	await multi.exec();
};

const deleteSessionToken = async (userId, sid) => {
	const multi = redis.multi();
	multi.del(refreshTokenKey(userId, sid));
	multi.zRem(userSessionsKey(userId), sid);
	await multi.exec();
};

const casRefreshTokenScript = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call("SETEX", KEYS[1], tonumber(ARGV[3]), ARGV[2])
redis.call("ZADD", KEYS[2], tonumber(ARGV[5]), ARGV[4])
return 1
`;

export const casRefreshToken = async (
	userId,
	sid,
	expectedOldToken,
	newToken,
	ttl = REFRESH_TTL,
	expiryTimestamp = Math.floor(Date.now() / 1000) + ttl,
) => {
	const result = await redis.eval(casRefreshTokenScript, {
		keys: [refreshTokenKey(userId, sid), userSessionsKey(userId)],
		arguments: [expectedOldToken, newToken, String(ttl), sid, String(expiryTimestamp)],
	});
	return result === 1;
};

const verifyRefreshTokenPayload = (incomingRefreshToken) => {
	let payload;
	try {
		payload = jwt.verify(incomingRefreshToken, config.JWT_REFRESH_SECRET);
	} catch (err) {
		throw err;
	}

	if (!payload?.userId || !payload?.sid) {
		throw new AppError("Refresh token payload is invalid", 401);
	}

	return payload;
};

// ─── OTP helpers ─────────────────────────────────────────────────────────────

const OTP_TTL = 600; // 10 minutes in seconds
const OTP_MAX_ATTEMPTS = 5;
const OTP_IP_WINDOW_SECONDS = 15 * 60;
const OTP_IP_MAX_ATTEMPTS = 50;

const generateOtp = () => String(crypto.randomInt(100000, 1000000));

// ─── Service methods ─────────────────────────────────────────────────────────

export const register = async ({ email, password, role, fullName, businessName }) => {
	if (role === "pg_owner" && !businessName?.trim()) {
		throw new AppError("Business name is required for PG owner registration", 400);
	}

	const existing = await findUserByEmail(email);
	if (existing) {
		throw new AppError("An account with this email already exists", 409);
	}

	const passwordHash = await bcrypt.hash(password, 10);

	const client = await pool.connect();
	let effectivelyVerified = false;
	try {
		await client.query("BEGIN");

		let user;
		try {
			const { rows: userRows } = await client.query(
				`INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING user_id, email, is_email_verified`,
				[email, passwordHash],
			);
			user = userRows[0];
		} catch (err) {
			if (err.code === "23505") {
				throw new AppError("An account with this email already exists", 409);
			}
			throw err;
		}

		effectivelyVerified = user.is_email_verified;
		if (role === "student") {
			await client.query(
				`INSERT INTO student_profiles (user_id, full_name)
         VALUES ($1, $2)`,
				[user.user_id, fullName],
			);

			const domain = user.email.split("@")[1];
			const institution = await findInstitutionByDomain(domain, client);

			if (institution) {
				await client.query(
					`UPDATE student_profiles
           SET institution_id = $1
           WHERE user_id = $2`,
					[institution.institution_id, user.user_id],
				);
				await client.query(
					`UPDATE users
           SET is_email_verified = TRUE
           WHERE user_id = $1`,
					[user.user_id],
				);
				effectivelyVerified = true;
				logger.info(
					{
						userId: user.user_id,
						institutionId: institution.institution_id,
						institutionName: institution.name,
					},
					"Student auto-verified via institution domain",
				);
			}
		} else {
			await client.query(
				`INSERT INTO pg_owner_profiles (user_id, owner_full_name, business_name)
         VALUES ($1, $2, $3)`,
				[user.user_id, fullName, businessName],
			);
		}

		await client.query(
			`INSERT INTO user_roles (user_id, role_name)
       VALUES ($1, $2)`,
			[user.user_id, role],
		);

		await client.query("COMMIT");

		logger.info({ userId: user.user_id, role }, "User registered");

		const roles = [role];
		const sid = issueSessionId();
		const tokens = buildTokenResponse(user.user_id, sid, user.email, roles, effectivelyVerified);
		await storeRefreshToken(user.user_id, sid, tokens.refreshToken);
		return tokens;
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
};

const DUMMY_HASH = "$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi";

export const login = async ({ email, password }) => {
	const user = await findUserByEmail(email);

	const hashToCompare = user ? user.password_hash : DUMMY_HASH;
	const effectiveHash = hashToCompare ?? DUMMY_HASH;
	const passwordMatch = await bcrypt.compare(password, effectiveHash);

	if (!passwordMatch || !user) {
		throw new AppError("Invalid credentials", 401);
	}

	if (INACTIVE_ACCOUNT_STATUSES.has(user.account_status)) {
		throw new AppError(`Account is ${user.account_status}`, 401);
	}

	const { rows: roleRows } = await pool.query(`SELECT role_name FROM user_roles WHERE user_id = $1`, [user.user_id]);
	const roles = roleRows.map((r) => r.role_name);

	logger.info({ userId: user.user_id }, "User logged in");

	const sid = issueSessionId();
	const tokens = buildTokenResponse(user.user_id, sid, user.email, roles, user.is_email_verified);
	await storeRefreshToken(user.user_id, sid, tokens.refreshToken);
	return tokens;
};

export const logoutCurrent = async (userId, incomingRefreshToken, authenticatedSid) => {
	const payload = verifyRefreshTokenPayload(incomingRefreshToken);
	if (payload.userId !== userId) {
		throw new AppError("Refresh token does not belong to current user", 403);
	}
	if (!authenticatedSid || payload.sid !== authenticatedSid) {
		throw new AppError("Refresh token session does not match the authenticated session", 403);
	}
	await deleteSessionToken(userId, authenticatedSid);
	logger.info({ userId: payload.userId, sid: authenticatedSid }, "User logged out from current session");
};

export const logoutAll = async (userId) => {
	const now = Math.floor(Date.now() / 1000);
	const sessionsKey = userSessionsKey(userId);
	await redis.zRemRangeByScore(sessionsKey, 0, now);
	const sids = await redis.zRange(sessionsKey, 0, -1);
	if (sids.length) {
		const keys = sids.map((sid) => refreshTokenKey(userId, sid));
		const multi = redis.multi();
		multi.del(...keys);
		multi.zRem(sessionsKey, ...sids);
		await multi.exec();
	}
	logger.info({ userId, revokedSessions: sids.length }, "User logged out from all sessions");
};

export const listSessions = async (userId, currentSid) => {
	const now = Math.floor(Date.now() / 1000);
	const sessionsKey = userSessionsKey(userId);
	await redis.zRemRangeByScore(sessionsKey, 0, now);
	const sids = await redis.zRange(sessionsKey, 0, -1);
	if (!sids.length) return [];

	const sessions = await Promise.all(
		sids.map(async (sid) => {
			const token = await redis.get(refreshTokenKey(userId, sid));
			if (!token) {
				await redis.zRem(sessionsKey, sid);
				return null;
			}
			const decoded = token ? jwt.decode(token) : null;

			return {
				sid,
				isCurrent: sid === currentSid,
				expiresAt: decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : null,
				issuedAt: decoded?.iat ? new Date(decoded.iat * 1000).toISOString() : null,
			};
		}),
	);

	return sessions.filter(Boolean).sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
};

export const revokeSession = async (userId, sid) => {
	const deleted = await redis.del(refreshTokenKey(userId, sid));
	await redis.zRem(userSessionsKey(userId), sid);
	if (!deleted) {
		throw new AppError("Session not found", 404);
	}
	logger.info({ userId, sid }, "Session revoked");
};

export const refresh = async (incomingRefreshToken) => {
	const payload = verifyRefreshTokenPayload(incomingRefreshToken);

	// Load fresh user state from DB — the refresh token payload may be up to
	// 7 days old, so roles and account status could have changed since it was
	// issued. Never trust stale payload data for authorization decisions.
	const { rows: userRows } = await pool.query(
		`SELECT email, is_email_verified, account_status FROM users WHERE user_id = $1 AND deleted_at IS NULL`,
		[payload.userId],
	);
	if (!userRows.length) {
		throw new AppError("User not found", 401);
	}

	if (INACTIVE_ACCOUNT_STATUSES.has(userRows[0].account_status)) {
		throw new AppError("Account inactive", 401);
	}

	const { rows: roleRows } = await pool.query(`SELECT role_name FROM user_roles WHERE user_id = $1`, [
		payload.userId,
	]);
	const roles = roleRows.map((r) => r.role_name);

	// Build a FULL token response — both access and refresh tokens — using the
	// same canonical path as login and register. This has two important effects:
	//
	// 1. REFRESH TOKEN ROTATION: CAS replaces the per-session token only when the
	//    caller presents the currently stored token for refreshToken:{userId}:{sid}.
	//    Replays of older tokens fail atomically and return 401.
	//
	// 2. CONSISTENT RESPONSE SHAPE: every auth endpoint now returns
	//    { accessToken, refreshToken, user: {...} }, so browser clients get
	//    fresh cookies set by the controller and Android clients get fresh
	//    tokens in the JSON body — both handled identically.
	const tokens = buildTokenResponse(
		payload.userId,
		payload.sid,
		userRows[0].email,
		roles,
		userRows[0].is_email_verified,
	);

	const expiryTimestamp = Math.floor(Date.now() / 1000) + REFRESH_TTL;

	const rotated = await casRefreshToken(
		payload.userId,
		payload.sid,
		incomingRefreshToken,
		tokens.refreshToken,
		REFRESH_TTL,
		expiryTimestamp,
	);
	if (!rotated) {
		throw new AppError("Refresh token is invalid or has been revoked", 401);
	}

	logger.info({ userId: payload.userId, sid: payload.sid }, "Tokens refreshed");

	return tokens;
};

export const sendOtp = async (userId, email) => {
	const { rows } = await pool.query(`SELECT is_email_verified FROM users WHERE user_id = $1`, [userId]);
	if (!rows.length) throw new AppError("User not found", 404);
	if (rows[0].is_email_verified) {
		throw new AppError("Email is already verified", 409);
	}

	const otp = generateOtp();
	const hash = await bcrypt.hash(otp, 10);

	await Promise.all([redis.setEx(`otp:${userId}`, OTP_TTL, hash), redis.del(`otpAttempts:${userId}`)]);

	await sendOtpEmail(email, otp);
	logger.info({ userId }, "OTP sent");
};

export const verifyOtp = async (userId, otp, ipAddress) => {
	const attemptsKey = `otpAttempts:${userId}`;
	const otpKey = `otp:${userId}`;

	// ── IP-level coarse rate limit ────────────────────────────────────────────
	//
	// Only applied when ipAddress is available. If the middleware layer could not
	// determine an IP (e.g. running behind an unconfigured proxy), we log a
	// warning and skip the IP check rather than locking everyone out or silently
	// grouping all requests under "ipAttempts:undefined".
	if (ipAddress) {
		const ipAttemptsKey = `ipAttempts:${ipAddress}`;
		let ipAttempts;
		try {
			ipAttempts = await redis.incr(ipAttemptsKey);

			const ttl = await redis.ttl(ipAttemptsKey);
			if (ttl < 0) {
				await redis.expire(ipAttemptsKey, OTP_IP_WINDOW_SECONDS);
			}
		} catch (err) {
			logger.error({ err: err.message, userId, ipAddress }, "OTP verify IP limiter failed closed");
			throw new AppError("OTP verification is temporarily unavailable", 429);
		}

		if (ipAttempts > OTP_IP_MAX_ATTEMPTS) {
			logger.warn({ userId, ipAddress, ipAttempts }, "OTP verify IP rate limit exceeded");
			throw new AppError("Too many OTP verification attempts from this IP — please wait 15 minutes", 429);
		}
	} else {
		// Trust proxy may not be configured or the request arrived without a
		// recognisable IP header. Per-user counter still applies.
		logger.warn({ userId }, "OTP verify: IP address unavailable — skipping IP-level rate limiting");
	}

	// ── Per-user attempt counter ──────────────────────────────────────────────
	const attempts = parseInt((await redis.get(attemptsKey)) ?? "0", 10);
	if (attempts >= OTP_MAX_ATTEMPTS) {
		throw new AppError("Too many incorrect attempts — request a new OTP", 429);
	}

	const storedHash = await redis.get(otpKey);
	if (!storedHash) {
		throw new AppError("OTP has expired or was never sent — request a new one", 400);
	}

	const match = await bcrypt.compare(otp, storedHash);
	if (!match) {
		await redis.setEx(attemptsKey, OTP_TTL, String(attempts + 1));
		const remaining = OTP_MAX_ATTEMPTS - (attempts + 1);
		throw new AppError(
			remaining > 0 ?
				`Incorrect OTP — ${remaining} attempt${remaining === 1 ? "" : "s"} remaining`
			:	"Too many incorrect attempts — request a new OTP",
			remaining > 0 ? 400 : 429,
		);
	}

	await Promise.all([redis.del(otpKey), redis.del(attemptsKey)]);

	await pool.query(`UPDATE users SET is_email_verified = TRUE WHERE user_id = $1`, [userId]);

	logger.info({ userId }, "Email verified via OTP");
};

// ─── Google OAuth ─────────────────────────────────────────────────────────────
export const googleOAuth = async ({ idToken, role, fullName, businessName }) => {
	if (!googleOAuthClient) {
		throw new AppError("Google OAuth is not configured on this server", 503);
	}

	let ticket;
	try {
		ticket = await googleOAuthClient.verifyIdToken({
			idToken,
			audience: config.GOOGLE_CLIENT_ID,
		});
	} catch (err) {
		logger.warn({ err: err.message }, "Google ID token verification failed");
		throw new AppError("Invalid or expired Google token", 401);
	}

	const payload = ticket.getPayload();
	if (!payload) {
		throw new AppError("Invalid Google token payload", 401);
	}

	const googleId = payload.sub;
	const email = payload.email;
	const emailVerifiedByGoogle = payload.email_verified;

	if (!email || !emailVerifiedByGoogle) {
		throw new AppError("Google account does not have a verified email address", 400);
	}

	// ── Path 1: Returning OAuth user ──────────────────────────────────────────
	const existingByGoogleId = await findUserByGoogleId(googleId);

	if (existingByGoogleId) {
		if (INACTIVE_ACCOUNT_STATUSES.has(existingByGoogleId.account_status)) {
			throw new AppError(`Account is ${existingByGoogleId.account_status}`, 401);
		}

		const { rows: roleRows } = await pool.query(`SELECT role_name FROM user_roles WHERE user_id = $1`, [
			existingByGoogleId.user_id,
		]);
		const roles = roleRows.map((r) => r.role_name);

		logger.info({ userId: existingByGoogleId.user_id }, "User signed in via Google OAuth");

		const sid = issueSessionId();
		const tokens = buildTokenResponse(
			existingByGoogleId.user_id,
			sid,
			existingByGoogleId.email,
			roles,
			existingByGoogleId.is_email_verified,
		);
		await storeRefreshToken(existingByGoogleId.user_id, sid, tokens.refreshToken);
		return tokens;
	}

	// ── Path 2: Account linking ───────────────────────────────────────────────
	const existingByEmail = await findUserByEmail(email);

	if (existingByEmail) {
		if (INACTIVE_ACCOUNT_STATUSES.has(existingByEmail.account_status)) {
			throw new AppError(`Account is ${existingByEmail.account_status}`, 401);
		}

		const { rowCount: linkRowCount } = await pool.query(
			`UPDATE users SET google_id = $1 WHERE user_id = $2 AND google_id IS NULL AND deleted_at IS NULL`,
			[googleId, existingByEmail.user_id],
		);

		if (linkRowCount === 0) {
			throw new AppError("This account is already linked to a different Google account", 409);
		}

		const { rows: roleRows } = await pool.query(`SELECT role_name FROM user_roles WHERE user_id = $1`, [
			existingByEmail.user_id,
		]);
		const roles = roleRows.map((r) => r.role_name);

		logger.info({ userId: existingByEmail.user_id }, "Google account linked to existing email/password account");

		const sid = issueSessionId();
		const tokens = buildTokenResponse(
			existingByEmail.user_id,
			sid,
			existingByEmail.email,
			roles,
			existingByEmail.is_email_verified,
		);
		await storeRefreshToken(existingByEmail.user_id, sid, tokens.refreshToken);
		return tokens;
	}

	// ── Path 3: New user registration ─────────────────────────────────────────
	if (!role) {
		throw new AppError("Role is required for new account registration via Google", 400);
	}
	if (!fullName?.trim()) {
		throw new AppError("Full name is required for new account registration", 400);
	}
	if (role === "pg_owner" && !businessName?.trim()) {
		throw new AppError("Business name is required for PG owner registration", 400);
	}

	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		let user;
		try {
			const { rows: userRows } = await client.query(
				`INSERT INTO users (email, google_id, is_email_verified)
         VALUES ($1, $2, TRUE)
         RETURNING user_id, email, is_email_verified`,
				[email, googleId],
			);
			user = userRows[0];
		} catch (err) {
			if (err.code === "23505") {
				throw new AppError("An account with this email already exists", 409);
			}
			throw err;
		}

		if (role === "student") {
			await client.query(`INSERT INTO student_profiles (user_id, full_name) VALUES ($1, $2)`, [
				user.user_id,
				fullName,
			]);

			const domain = email.split("@")[1];
			const institution = await findInstitutionByDomain(domain, client);

			if (institution) {
				await client.query(`UPDATE student_profiles SET institution_id = $1 WHERE user_id = $2`, [
					institution.institution_id,
					user.user_id,
				]);
				logger.info(
					{
						userId: user.user_id,
						institutionId: institution.institution_id,
						institutionName: institution.name,
					},
					"OAuth student auto-verified via institution domain",
				);
			}
		} else {
			await client.query(
				`INSERT INTO pg_owner_profiles (user_id, owner_full_name, business_name)
         VALUES ($1, $2, $3)`,
				[user.user_id, fullName, businessName],
			);
		}

		await client.query(`INSERT INTO user_roles (user_id, role_name) VALUES ($1, $2)`, [user.user_id, role]);

		await client.query("COMMIT");

		logger.info({ userId: user.user_id, role }, "New user registered via Google OAuth");

		const roles = [role];
		const sid = issueSessionId();
		const tokens = buildTokenResponse(user.user_id, sid, user.email, roles, true);
		await storeRefreshToken(user.user_id, sid, tokens.refreshToken);
		return tokens;
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
};
