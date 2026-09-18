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
import { enqueueEmail } from "../workers/emailQueue.js";

const googleOAuthClient = config.GOOGLE_CLIENT_ID ? new OAuth2Client(config.GOOGLE_CLIENT_ID) : null;

const INACTIVE_ACCOUNT_STATUSES = new Set(["suspended", "banned", "deactivated"]);

export const parseTtlSeconds = (expiresIn, fallbackSeconds = 7 * 24 * 60 * 60) => {
	if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
		return Math.floor(expiresIn);
	}

	const value = String(expiresIn ?? "").trim();
	if (!value) return fallbackSeconds;

	if (/^\d+$/.test(value)) {
		return Number.parseInt(value, 10);
	}

	const match = value.match(/^(\d+)([smhd])$/i);
	if (!match) return fallbackSeconds;
	const [, amount, unit] = match;
	const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
	return Number.parseInt(amount, 10) * multipliers[unit.toLowerCase()];
};

const ACCESS_TTL_SECONDS = parseTtlSeconds(config.JWT_EXPIRES_IN, 15 * 60);
const REFRESH_TTL_SECONDS = parseTtlSeconds(config.JWT_REFRESH_EXPIRES_IN, 7 * 24 * 60 * 60);
export const SESSION_TOKEN_PURPOSE = "session_access";

export const issueAccessToken = (userId, email, roles, sid) =>
	jwt.sign({ userId, email, roles, sid, purpose: SESSION_TOKEN_PURPOSE }, config.JWT_SECRET, {
		expiresIn: ACCESS_TTL_SECONDS,
	});

export const issueRefreshToken = (userId, sid) =>
	jwt.sign({ userId, sid, jti: crypto.randomUUID() }, config.JWT_REFRESH_SECRET, {
		expiresIn: REFRESH_TTL_SECONDS,
	});

const issueSessionId = () => crypto.randomUUID();

const refreshTokenKey = (userId, sid) => `refreshToken:${userId}:${sid}`;
const legacyRefreshKey = (userId) => `refreshToken:${userId}`;
const userSessionsKey = (userId) => `userSessions:${userId}`;

const buildTokenResponse = (userId, sid, email, roles, isEmailVerified) => {
	const accessToken = issueAccessToken(userId, email, roles, sid);
	const refreshToken = issueRefreshToken(userId, sid);
	return { accessToken, refreshToken, user: { userId, email, roles, isEmailVerified }, sid };
};

const storeRefreshToken = async (userId, sid, refreshToken) => {
	const expiryTimestamp = Math.floor(Date.now() / 1000) + REFRESH_TTL_SECONDS;
	const multi = redis.multi();
	multi.setEx(refreshTokenKey(userId, sid), REFRESH_TTL_SECONDS, refreshToken);
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
	ttl = REFRESH_TTL_SECONDS,
	expiryTimestamp = Math.floor(Date.now() / 1000) + ttl,
) => {
	const result = await redis.eval(casRefreshTokenScript, {
		keys: [refreshTokenKey(userId, sid), userSessionsKey(userId)],
		arguments: [expectedOldToken, newToken, String(ttl), sid, String(expiryTimestamp)],
	});
	return result === 1;
};

// Shared by authService.refresh() and authenticate.js's silent-refresh path so
// both issue tokens the same way (same claims, same jti) and both go through
// the same CAS rotation. Returns null when the CAS fails (old token was
// already rotated/replayed), so callers can treat that as "refresh failed"
// without needing to know CAS internals.
export const rotateSession = async (userId, sid, email, roles, isEmailVerified, oldRefreshToken) => {
	const accessToken = issueAccessToken(userId, email, roles, sid);
	const newRefreshToken = issueRefreshToken(userId, sid);
	const expiryTimestamp = Math.floor(Date.now() / 1000) + REFRESH_TTL_SECONDS;

	const rotated = await casRefreshToken(
		userId,
		sid,
		oldRefreshToken,
		newRefreshToken,
		REFRESH_TTL_SECONDS,
		expiryTimestamp,
	);
	if (!rotated) return null;

	return { accessToken, refreshToken: newRefreshToken, user: { userId, email, roles, isEmailVerified }, sid };
};

