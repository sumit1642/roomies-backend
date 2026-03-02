// tests/auth/login.test.js
//
// Integration tests for POST /api/v1/auth/login.
//
// Key behaviours under test:
//   1. Happy path — tokens, cookies, user object shape
//   2. Credential failures — wrong password, unknown email (same message, anti-enumeration)
//   3. OAuth-only user attempts password login (password_hash is NULL)
//   4. Inactive account status checks (suspended, banned, deactivated)
//   5. Validation errors at the Zod boundary

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "@jest/globals";
import supertest from "supertest";
import { createClient } from "redis";
import { app } from "../../src/app.js";
import { config } from "../../src/config/env.js";
import { pool, truncateAll, createUser, DEFAULT_PASSWORD } from "../setup/dbHelpers.js";

const request = supertest(app);
let redis;

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
	redis = createClient({ url: config.REDIS_URL });
	await redis.connect();
});

beforeEach(async () => {
	await truncateAll(redis);
});

afterAll(async () => {
	await redis.close();
	await pool.end();
});

// ─── Group 1: Happy path ──────────────────────────────────────────────────────

describe("POST /api/v1/auth/login — happy path", () => {
	it("returns 200 with both tokens and the correct user object", async () => {
		const user = await createUser({ role: "student" });

		const res = await request.post("/api/v1/auth/login").send({ email: user.email, password: DEFAULT_PASSWORD });

		expect(res.status).toBe(200);
		expect(res.body.status).toBe("success");

		// Both tokens must be present in the body (Android client path)
		expect(res.body.data.accessToken).toBeTruthy();
		expect(res.body.data.refreshToken).toBeTruthy();

		// User object must carry the correct identity
		expect(res.body.data.user.email).toBe(user.email);
		expect(res.body.data.user.roles).toContain("student");

		// Password must never appear in any response
		expect(JSON.stringify(res.body)).not.toContain(DEFAULT_PASSWORD);
	});

	it("sets HttpOnly SameSite=Strict cookies for the browser client path", async () => {
		const user = await createUser();

		const res = await request.post("/api/v1/auth/login").send({ email: user.email, password: DEFAULT_PASSWORD });

		expect(res.status).toBe(200);

		const cookies = res.headers["set-cookie"];
		expect(cookies).toBeDefined();

		const httpOnlyCount = cookies.filter((c) => c.toLowerCase().includes("httponly")).length;
		expect(httpOnlyCount).toBe(2);

		const sameSiteCount = cookies.filter((c) => c.toLowerCase().includes("samesite=strict")).length;
		expect(sameSiteCount).toBe(2);
	});

	it("stores the refresh token in Redis under refreshToken:{userId}", async () => {
		const user = await createUser();

		const res = await request.post("/api/v1/auth/login").send({ email: user.email, password: DEFAULT_PASSWORD });

		expect(res.status).toBe(200);

		const stored = await redis.get(`refreshToken:${user.user_id}`);
		expect(stored).toBe(res.body.data.refreshToken);
	});

	it("reflects is_email_verified correctly in the user object", async () => {
		const verified = await createUser({ is_email_verified: true });
		const unverified = await createUser({ is_email_verified: false });

		const r1 = await request.post("/api/v1/auth/login").send({ email: verified.email, password: DEFAULT_PASSWORD });
		expect(r1.body.data.user.isEmailVerified).toBe(true);

		const r2 = await request
			.post("/api/v1/auth/login")
			.send({ email: unverified.email, password: DEFAULT_PASSWORD });
		expect(r2.body.data.user.isEmailVerified).toBe(false);
	});

	it("includes the correct roles array for a pg_owner", async () => {
		const owner = await createUser({ role: "pg_owner" });

		const res = await request.post("/api/v1/auth/login").send({ email: owner.email, password: DEFAULT_PASSWORD });

		expect(res.status).toBe(200);
		expect(res.body.data.user.roles).toContain("pg_owner");
		expect(res.body.data.user.roles).not.toContain("student");
	});
});

// ─── Group 2: Credential failures ────────────────────────────────────────────
//
// Both "wrong password" and "no such email" must return the identical response.
// This is the anti-enumeration design: an attacker watching HTTP responses cannot
// learn whether an email address is registered on the platform.

