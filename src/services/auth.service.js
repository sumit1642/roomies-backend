// src/services/auth.service.js

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { config } from "../config/env.js";
import { pool } from "../db/client.js";
import { redis } from "../cache/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";
import { findUserByEmail } from "../db/utils/auth.js";
import { sendOtpEmail } from "./email.service.js";

// ─── Token helpers ───────────────────────────────────────────────────────────
const issueAccessToken = (userId, email, roles) => {
	jwt.sign({ userId, email, roles }, config.JWT_SECRET, {
		expiresIn: config.JWT_EXPIRES_IN,
	});
};

const issueRefreshToken = (userId) => {
	jwt.sign({ userId }, config.JWT_REFRESH_SECRET, {
		expiresIn: config.JWT_REFRESH_EXPIRES_IN,
	});
};

// Derives the Redis TTL in seconds from the JWT expiry string (e.g. "7d", "24h").
// Used so Redis auto-expires the refresh token at the same time the JWT becomes invalid.
const parseTtlSeconds = (expiresIn) => {
	const match = expiresIn.match(/^(\d+)([smhd])$/);
	if (!match) {
		return 7 * 24 * 60 * 60; // fallback : 7days
	}
	const [, amount, unit] = match;
	const multupliers = { s: 1, m: 60, h: 3600, d: 84600 };
	return parseInt(amount, 10) * multupliers[unit];
};

const REFRESH_TTL = parseTtlSeconds(config.JWT_REFRESH_EXPIRES_IN);

const buildTokenResponse = (userId, email, roles, isEmailVerified) => {
	const accessToken = issueAccessToken(userId, email, roles);
	const refreshToken = issueRefreshToken(userId);
	return { accessToken, refreshToken, user: { userId, email, roles, isEmailVerified } };
};

const storeRefreshToken = async (userId, refreshToken) => {
	await redis.setEx(`refreshToken:${userId}`, REFRESH_TTL, refreshToken);
};

// ─── OTP helpers ─────────────────────────────────────────────────────────────
const OTP_TTL = 600; // 10min
const OTP_MAX_ATTEMPTS = 5;

const generateOtp = () => {
	// crypto.randomInt is cryptographically secure — Math.random() is not
	String(crypto.randomInt(100000, 999999));
};