export const verifyRefreshTokenPayload = async (incomingRefreshToken) => {
	let payload;
	try {
		payload = jwt.verify(incomingRefreshToken, config.JWT_REFRESH_SECRET);
	} catch (err) {
		throw err;
	}

	if (!payload?.userId) {
		throw new AppError("Refresh token payload is invalid", 401);
	}

	if (payload.sid) {
		return { userId: payload.userId, sid: payload.sid };
	}

	logger.warn(
		{ userId: payload.userId },
		"verifyRefreshTokenPayload: legacy token without sid — attempting migration",
	);

	const legacyCandidates = [legacyRefreshKey(payload.userId), userSessionsKey(payload.userId)];
	let legacyKey;
	let legacyToken = null;

	for (const candidateKey of legacyCandidates) {
		const candidateType = await redis.type(candidateKey).catch(() => "none");

		if (candidateType === "string") {
			const token = await redis.get(candidateKey).catch(() => null);
			if (token) {
				legacyKey = candidateKey;
				legacyToken = token;
				break;
			}
			continue;
		}

		if (candidateType === "zset") {
			const members = await redis.zRange(candidateKey, 0, -1).catch(() => []);
			if (members.length === 1) {
				legacyKey = candidateKey;
				legacyToken = members[0];
				break;
			}
		}
	}

	if (!legacyToken || legacyToken !== incomingRefreshToken) {
		throw new AppError("Refresh token is invalid or has been revoked", 401);
	}

	const newSid = issueSessionId();
	const expiryTimestamp = Math.floor(Date.now() / 1000) + REFRESH_TTL_SECONDS;

	const multi = redis.multi();
	multi.setEx(refreshTokenKey(payload.userId, newSid), REFRESH_TTL_SECONDS, incomingRefreshToken);
	multi.zAdd(userSessionsKey(payload.userId), { score: expiryTimestamp, value: newSid });
	if (legacyKey) {
		multi.del(legacyKey);
	}
	await multi.exec();

	logger.info(
		{ userId: payload.userId, newSid },
		"verifyRefreshTokenPayload: legacy token migrated to per-session key",
	);

	return { userId: payload.userId, sid: newSid };
};

const _verifyRefreshTokenPayloadSync = (incomingRefreshToken) => {
	let payload;
	try {
		payload = jwt.verify(incomingRefreshToken, config.JWT_REFRESH_SECRET);
	} catch (err) {
		throw err;
	}

	if (!payload?.userId) {
		throw new AppError("Refresh token payload is invalid", 401);
	}

	if (!payload.sid) {
		throw new AppError("Refresh token payload is invalid (missing sid)", 401);
	}

	return payload;
};

const OTP_TTL = 600;
const OTP_MAX_ATTEMPTS = 5;
const OTP_IP_WINDOW_SECONDS = 15 * 60;
const OTP_IP_MAX_ATTEMPTS = 50;

const generateOtp = () => String(crypto.randomInt(100000, 1000000));

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
	const payload = _verifyRefreshTokenPayloadSync(incomingRefreshToken);
	if (payload.userId !== userId) {
		throw new AppError("Refresh token does not belong to current user", 403);
	}
	if (!authenticatedSid || payload.sid !== authenticatedSid) {
		throw new AppError("Refresh token session does not match the authenticated session", 403);
	}

	const storedToken = await redis.get(refreshTokenKey(userId, authenticatedSid));
	if (!storedToken) {
		throw new AppError("Session not found or already revoked", 401);
	}
	if (storedToken !== incomingRefreshToken) {
		throw new AppError("Refresh token is invalid or has been superseded", 401);
	}

	await deleteSessionToken(userId, authenticatedSid);
	logger.info({ userId, sid: authenticatedSid }, "User logged out from current session");
};

