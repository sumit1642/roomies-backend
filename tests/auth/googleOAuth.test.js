// tests/auth/googleOAuth.test.js
//
// Integration tests for POST /api/v1/auth/google/callback.
//
// WHY MOCKING IS NECESSARY HERE (and only here):
// googleOAuthClient.verifyIdToken() makes a real HTTP call to Google's JWKS
// endpoint to fetch the public keys used to verify the token signature. This
// external dependency makes the test non-deterministic — it requires network
// access, can fail on rate limits, and we have no control over what Google
// returns. We cannot manufacture a real Google ID token in a test environment.
//
// The mock intercepts the call at the OAuth2Client level, returning a
// controllable payload. Everything downstream of that call — the DB branching
// logic, the transaction, the institution domain lookup, dual-delivery tokens —
// all runs against real infrastructure with no further mocking.
//
// Test groups:
//   1. Returning OAuth user (google_id match → login, fast path)
//   2. Account linking (email match, google_id null → link then login)
//   3. New user registration (no matches → full transaction)
//   4. Validation and edge cases

import { describe, it, expect, beforeAll, beforeEach, afterAll, jest } from "@jest/globals";
import supertest from "supertest";
import { createClient } from "redis";
import { app } from "../../src/app.js";
import { config } from "../../src/config/env.js";
import { pool, truncateAll, createUser, createInstitution } from "../setup/dbHelpers.js";

const request = supertest(app);
let redis;

// ── Google OAuth mock ─────────────────────────────────────────────────────────
//
// We mock the entire google-auth-library module. The mock factory function
// returns a class whose verifyIdToken() method returns a controllable ticket.
//
// currentMockPayload is mutated per-test to control what the "verified" Google
// token contains. Tests set it before making the request.
let currentMockPayload = null;

jest.mock("google-auth-library", () => {
	return {
		OAuth2Client: jest.fn().mockImplementation(() => ({
			verifyIdToken: jest.fn().mockImplementation(async ({ idToken }) => {
				// Simulate a failed verification for the sentinel value
				if (idToken === "invalid-token") {
					throw new Error("Token used too late");
				}
				return {
					getPayload: () => currentMockPayload,
				};
			}),
		})),
	};
});

// ── Helpers ───────────────────────────────────────────────────────────────────

