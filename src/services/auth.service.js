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
//
// Initialised once at module scope — not per-request. OAuth2Client is stateless
// after construction; creating it per-request would allocate a new object on
// every OAuth call with no benefit.
//
// Only GOOGLE_CLIENT_ID is needed. The client_secret is used in the Authorization
// Code flow where the server exchanges a code for tokens. In our flow the client
// obtains the ID token itself and sends it here — we only verify its audience
// claim (ensuring the token was issued for our app, not another Google project).
//
// Null-safe: if GOOGLE_CLIENT_ID is not configured, googleOAuthClient is null and
// googleOAuth() throws a clear AppError on invocation rather than crashing at
// module load. This keeps the server bootable when OAuth is not yet configured.
const googleOAuthClient = config.GOOGLE_CLIENT_ID ? new OAuth2Client(config.GOOGLE_CLIENT_ID) : null;

// ─── Account status guard ─────────────────────────────────────────────────────
//
// The three statuses that render an account non-functional. Defined once at
// module scope — not inline per-call — so the set is allocated once for the
// lifetime of the process and all checks in this file reference the same object.
// authenticate.js uses the same pattern with its own module-scope INACTIVE_STATUSES.
// This constant is intentionally not exported: callers outside this module should
// not be making account-status decisions — that is the service layer's responsibility.
const INACTIVE_ACCOUNT_STATUSES = new Set(["suspended", "banned", "deactivated"]);

// ─── Token helpers ───────────────────────────────────────────────────────────

const issueAccessToken = (userId, email, roles) =>
	jwt.sign({ userId, email, roles }, config.JWT_SECRET, {
		expiresIn: config.JWT_EXPIRES_IN,
	});

const issueRefreshToken = (userId) =>
	jwt.sign({ userId }, config.JWT_REFRESH_SECRET, {
		expiresIn: config.JWT_REFRESH_EXPIRES_IN,
	});