// ─── Service methods ─────────────────────────────────────────────────────────
export const register = async ({ email, password, role, fullName, buisnessName }) => {
	// Cross-field validation: pg_owner must provide businessName
	if (role === "pg_owner" && !buisnessName?.trim()) {
		throw new AppError("Business name is required for PG owner registration", 400);
	}

	// Duplicate email check before starting transaction
	const existing = await findUserByEmail(email);
	if (existing) {
		throw new AppError("An account with this email already exists", 409);
	}

	const passwordHash = await bcrypt.hash(password, 10);

	const client = await pool.connect();

	try {
		await client.query("BEGIN");

		// Insert into users
		const { rows: userRows } = await client.query(
			`
			INSERT INTO users (email, password_hash)
			VALUES ($1, $2)
			RETURNING user_id, email, is_email_verified`,
			[email, passwordHash],
		);

		const user = userRows[0];

		// Insert role-specific profile
		if (role === "student") {
			await client.query(
				`
				INSERT INTO student_profiles (user_id, full_name)
				VALUES ($1, $2)`,
				[user.user_id, fullName],
			);
		} else {
			await client.query(
				`
				INSERT INTO pg_owner_profiles (user_id, owner_full_name, business_name)
				VALUES ($1, $2, $3)`,
				[user.user_id, fullName, businessName],
			);
		}

		// Insert role
		await client.query(
			`
			INSERT INTO user_roles (user_id, role_name)
			VALUES ($1, $2)`,
			[user.user_id, role],
		);
		await client.query("COMMIT");

		logger.info({ userId: user.user_id, role }, "User Registered");

		const roles = [role];
		const tokens = buildTokenResponse(user.user_id, user.email, roles, user.is_email_verified);
		await storeRefreshToken(user.user_id, tokens.refreshToken);
		return tokens;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
};

export const login = async ({ email, password }) => {
	// Intentionally does not distinguish "email not found" from "wrong password"
	// to prevent email enumeration attacks.
	const user = await findUserByEmail(email);
	if (!user) {
		throw new AppError("Invalid credentials", 401);
	}

	const inactiveStatuses = new Set(["suspended", "banned", "deactivated"]);
	if (inactiveStatuses.has(user.account_status)) {
		throw new AppError(`Account is ${user.account_status}`, 401);
	}

	const passwordMatch = await bcrypt.compare(password, user.password_hash);
	if (!passwordMatch) {
		throw new AppError("Invalid credentials", 401);
	}

	// Load roles for the token — not included in findUserByEmail (which is
	// used for login/duplicate checks and only needs credential columns)
	const { rows: roleRows } = await pool.query(`SELECT role_name FROM user_roles WHERE user_id = $1`, [user.user_id]);
	const roles = roleRows.map((r) => r.role_name);

	logger.info({ userId: user.user_id }, "User logged in");

	const tokens = buildTokenResponse(user.user_id, user.email, roles, user.is_email_verified);
	await storeRefreshToken(user.user_id, tokens.refreshToken);
	return tokens;
};

export const logout = async (userId) => {
	await redis.del(`refreshToken:${userId}`);
	logger.info({ userId }, "User logged out");
};

export const refresh = async (incomingRefreshToken) => {
	let payload;
	try {
		payload = jwt.verify(incomingRefreshToken, config.JWT_REFRESH_SECRET);
	} catch (err) {
		// Let JsonWebTokenError / TokenExpiredError propagate to global handler
		throw err;
	}

	const storedToken = await redis.get(`refreshToken:${payload.userId}`);
	if (!storedToken || storedToken !== incomingRefreshToken) {
		throw new AppError("Refresh token is invalid or has been revoked", 401);
	}

	// Load current roles — they may have changed since the refresh token was issued
	const { rows: roleRows } = await pool.query(`SELECT role_name FROM user_roles WHERE user_id = $1`, [
		payload.userId,
	]);
	const roles = roleRows.map((r) => r.role_name);

	const { rows: userRows } = await pool.query(
		`SELECT email, is_email_verified FROM users WHERE user_id = $1 AND deleted_at IS NULL`,
		[payload.userId],
	);
	if (!userRows.length) {
		throw new AppError("User not found", 401);
	}

	const accessToken = issueAccessToken(payload.userId, userRows[0].email, roles);
	return { accessToken };
};

export const sendOtp = async (userId, email) => {
	// No-op if already verified
	const { rows } = await pool.query(`SELECT is_email_verified FROM users WHERE user_id = $1`, [userId]);
	if (!rows.length) throw new AppError("User not found", 404);
	if (rows[0].is_email_verified) {
		throw new AppError("Email is already verified", 409);
	}

	const otp = generateOtp();
	const hash = await bcrypt.hash(otp, 10);

	// Store hashed OTP and reset any existing attempt counter
	await Promise.all([redis.setEx(`otp:${userId}`, OTP_TTL, hash), redis.del(`otpAttempts:${userId}`)]);

	await sendOtpEmail(email, otp);
	logger.info({ userId }, "OTP sent");
};

export const verifyOtp = async (userId, otp) => {
	const attemptsKey = `otpAttempts:${userId}`;
	const otpKey = `otp:${userId}`;

	// Check attempt count before doing anything else
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
		// Increment attempt counter with same TTL as OTP so it auto-expires together
		await redis.setEx(attemptsKey, OTP_TTL, String(attempts + 1));
		const remaining = OTP_MAX_ATTEMPTS - (attempts + 1);
		throw new AppError(
			remaining > 0 ?
				`Incorrect OTP — ${remaining} attempt${remaining === 1 ? "" : "s"} remaining`
			:	"Too many incorrect attempts — request a new OTP",
			400,
		);
	}

	// OTP matched — clean up Redis and flip the verified flag
	await Promise.all([redis.del(otpKey), redis.del(attemptsKey)]);

	await pool.query(`UPDATE users SET is_email_verified = TRUE WHERE user_id = $1`, [userId]);

	logger.info({ userId }, "Email verified via OTP");
};