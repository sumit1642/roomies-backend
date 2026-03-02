// tests/setup/dbHelpers.js
//
// Shared infrastructure for the entire integration test suite.
//
// Three exports:
//   1. truncateAll()      — wipes every table in FK-safe order between tests
//   2. Factory functions  — createUser(), createInstitution(), createVerificationRequest()
//   3. Token helpers      — loginAs(), getAuthCookies()
//
// Design principle: tests should only specify what they care about.
// Everything else comes from defaults defined here. This keeps test files
// focused on the behaviour being tested rather than on database setup ceremony.

import pg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "../../src/config/env.js";

const { Pool } = pg;

// ─── Shared pool ──────────────────────────────────────────────────────────────
//
// Each test file that imports dbHelpers gets this pool. The test file is
// responsible for calling pool.end() in its own afterAll() hook.
//
// Why not import from src/db/client.js? Because that module exports a singleton
// that was designed to live for the lifetime of the server process. In tests,
// multiple test files run in separate Jest worker contexts — each worker gets
// its own module instance, so there is no true singleton across files. Defining
// the pool here makes the ownership clear: this file creates it, the test file
// that uses it closes it.
export const pool = new Pool({ connectionString: config.DATABASE_URL });

// ─── Pre-computed password hash ───────────────────────────────────────────────
//
// bcrypt at cost 10 takes ~100ms per hash. A test suite creating 50+ users would
// spend 5+ seconds just hashing passwords before a single assertion runs.
//
// Solution: hash a single known password once when this module loads (at the
// start of the test run) and reuse that hash for every factory-created user.
// Tests that need to log in use DEFAULT_PASSWORD as the plain-text credential.
//
// Cost factor is reduced to 4 for tests — still real bcrypt, just faster.
// The cost factor doesn't need to be production-strength here because we're
// testing application logic, not the hashing itself.
export const DEFAULT_PASSWORD = "TestPass1";
const BCRYPT_TEST_ROUNDS = 4;

// This runs once when the module is first imported by any test file.
// Subsequent imports in the same Jest worker process get the cached promise.
const passwordHashPromise = bcrypt.hash(DEFAULT_PASSWORD, BCRYPT_TEST_ROUNDS);

// ─── Truncation ───────────────────────────────────────────────────────────────

// Wipes all Phase 1 tables in a single statement.
//
// Why CASCADE? It handles FK dependencies automatically. Why RESTART IDENTITY?
// It resets sequences so IDs don't accumulate across runs. Both are safe here
// because we own the test database entirely.
//
// Table order matters even with CASCADE for some edge cases, so we list them
// child-first: verification_requests and user_preferences reference users,
// student_profiles and pg_owner_profiles reference both users and institutions,
// user_roles references users, users is the root. institutions is last
// because student_profiles references it — but since we CASCADE from
// student_profiles first, institutions can be safely cleared.
//
// We also flush Redis DB /1 here because OTP state and refresh tokens live
// there. A test that doesn't clean Redis state will cause false failures in
// the next test that checks whether a token has been revoked.
export const truncateAll = async (redisClient) => {
	await pool.query(`
		TRUNCATE
			verification_requests,
			user_preferences,
			student_profiles,
			pg_owner_profiles,
			user_roles,
			users,
			institutions
		RESTART IDENTITY CASCADE
	`);

	// Flush the test Redis keyspace (/1). This clears OTP hashes, attempt
	// counters, and refresh tokens left over from the previous test.
	// FLUSHDB only affects the currently selected database index — it has
	// zero effect on the /0 development keyspace.
	if (redisClient) {
		await redisClient.flushDb();
	}
};

// ─── Factory: Institution ─────────────────────────────────────────────────────

// Creates a single institution row with a unique domain by default.
// Tests that need institution auto-verification seed one of these first,
// then register a student with an email at that domain.
//
// Returns the full row so tests can reference institution_id in assertions.
export const createInstitution = async (overrides = {}) => {
	// Default to a unique domain so multiple tests can each create their own
	// institution without conflicting on the unique index.
	const defaults = {
		name: "Test University",
		city: "Mumbai",
		state: "Maharashtra",
		email_domain: `testuniv-${Date.now()}.ac.in`,
		type: "university",
	};

	const data = { ...defaults, ...overrides };

	const { rows } = await pool.query(
		`INSERT INTO institutions (name, city, state, email_domain, type)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING *`,
		[data.name, data.city, data.state, data.email_domain, data.type],
	);

	return rows[0];
};

// ─── Factory: User ────────────────────────────────────────────────────────────