export const logoutByRefreshToken = async (incomingRefreshToken) => {
	const payload = _verifyRefreshTokenPayloadSync(incomingRefreshToken);
	const { userId, sid } = payload;

	const storedToken = await redis.get(refreshTokenKey(userId, sid));
	if (!storedToken) {
		throw new AppError("Session not found or already revoked", 401);
	}
	if (storedToken !== incomingRefreshToken) {
		throw new AppError("Refresh token is invalid or has been superseded", 401);
	}

	await deleteSessionToken(userId, sid);
	logger.info({ userId, sid }, "User logged out by refresh token");
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

	const tokenKeys = sids.map((sid) => refreshTokenKey(userId, sid));
	const tokens = await redis.mGet(tokenKeys);

	const staleSids = [];
	const sessions = [];

	for (let i = 0; i < sids.length; i++) {
		const sid = sids[i];
		const token = tokens[i];

		if (!token) {
			staleSids.push(sid);
			continue;
		}

		const decoded = jwt.decode(token);

		sessions.push({
			sid,
			isCurrent: sid === currentSid,
			expiresAt: decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : null,
			issuedAt: decoded?.iat ? new Date(decoded.iat * 1000).toISOString() : null,
		});
	}

	if (staleSids.length > 0) {
		await redis.zRem(sessionsKey, ...staleSids);
	}

	return sessions.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
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
	const { userId, sid } = await verifyRefreshTokenPayload(incomingRefreshToken);

	const { rows: userRows } = await pool.query(
		`SELECT email, is_email_verified, account_status FROM users WHERE user_id = $1 AND deleted_at IS NULL`,
		[userId],
	);
	if (!userRows.length) {
		throw new AppError("User not found", 401);
	}

	if (INACTIVE_ACCOUNT_STATUSES.has(userRows[0].account_status)) {
		throw new AppError("Account inactive", 401);
	}

	const { rows: roleRows } = await pool.query(`SELECT role_name FROM user_roles WHERE user_id = $1`, [userId]);
	const roles = roleRows.map((r) => r.role_name);

	const tokens = await rotateSession(
		userId,
		sid,
		userRows[0].email,
		roles,
		userRows[0].is_email_verified,
		incomingRefreshToken,
	);
	if (!tokens) {
		throw new AppError("Refresh token is invalid or has been revoked", 401);
	}

	logger.info({ userId, sid }, "Tokens refreshed");

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

	enqueueEmail({ type: "otp", to: email, data: { otp } });

	logger.info({ userId }, "OTP enqueued for delivery");
};