describe("POST /api/v1/auth/login — credential failures", () => {
	it("returns 401 for a wrong password with the generic message", async () => {
		const user = await createUser();

		const res = await request.post("/api/v1/auth/login").send({ email: user.email, password: "WrongPass9" });

		expect(res.status).toBe(401);
		expect(res.body.message).toBe("Invalid credentials");
	});

	it("returns 401 for an unknown email with the same generic message", async () => {
		const res = await request
			.post("/api/v1/auth/login")
			.send({ email: "nobody@example.com", password: "SomePass1" });

		expect(res.status).toBe(401);
		// Must be identical to the wrong-password message — same response, no enumeration
		expect(res.body.message).toBe("Invalid credentials");
	});

	it("does not set any auth cookies on a failed login", async () => {
		const res = await request
			.post("/api/v1/auth/login")
			.send({ email: "nobody@example.com", password: "SomePass1" });

		expect(res.status).toBe(401);

		// No Set-Cookie header at all, or none containing auth tokens
		const cookies = res.headers["set-cookie"] ?? [];
		const hasAuthCookie = cookies.some((c) => c.startsWith("accessToken=") || c.startsWith("refreshToken="));
		expect(hasAuthCookie).toBe(false);
	});
});

// ─── Group 3: OAuth-only user attempts password login ─────────────────────────
//
// A user who registered via Google OAuth has password_hash = NULL in the DB.
// bcrypt.compare() against null would throw a TypeError. The service uses
// DUMMY_HASH in this case — the compare cleanly returns false and the user
// gets the same 401 as any wrong-password attempt. No 500, no leaking info.

describe("POST /api/v1/auth/login — OAuth-only user", () => {
	it("returns 401 (not 500) when the user has no password hash", async () => {
		// Directly insert a user with NULL password_hash, as OAuth registration does
		const { rows } = await pool.query(
			`INSERT INTO users (email, password_hash, is_email_verified, google_id)
			 VALUES ($1, NULL, TRUE, $2)
			 RETURNING *`,
			["oauth-only@example.com", "google-sub-12345"],
		);
		const oauthUser = rows[0];
		await pool.query(`INSERT INTO user_roles (user_id, role_name) VALUES ($1, 'student')`, [oauthUser.user_id]);
		await pool.query(`INSERT INTO student_profiles (user_id, full_name) VALUES ($1, 'OAuth User')`, [
			oauthUser.user_id,
		]);

		const res = await request
			.post("/api/v1/auth/login")
			.send({ email: "oauth-only@example.com", password: "AnyPass1" });

		// Must be 401 with the same generic message — not a 500
		expect(res.status).toBe(401);
		expect(res.body.message).toBe("Invalid credentials");
	});
});

// ─── Group 4: Inactive account status ────────────────────────────────────────
//
// A correct password still returns 401 if the account is inactive.
// The status check runs AFTER bcrypt so timing stays constant —
// an attacker cannot distinguish "wrong password" from "suspended account"
// by response time.

describe("POST /api/v1/auth/login — inactive accounts", () => {
	for (const status of ["suspended", "banned", "deactivated"]) {
		it(`returns 401 for a ${status} account even with correct credentials`, async () => {
			const user = await createUser({ account_status: status });

			const res = await request
				.post("/api/v1/auth/login")
				.send({ email: user.email, password: DEFAULT_PASSWORD });

			expect(res.status).toBe(401);
			// Message should mention the status — different from the generic credential error
			expect(res.body.message.toLowerCase()).toContain(status);
		});
	}
});

// ─── Group 5: Validation errors ───────────────────────────────────────────────

describe("POST /api/v1/auth/login — Zod validation errors", () => {
	it("returns 400 when email is missing", async () => {
		const res = await request.post("/api/v1/auth/login").send({ password: "TestPass1" });

		expect(res.status).toBe(400);
		expect(res.body.errors.some((e) => e.field.includes("email"))).toBe(true);
	});

	it("returns 400 when email is malformed", async () => {
		const res = await request.post("/api/v1/auth/login").send({ email: "notanemail", password: "TestPass1" });

		expect(res.status).toBe(400);
		expect(res.body.errors.some((e) => e.field.includes("email"))).toBe(true);
	});

	it("returns 400 when password is missing", async () => {
		const res = await request.post("/api/v1/auth/login").send({ email: "test@example.com" });

		expect(res.status).toBe(400);
		expect(res.body.errors.some((e) => e.field.includes("password"))).toBe(true);
	});

	it("returns 400 when the body is empty", async () => {
		const res = await request.post("/api/v1/auth/login").send({});

		expect(res.status).toBe(400);
		expect(res.body.status).toBe("error");
	});
});