// Creates a complete, valid user ready for use in tests.
//
// "Complete" means: a row in users, a row in user_roles, and a row in the
// appropriate profile table (student_profiles or pg_owner_profiles). This
// mirrors what the real registration transaction does, so the resulting DB
// state is identical to what a real registration would produce.
//
// Returns the user row merged with the plain-text password, so test code can
// immediately call loginAs(user) without needing to know the password.
//
// The password hash is the pre-computed one from module load — fast, real bcrypt.
export const createUser = async (overrides = {}) => {
	const passwordHash = await passwordHashPromise;

	const defaults = {
		email: `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`,
		role: "student",
		full_name: "Test User",
		account_status: "active",
		is_email_verified: false,
	};

	const data = { ...defaults, ...overrides };

	// All three inserts in one transaction — same atomicity guarantee as the real
	// registration service. If any insert fails, none of them persist.
	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		const { rows: userRows } = await client.query(
			`INSERT INTO users (email, password_hash, account_status, is_email_verified)
			 VALUES ($1, $2, $3, $4)
			 RETURNING *`,
			[data.email, passwordHash, data.account_status, data.is_email_verified],
		);
		const user = userRows[0];

		await client.query(`INSERT INTO user_roles (user_id, role_name) VALUES ($1, $2)`, [user.user_id, data.role]);

		// Profile table depends on role
		if (data.role === "student") {
			await client.query(
				`INSERT INTO student_profiles (user_id, full_name, institution_id)
				 VALUES ($1, $2, $3)`,
				[user.user_id, data.full_name, data.institution_id ?? null],
			);
		} else if (data.role === "pg_owner") {
			// pg_owner needs business_name — default to something sensible
			await client.query(
				`INSERT INTO pg_owner_profiles (user_id, owner_full_name, business_name, verification_status)
				 VALUES ($1, $2, $3, $4)`,
				[
					user.user_id,
					data.full_name,
					data.business_name ?? "Test PG Business",
					data.verification_status ?? "unverified",
				],
			);
		} else if (data.role === "admin") {
			// Admins have no profile table — only the user + role rows are needed.
			// This matches how admins are seeded in production (directly into DB).
		}

		await client.query("COMMIT");

		// Return the user row plus plain-text password so tests can log in.
		// We attach the role here too for convenience — most tests need it.
		return {
			...user,
			role: data.role,
			plainPassword: DEFAULT_PASSWORD,
		};
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
};

// ─── Factory: Verification Request ───────────────────────────────────────────

// Creates a verification_requests row for a given PG owner.
// Used by admin queue and approve/reject tests to seed queue items
// without going through the HTTP submission endpoint.
//
// Returns the full row including request_id, which tests need for the
// approve/reject endpoints.
export const createVerificationRequest = async (userId, overrides = {}) => {
	const defaults = {
		document_type: "owner_id",
		document_url: "https://storage.example.com/test-doc.pdf",
		status: "pending",
	};

	const data = { ...defaults, ...overrides };

	const { rows } = await pool.query(
		`INSERT INTO verification_requests (user_id, document_type, document_url, status)
		 VALUES ($1, $2, $3, $4)
		 RETURNING *`,
		[userId, data.document_type, data.document_url, data.status],
	);

	return rows[0];
};

// ─── Token helpers ────────────────────────────────────────────────────────────

// Performs a real login via the HTTP layer and returns the full supertest
// response. Tests that need cookies use res.headers['set-cookie']; tests
// that need body tokens use res.body.data.
//
// Usage:
//   const res = await loginAs(request, user);
//   const cookies = res.headers['set-cookie'];
//   const { accessToken } = res.body.data;
//
// We pass `request` (the supertest agent) rather than importing app here
// to avoid circular dependency issues — the test file owns the supertest
// instance and passes it in.
export const loginAs = async (request, user) => {
	return request.post("/api/v1/auth/login").send({
		email: user.email,
		password: user.plainPassword ?? DEFAULT_PASSWORD,
	});
};

// Issues a JWT directly without hitting the HTTP layer — useful for
// testing middleware behaviour with tokens that have specific properties
// (e.g. an expired token, a token for a suspended user) that cannot be
// easily produced through the login endpoint.
//
// The `overrides` object is merged into the JWT payload. Common uses:
//   issueToken(user)                          → normal valid token
//   issueToken(user, {}, { expiresIn: '-1s' }) → already-expired token
export const issueToken = (user, payloadOverrides = {}, signOptions = {}) => {
	const payload = {
		userId: user.user_id,
		email: user.email,
		roles: [user.role],
		...payloadOverrides,
	};

	return jwt.sign(payload, config.JWT_SECRET, {
		expiresIn: config.JWT_EXPIRES_IN,
		...signOptions,
	});
};

// Extracts the Set-Cookie header from a supertest response and returns
// it in a format that can be passed directly to subsequent requests.
//
// Supertest's .set('Cookie', cookies) expects the array that
// res.headers['set-cookie'] returns — this helper just makes that
// pattern explicit and named so test code reads clearly.
export const extractCookies = (res) => {
	return res.headers["set-cookie"] ?? [];
};