export const verifyOtp = async (userId, otp, ipAddress) => {
	const attemptsKey = `otpAttempts:${userId}`;
	const otpKey = `otp:${userId}`;

	if (ipAddress) {
		const ipAttemptsKey = `ipAttempts:${ipAddress}`;
		let ipAttempts;
		try {
			const multi = redis.multi();
			multi.incr(ipAttemptsKey);
			multi.expire(ipAttemptsKey, OTP_IP_WINDOW_SECONDS, "NX");
			const results = await multi.exec();
			ipAttempts = results[0];
		} catch (err) {
			logger.error({ err: err.message, userId, ipAddress }, "OTP verify IP limiter failed closed");
			throw new AppError("OTP verification is temporarily unavailable", 429);
		}

		if (ipAttempts > OTP_IP_MAX_ATTEMPTS) {
			logger.warn({ userId, ipAddress, ipAttempts }, "OTP verify IP rate limit exceeded");
			throw new AppError("Too many OTP verification attempts from this IP — please wait 15 minutes", 429);
		}
	} else {
		logger.warn({ userId }, "OTP verify: IP address unavailable — skipping IP-level rate limiting");
	}

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

	const existingByEmail = await findUserByEmail(email);

	if (existingByEmail) {
		if (INACTIVE_ACCOUNT_STATUSES.has(existingByEmail.account_status)) {
			throw new AppError(`Account is ${existingByEmail.account_status}`, 401);
		}

		let linkRowCount;
		try {
			const { rowCount } = await pool.query(
				`UPDATE users SET google_id = $1 WHERE user_id = $2 AND google_id IS NULL AND deleted_at IS NULL`,
				[googleId, existingByEmail.user_id],
			);
			linkRowCount = rowCount;
		} catch (err) {
			if (err.code === "23505") {
				logger.warn(
					{ googleId, userId: existingByEmail.user_id, err: err.detail },
					"googleOAuth account-link: concurrent unique violation — googleId already linked to another account",
				);
				throw new AppError("This Google account is already linked to another user", 409);
			}
			throw err;
		}

		if (linkRowCount === 0) {
			logger.warn(
				{ userId: existingByEmail.user_id },
				"googleOAuth account-link: account already linked to a different Google account",
			);
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

// ─── ADR-016: Admin Login (Password + OTP 2FA) ─────────────────────────────
//
// Two-step flow producing the SAME accessToken/refreshToken cookies the
// existing `authenticate` middleware expects, so requireAdmin and every
// downstream admin route need zero changes.
//
// Step 1 (adminLogin): password check -> short-lived pending-2FA JWT +
//   OTP emailed. No session issued yet.
// Step 2 (verifyAdminLoginOtp): pending token + OTP -> real session via the
//   EXISTING buildTokenResponse/storeRefreshToken machinery (no new session
//   logic, per the ADR).
//
// Redis key namespace is deliberately separate from the profile-verification
// OTP (`otp:{userId}`) so the two can never collide or be confused:
//   adminLoginOtp:{userId}          — hashed OTP, 10 min TTL
//   adminLoginOtpAttempts:{userId}  — incorrect-attempt counter, 10 min TTL
//
// The pending token is a signed JWT carrying { userId, purpose: "admin_login_2fa" }.
// It is returned in the response BODY, never as a cookie, and is only ever
// accepted by verifyAdminLoginOtp — nothing else in the codebase should ever
// treat a token with this purpose claim as a usable session token.

const ADMIN_LOGIN_OTP_TTL = 600; // 10 minutes — matches the existing profile-verification OTP TTL
const ADMIN_LOGIN_OTP_MAX_ATTEMPTS = 5; // matches OTP_MAX_ATTEMPTS
const PENDING_TOKEN_TTL_SECONDS = 5 * 60; // 5 minutes
const PENDING_TOKEN_PURPOSE = "admin_login_2fa";

const adminLoginOtpKey = (userId) => `adminLoginOtp:${userId}`;
const adminLoginOtpAttemptsKey = (userId) => `adminLoginOtpAttempts:${userId}`;

const transitionAdminLoginOtpScript = `
local storedHash = redis.call("GET", KEYS[1])
if not storedHash or storedHash ~= ARGV[1] then
  return 0
end

local attempts = tonumber(redis.call("GET", KEYS[2]) or "0")
if attempts >= tonumber(ARGV[3]) then
  return -1
end

if ARGV[2] == "valid" then
  redis.call("DEL", KEYS[1])
  redis.call("DEL", KEYS[2])
  return 1
end

attempts = attempts + 1
redis.call("SETEX", KEYS[2], tonumber(ARGV[4]), attempts)
return attempts
`;

const transitionAdminLoginOtp = async (otpKey, attemptsKey, storedHash, outcome) =>
	redis.eval(transitionAdminLoginOtpScript, {
		keys: [otpKey, attemptsKey],
		arguments: [storedHash, outcome, String(ADMIN_LOGIN_OTP_MAX_ATTEMPTS), String(ADMIN_LOGIN_OTP_TTL)],
	});

const issuePendingAdminToken = (userId) =>
	jwt.sign({ userId, purpose: PENDING_TOKEN_PURPOSE }, config.JWT_SECRET, {
		expiresIn: PENDING_TOKEN_TTL_SECONDS,
	});

const verifyPendingAdminToken = (pendingToken) => {
	let payload;
	try {
		payload = jwt.verify(pendingToken, config.JWT_SECRET);
	} catch (err) {
		if (err.name === "TokenExpiredError") {
			throw new AppError("Login session expired — please start over", 401);
		}
		throw new AppError("Invalid or malformed pending token", 401);
	}

	if (payload?.purpose !== PENDING_TOKEN_PURPOSE || !payload?.userId) {
		throw new AppError("Invalid pending token", 401);
	}

	return payload;
};

/**
 * Step 1 — POST /auth/admin/login
 *
 * Password-only. Never reveals whether an email belongs to an admin, or
 * whether it exists at all — same dummy-hash timing-safe pattern as login().
 * On success, does NOT issue any session token. It issues a pending-2FA
 * token and enqueues an OTP email; the caller must complete step 2 to
 * actually get a session.
 */
export const adminLogin = async ({ email, password }) => {
	const user = await findUserByEmail(email);

	const hashToCompare = user ? user.password_hash : DUMMY_HASH;
	const effectiveHash = hashToCompare ?? DUMMY_HASH;
	const passwordMatch = await bcrypt.compare(password, effectiveHash);

	// Generic 401 for: wrong password, unknown email, OR a real user who
	// simply isn't an admin. Never let the response shape leak which case it was.
	if (!passwordMatch || !user) {
		throw new AppError("Invalid credentials", 401);
	}

	if (INACTIVE_ACCOUNT_STATUSES.has(user.account_status)) {
		throw new AppError(`Account is ${user.account_status}`, 401);
	}

	const { rows: roleRows } = await pool.query(`SELECT role_name FROM user_roles WHERE user_id = $1`, [user.user_id]);
	const roles = roleRows.map((r) => r.role_name);

	if (!roles.includes("admin")) {
		// Deliberately identical error to "wrong password" above — do not
		// disclose that this account exists but lacks the admin role.
		throw new AppError("Invalid credentials", 401);
	}

	const otp = generateOtp();
	const hash = await bcrypt.hash(otp, 10);

	await Promise.all([
		redis.setEx(adminLoginOtpKey(user.user_id), ADMIN_LOGIN_OTP_TTL, hash),
		redis.del(adminLoginOtpAttemptsKey(user.user_id)),
	]);

	enqueueEmail({ type: "admin_login_otp", to: user.email, data: { otp } });

	const pendingToken = issuePendingAdminToken(user.user_id);

	logger.info({ userId: user.user_id }, "Admin login step 1 passed — OTP enqueued, session not yet issued");

	return { pendingToken, message: "OTP sent" };
};

/**
 * Step 2 — POST /auth/admin/login/verify
 *
 * Verifies the pending token's signature/expiry/purpose, then the OTP
 * itself (same bcrypt-compare + attempt-counter pattern as verifyOtp).
 * On success, deletes the OTP/attempts keys and issues a REAL session via
 * the existing buildTokenResponse/storeRefreshToken — identical shape to
 * login()'s output, so authController.js's existing cookie-setting logic
 * works unmodified.
 */
export const verifyAdminLoginOtp = async (pendingToken, otp) => {
	const { userId } = verifyPendingAdminToken(pendingToken);

	// Re-verify the account is still a live admin at the moment of step 2 —
	// role or status could have changed in the (short) window between steps.
	const { rows: userRows } = await pool.query(
		`SELECT email, is_email_verified, account_status FROM users WHERE user_id = $1 AND deleted_at IS NULL`,
		[userId],
	);
	if (!userRows.length) {
		throw new AppError("User not found", 401);
	}
	if (INACTIVE_ACCOUNT_STATUSES.has(userRows[0].account_status)) {
		throw new AppError("Account inactive", 401);
	}

	const { rows: roleRows } = await pool.query(`SELECT role_name FROM user_roles WHERE user_id = $1`, [userId]);
	const roles = roleRows.map((r) => r.role_name);
	if (!roles.includes("admin")) {
		throw new AppError("Invalid credentials", 401);
	}

	const attemptsKey = adminLoginOtpAttemptsKey(userId);
	const otpKey = adminLoginOtpKey(userId);

	const attempts = parseInt((await redis.get(attemptsKey)) ?? "0", 10);
	if (attempts >= ADMIN_LOGIN_OTP_MAX_ATTEMPTS) {
		throw new AppError("Too many incorrect attempts — please log in again", 429);
	}

	const storedHash = await redis.get(otpKey);
	if (!storedHash) {
		throw new AppError("OTP has expired or was never sent — please log in again", 400);
	}

	const match = await bcrypt.compare(otp, storedHash);
	if (!match) {
		const transition = await transitionAdminLoginOtp(otpKey, attemptsKey, storedHash, "invalid");
		if (transition === 0) {
			throw new AppError("OTP has expired or was never sent — please log in again", 400);
		}
		if (transition === -1) {
			throw new AppError("Too many incorrect attempts — please log in again", 429);
		}

		const remaining = ADMIN_LOGIN_OTP_MAX_ATTEMPTS - transition;
		throw new AppError(
			remaining > 0 ?
				`Incorrect OTP — ${remaining} attempt${remaining === 1 ? "" : "s"} remaining`
			:	"Too many incorrect attempts — please log in again",
			remaining > 0 ? 400 : 429,
		);
	}

	const transition = await transitionAdminLoginOtp(otpKey, attemptsKey, storedHash, "valid");
	if (transition === 0) {
		throw new AppError("OTP has expired or was never sent — please log in again", 400);
	}
	if (transition === -1) {
		throw new AppError("Too many incorrect attempts — please log in again", 429);
	}

	logger.info({ userId }, "Admin login step 2 passed — session issued");

	const sid = issueSessionId();
	const tokens = buildTokenResponse(userId, sid, userRows[0].email, roles, userRows[0].is_email_verified);
	await storeRefreshToken(userId, sid, tokens.refreshToken);
	return tokens;
};