// Derives the Redis TTL in seconds from the JWT expiry string (e.g. "7d", "24h").
// Used so Redis auto-expires the refresh token at the same time the JWT becomes invalid.
//
// Exported as a named export so auth.controller.js can calculate cookie maxAge
// from the same source of truth. The alternative — duplicating the arithmetic in
// the controller — would mean a TTL change in env vars silently desynchronises
// the cookie lifetime from the token lifetime.
export const parseTtlSeconds = (expiresIn) => {
	const match = expiresIn.match(/^(\d+)([smhd])$/);
	if (!match) return 7 * 24 * 60 * 60; // fallback: 7 days
	const [, amount, unit] = match;
	const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
	return parseInt(amount, 10) * multipliers[unit];
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

const OTP_TTL = 600; // 10 minutes in seconds
const OTP_MAX_ATTEMPTS = 5;
const OTP_IP_WINDOW_SECONDS = 15 * 60;
const OTP_IP_MAX_ATTEMPTS = 50;

const generateOtp = () =>
	// crypto.randomInt is cryptographically secure — Math.random() is not.
	// Upper bound is exclusive, so 1000000 gives the full 100000–999999 range.
	String(crypto.randomInt(100000, 1000000));

// ─── Service methods ─────────────────────────────────────────────────────────

export const register = async ({ email, password, role, fullName, businessName }) => {
	// Cross-field validation: pg_owner must provide businessName
	if (role === "pg_owner" && !businessName?.trim()) {
		throw new AppError("Business name is required for PG owner registration", 400);
	}

	// Duplicate email check before starting transaction
	const existing = await findUserByEmail(email);
	if (existing) {
		throw new AppError("An account with this email already exists", 409);
	}

	const passwordHash = await bcrypt.hash(password, 10);

	const client = await pool.connect();
	// Tracks the effective email verification state for the token response.
	// Initialized from the users INSERT RETURNING value (always FALSE at insert time).
	// May be set to true inside the transaction if institution auto-verification fires.
	// Must be declared outside the try block so it is in scope at buildTokenResponse.
	let effectivelyVerified = false;
	try {
		await client.query("BEGIN");

		// Insert into users
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
			// Two concurrent registrations with the same email can both pass the
			// pre-check above and then race to this INSERT. The pre-check is still
			// valuable as a fast, cheap early exit for the common case; this catch
			// is the second line of defence that handles the narrow concurrent window.
			if (err.code === "23505") {
				throw new AppError("An account with this email already exists", 409);
			}
			throw err;
		}

		// Initialise from the RETURNING value. At INSERT time the DB default is
		// FALSE, so this will always be false here. It may be updated to true below
		// if institution auto-verification fires for a student registration.
		effectivelyVerified = user.is_email_verified;
		if (role === "student") {
			await client.query(
				`INSERT INTO student_profiles (user_id, full_name)
         VALUES ($1, $2)`,
				[user.user_id, fullName],
			);

			// Institution auto-verification — must run inside this transaction.
			// All three writes (student_profiles INSERT above, institution_id UPDATE,
			// is_email_verified UPDATE) describe a single atomic fact: "this email
			// proves enrollment at this institution." Splitting them across transaction
			// boundaries would allow partial state to persist on connection failure.
			//
			// Domain extraction happens here, not inside the utility, so the utility
			// stays pure and independently testable with a plain domain string.
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
				// Track effective verification state separately from the RETURNING value.
				// The users INSERT returned is_email_verified = FALSE (the DB default at
				// insert time). The UPDATE above has now flipped it to TRUE in the DB, but
				// user.is_email_verified still holds the stale RETURNING value.
				// Passing user.is_email_verified directly to buildTokenResponse would give
				// the first token isEmailVerified: false even though the DB says TRUE.
				// effectivelyVerified is the source of truth for the token response.
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

		// Insert role
		await client.query(
			`INSERT INTO user_roles (user_id, role_name)
       VALUES ($1, $2)`,
			[user.user_id, role],
		);

		await client.query("COMMIT");

		logger.info({ userId: user.user_id, role }, "User registered");

		const roles = [role];
		const tokens = buildTokenResponse(user.user_id, user.email, roles, effectivelyVerified);
		await storeRefreshToken(user.user_id, tokens.refreshToken);
		return tokens;
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
};

// A pre-computed bcrypt hash of the string "dummy" — used when the email is not
// found so we always run bcrypt.compare() regardless of whether the user exists.
// Without this, an attacker can distinguish "email not found" from "wrong password"
// by measuring response time: a missing user returns in microseconds while a wrong
// password takes ~100ms for bcrypt to complete. Running bcrypt on a dummy hash
// closes that timing gap. The compare will always fail (the dummy hash does not
// match any real password), so security is preserved.
const DUMMY_HASH = "$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi";

export const login = async ({ email, password }) => {
	const user = await findUserByEmail(email);

	// Always run bcrypt — even when the user does not exist — to prevent timing
	// attacks that distinguish "no such email" from "wrong password".
	const hashToCompare = user ? user.password_hash : DUMMY_HASH;

	// Guard: an OAuth-only user has password_hash = NULL in the DB. bcrypt.compare
	// against null would throw a TypeError rather than returning false. Use
	// DUMMY_HASH so timing stays constant and the compare cleanly returns false.
	const effectiveHash = hashToCompare ?? DUMMY_HASH;
	const passwordMatch = await bcrypt.compare(password, effectiveHash);

	if (!passwordMatch || !user) {
		// Intentionally identical message for both cases to prevent email enumeration.
		throw new AppError("Invalid credentials", 401);
	}

	// Password is correct — now check whether the account is usable.
	// This check comes AFTER bcrypt so the response time is the same whether
	// the account is inactive or the password was wrong.
	if (INACTIVE_ACCOUNT_STATUSES.has(user.account_status)) {
		throw new AppError(`Account is ${user.account_status}`, 401);
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
		`SELECT email, is_email_verified, account_status FROM users WHERE user_id = $1 AND deleted_at IS NULL`,
		[payload.userId],
	);
	if (!userRows.length) {
		throw new AppError("User not found", 401);
	}

	// An account that was suspended or banned after the refresh token was issued
	// must not be able to obtain new access tokens — even with a cryptographically
	// valid refresh token. The revocation only removes the Redis entry on explicit
	// logout; status changes don't clear Redis, so we must check here.
	if (INACTIVE_ACCOUNT_STATUSES.has(userRows[0].account_status)) {
		throw new AppError("Account inactive", 401);
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

export const verifyOtp = async (userId, otp, ipAddress) => {
	const attemptsKey = `otpAttempts:${userId}`;
	const otpKey = `otp:${userId}`;
	const ipAttemptsKey = `ipAttempts:${ipAddress}`;

	// Coarse IP limiter runs first to stop distributed parallel attempts before
	// the per-user OTP counter is checked.
	let ipAttempts;
	try {
		ipAttempts = await redis.incr(ipAttemptsKey);
		if (ipAttempts === 1) {
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
			remaining > 0 ? 400 : 429,
		);
	}

	// OTP matched — clean up Redis and flip the verified flag
	await Promise.all([redis.del(otpKey), redis.del(attemptsKey)]);

	await pool.query(`UPDATE users SET is_email_verified = TRUE WHERE user_id = $1`, [userId]);

	logger.info({ userId }, "Email verified via OTP");
};

// ─── Google OAuth ─────────────────────────────────────────────────────────────
//
// Accepts a Google ID token sent by the client after they completed Google
// sign-in on their side. Verifies it with google-auth-library, then branches:
//
//   Path 1 — Returning OAuth user: google_id already exists in users → login.
//
//   Path 2 — Account linking: no google_id match, but the email already exists
//   with google_id = NULL → write the google_id onto the existing row and treat
//   as login. This handles "registered with password, now signing in with Google
//   using the same email." Google has verified that email, so this link is as
//   trustworthy as the OTP flow.
//
//   Path 3 — New user: no google_id match, no email match → registration. Mirrors
//   the email/password register transaction exactly with two differences:
//   password_hash is NULL and is_email_verified starts TRUE (Google already
//   verified the email, so no OTP is needed).
//
// All three paths converge at buildTokenResponse + setAuthCookies in the
// controller — dual delivery (cookies + JSON body) is identical to login/register.
//
// role, fullName, and businessName are only required for Path 3. Paths 1 and 2
// ignore them — you cannot change your role by signing in with Google.
export const googleOAuth = async ({ idToken, role, fullName, businessName }) => {
	if (!googleOAuthClient) {
		throw new AppError("Google OAuth is not configured on this server", 503);
	}

	// ── Step 1: Verify the ID token ───────────────────────────────────────────
	//
	// verifyIdToken checks all of:
	//   - Signature: signed by Google's private key (fetched from Google's JWKS endpoint)
	//   - Audience:  token was issued for OUR client_id, not another app
	//   - Expiry:    token has not expired (Google ID tokens last 1 hour)
	//   - Issuer:    must be accounts.google.com or https://accounts.google.com
	//
	// If any check fails, verifyIdToken throws. We catch and re-throw as a user-facing
	// 401 — the raw error is never exposed to the client as it may contain token details.
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

	const googleId = payload.sub; // Google's stable, unique user identifier
	const email = payload.email;
	const emailVerifiedByGoogle = payload.email_verified;

	// Google only issues ID tokens for verified emails. The field exists in the
	// spec so we check it explicitly — accepting an unverified email would
	// undermine the trust model that the whole platform is built on.
	if (!email || !emailVerifiedByGoogle) {
		throw new AppError("Google account does not have a verified email address", 400);
	}

	// ── Step 2: Returning OAuth user (fast path) ──────────────────────────────
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

		const tokens = buildTokenResponse(
			existingByGoogleId.user_id,
			existingByGoogleId.email,
			roles,
			existingByGoogleId.is_email_verified,
		);
		await storeRefreshToken(existingByGoogleId.user_id, tokens.refreshToken);
		return tokens;
	}

	// ── Step 3: Account linking ───────────────────────────────────────────────
	//
	// Email exists but google_id is NULL on this row (or was NULL at read time).
	// Write google_id onto the existing row. The UPDATE itself uses AND google_id IS NULL
	// as a concurrency guard — see the rowCount check below.
	const existingByEmail = await findUserByEmail(email);

	if (existingByEmail) {
		if (INACTIVE_ACCOUNT_STATUSES.has(existingByEmail.account_status)) {
			throw new AppError(`Account is ${existingByEmail.account_status}`, 401);
		}

		// AND google_id IS NULL is the concurrency guard: if two OAuth requests for
		// the same email arrive simultaneously with different googleIds, both pass the
		// findUserByGoogleId null-check above. Without this clause the second writer
		// would silently overwrite the first link. With it, the loser gets rowCount = 0
		// and we surface a 409 rather than issuing tokens that reflect a link that was
		// not actually applied.
		const { rowCount: linkRowCount } = await pool.query(
			`UPDATE users SET google_id = $1 WHERE user_id = $2 AND google_id IS NULL AND deleted_at IS NULL`,
			[googleId, existingByEmail.user_id],
		);

		if (linkRowCount === 0) {
			// The row exists but google_id was already set by a concurrent request —
			// the account is already linked to a different Google identity.
			throw new AppError("This account is already linked to a different Google account", 409);
		}

		const { rows: roleRows } = await pool.query(`SELECT role_name FROM user_roles WHERE user_id = $1`, [
			existingByEmail.user_id,
		]);
		const roles = roleRows.map((r) => r.role_name);

		logger.info({ userId: existingByEmail.user_id }, "Google account linked to existing email/password account");

		const tokens = buildTokenResponse(
			existingByEmail.user_id,
			existingByEmail.email,
			roles,
			existingByEmail.is_email_verified,
		);
		await storeRefreshToken(existingByEmail.user_id, tokens.refreshToken);
		return tokens;
	}

	// ── Step 4: New user — registration ──────────────────────────────────────
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
			// password_hash omitted — NULL by default (no password for OAuth users).
			// is_email_verified = TRUE because Google already verified this email —
			// no OTP flow is needed or appropriate.
			const { rows: userRows } = await client.query(
				`INSERT INTO users (email, google_id, is_email_verified)
         VALUES ($1, $2, TRUE)
         RETURNING user_id, email, is_email_verified`,
				[email, googleId],
			);
			user = userRows[0];
		} catch (err) {
			// Concurrent registration race — same defence as email/password register.
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

			// Institution domain lookup — identical logic to email/password register.
			// Google's verified email domain is trusted proof of institutional enrollment.
			const domain = email.split("@")[1];
			const institution = await findInstitutionByDomain(domain, client);

			if (institution) {
				await client.query(`UPDATE student_profiles SET institution_id = $1 WHERE user_id = $2`, [
					institution.institution_id,
					user.user_id,
				]);
				// is_email_verified is already TRUE from the INSERT — no UPDATE needed.
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
		// is_email_verified = TRUE — set at INSERT time, no tracking variable needed
		const tokens = buildTokenResponse(user.user_id, user.email, roles, true);
		await storeRefreshToken(user.user_id, tokens.refreshToken);
		return tokens;
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
};