// Builds a fake Google ID token payload. Tests override specific fields.
const makeGooglePayload = (overrides = {}) => ({
	sub: `google-sub-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
	email: `guser-${Date.now()}@gmail.com`,
	email_verified: true,
	name: "Google User",
	...overrides,
});

// Sends a POST to the google/callback endpoint with the given idToken and body.
// Sets currentMockPayload before the call so verifyIdToken returns it.
const callGoogleCallback = (payload, body = {}) => {
	currentMockPayload = payload;
	return request.post("/api/v1/auth/google/callback").send({ idToken: "valid-google-id-token", ...body });
};

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
	redis = createClient({ url: config.REDIS_URL });
	await redis.connect();
});

beforeEach(async () => {
	currentMockPayload = null;
	await truncateAll(redis);
});

afterAll(async () => {
	await redis.close();
	await pool.end();
});

// ─── Group 1: Returning OAuth user ────────────────────────────────────────────

describe("POST /api/v1/auth/google/callback — returning OAuth user", () => {
	it("returns 200 with tokens when google_id matches an existing user", async () => {
		// Create a user who already has a google_id (returned from a previous OAuth login)
		const googleSub = "existing-google-sub-001";
		const { rows } = await pool.query(
			`INSERT INTO users (email, google_id, is_email_verified)
			 VALUES ($1, $2, TRUE)
			 RETURNING *`,
			["returninguser@gmail.com", googleSub],
		);
		const user = rows[0];
		await pool.query(`INSERT INTO user_roles (user_id, role_name) VALUES ($1, 'student')`, [user.user_id]);
		await pool.query(`INSERT INTO student_profiles (user_id, full_name) VALUES ($1, 'Returning User')`, [
			user.user_id,
		]);

		const payload = makeGooglePayload({ sub: googleSub, email: "returninguser@gmail.com" });
		const res = await callGoogleCallback(payload);

		expect(res.status).toBe(200);
		expect(res.body.data.accessToken).toBeTruthy();
		expect(res.body.data.user.email).toBe("returninguser@gmail.com");

		// Dual delivery — cookies must also be set
		const cookies = res.headers["set-cookie"] ?? [];
		expect(cookies.some((c) => c.startsWith("accessToken="))).toBe(true);
	});

	it("returns 401 for a returning OAuth user whose account is suspended", async () => {
		const googleSub = "suspended-google-sub-002";
		const { rows } = await pool.query(
			`INSERT INTO users (email, google_id, is_email_verified, account_status)
			 VALUES ($1, $2, TRUE, 'suspended')
			 RETURNING *`,
			["suspended@gmail.com", googleSub],
		);
		await pool.query(`INSERT INTO user_roles (user_id, role_name) VALUES ($1, 'student')`, [rows[0].user_id]);

		const payload = makeGooglePayload({ sub: googleSub, email: "suspended@gmail.com" });
		const res = await callGoogleCallback(payload);

		expect(res.status).toBe(401);
		expect(res.body.message).toMatch(/suspended/i);
	});
});

// ─── Group 2: Account linking ─────────────────────────────────────────────────

describe("POST /api/v1/auth/google/callback — account linking", () => {
	it("links google_id to an existing email/password account and returns tokens", async () => {
		// A user registered with email/password — google_id is NULL
		const existingUser = await createUser({ role: "student" });

		const googleSub = "new-link-sub-003";
		const payload = makeGooglePayload({ sub: googleSub, email: existingUser.email });
		const res = await callGoogleCallback(payload);

		expect(res.status).toBe(200);
		expect(res.body.data.accessToken).toBeTruthy();

		// The google_id must now be written to the users row
		const { rows } = await pool.query(`SELECT google_id FROM users WHERE user_id = $1`, [existingUser.user_id]);
		expect(rows[0].google_id).toBe(googleSub);
	});

	it("returns 409 when the email account already has a different google_id linked", async () => {
		// Simulates the race condition: account was linked by another request
		// between our findUserByGoogleId (null result) and our UPDATE.
		const googleSub = "already-linked-sub-004";
		const { rows } = await pool.query(
			`INSERT INTO users (email, google_id, is_email_verified)
			 VALUES ($1, $2, TRUE)
			 RETURNING *`,
			["linked@gmail.com", googleSub],
		);
		await pool.query(`INSERT INTO user_roles (user_id, role_name) VALUES ($1, 'student')`, [rows[0].user_id]);
		await pool.query(`INSERT INTO student_profiles (user_id, full_name) VALUES ($1, 'Linked User')`, [
			rows[0].user_id,
		]);

		// A different Google sub tries to link to the same email
		const differentSub = "different-sub-trying-to-link";
		const payload = makeGooglePayload({ sub: differentSub, email: "linked@gmail.com" });
		const res = await callGoogleCallback(payload);

		expect(res.status).toBe(409);
		expect(res.body.message).toMatch(/already linked/i);
	});
});

// ─── Group 3: New user registration ───────────────────────────────────────────

describe("POST /api/v1/auth/google/callback — new user registration", () => {
	it("registers a new student via Google OAuth and returns 200 with tokens", async () => {
		const payload = makeGooglePayload({ email: `newstudent-${Date.now()}@gmail.com` });

		const res = await callGoogleCallback(payload, {
			role: "student",
			fullName: "New Student Via Google",
		});

		expect(res.status).toBe(200);
		expect(res.body.data.accessToken).toBeTruthy();

		// Google-registered users are email-verified from the start
		expect(res.body.data.user.isEmailVerified).toBe(true);

		// Confirm DB rows were created
		const userId = res.body.data.user.userId;
		const { rows: roleRows } = await pool.query(`SELECT role_name FROM user_roles WHERE user_id = $1`, [userId]);
		expect(roleRows[0].role_name).toBe("student");
	});

	it("auto-verifies institution for a new OAuth student with a matching domain", async () => {
		const institution = await createInstitution({ email_domain: "iitb.ac.in" });
		const googleEmail = `oauth-student-${Date.now()}@iitb.ac.in`;

		// Google verifies this email — Google says it's verified
		const payload = makeGooglePayload({ email: googleEmail, email_verified: true });
		const res = await callGoogleCallback(payload, {
			role: "student",
			fullName: "IIT Student",
		});

		expect(res.status).toBe(200);

		const userId = res.body.data.user.userId;
		const { rows } = await pool.query(`SELECT institution_id FROM student_profiles WHERE user_id = $1`, [userId]);
		expect(rows[0].institution_id).toBe(institution.institution_id);
	});

	it("registers a new pg_owner via Google OAuth", async () => {
		const payload = makeGooglePayload({ email: `newowner-${Date.now()}@gmail.com` });

		const res = await callGoogleCallback(payload, {
			role: "pg_owner",
			fullName: "New Owner Via Google",
			businessName: "Google-Registered PG",
		});

		expect(res.status).toBe(200);

		const userId = res.body.data.user.userId;
		const { rows } = await pool.query(
			`SELECT business_name, verification_status FROM pg_owner_profiles WHERE user_id = $1`,
			[userId],
		);
		expect(rows[0].business_name).toBe("Google-Registered PG");
		expect(rows[0].verification_status).toBe("unverified");
	});

	it("returns 400 when role is missing for a new user", async () => {
		const payload = makeGooglePayload();
		// No role provided — service must reject this for a new user registration
		const res = await callGoogleCallback(payload, { fullName: "Someone" });

		expect(res.status).toBe(400);
		expect(res.body.message).toMatch(/role/i);
	});

	it("returns 400 when fullName is missing for a new user", async () => {
		const payload = makeGooglePayload();
		const res = await callGoogleCallback(payload, { role: "student" });

		expect(res.status).toBe(400);
		expect(res.body.message).toMatch(/full name/i);
	});

	it("returns 400 when pg_owner is registering without businessName", async () => {
		const payload = makeGooglePayload();
		const res = await callGoogleCallback(payload, {
			role: "pg_owner",
			fullName: "PG Owner No Business",
		});

		expect(res.status).toBe(400);
		expect(res.body.message).toMatch(/business name/i);
	});
});

// ─── Group 4: Validation and edge cases ───────────────────────────────────────

describe("POST /api/v1/auth/google/callback — validation and edge cases", () => {
	it("returns 400 when idToken is missing from the request body", async () => {
		const res = await request.post("/api/v1/auth/google/callback").send({ role: "student", fullName: "Someone" });

		// Zod validation rejects this before the service touches it
		expect(res.status).toBe(400);
		expect(res.body.errors.some((e) => e.field.includes("idToken"))).toBe(true);
	});

	it("returns 401 when the Google token fails verification", async () => {
		currentMockPayload = null;
		const res = await request
			.post("/api/v1/auth/google/callback")
			.send({ idToken: "invalid-token", role: "student", fullName: "Someone" });

		expect(res.status).toBe(401);
		expect(res.body.message).toMatch(/invalid or expired google token/i);
	});

	it("returns 400 when the Google account email is not verified", async () => {
		const payload = makeGooglePayload({ email_verified: false });
		const res = await callGoogleCallback(payload, { role: "student", fullName: "Unverified" });

		expect(res.status).toBe(400);
		expect(res.body.message).toMatch(/verified email/i);
	});
});
