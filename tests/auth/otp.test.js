// tests/auth/otp.test.js
//
// Integration tests for the OTP email verification flow:
//   POST /api/v1/auth/otp/send
//   POST /api/v1/auth/otp/verify
//
// These tests mock the email transport — we do not want real emails sent
// during tests, and we need to intercept the OTP value to verify it.
// Everything else (Redis state, DB state, rate limiting logic) is real.
//
// Test groups:
//   1. OTP send — happy path, already-verified guard, rate limiting proxy
//   2. OTP verify — correct code, wrong code, attempt exhaustion, expired OTP
//   3. Full flow — send then verify flips is_email_verified in the database

import { describe, it, expect, beforeAll, beforeEach, afterAll, jest } from "@jest/globals";
import supertest from "supertest";
import { createClient } from "redis";
import { app } from "../../src/app.js";
import { config } from "../../src/config/env.js";
import { pool, truncateAll, createUser, loginAs, extractCookies } from "../setup/dbHelpers.js";
import bcrypt from "bcryptjs";

const request = supertest(app);
let redis;

// ── Email mock ────────────────────────────────────────────────────────────────
//
// We mock nodemailer's createTransport so no real SMTP connection is made.
// The mock captures the OTP from the email body so tests can submit it.
//
// Why mock at the transport level rather than the service level?
// Mocking at the transport level lets the email service run fully — it still
// calls maskEmail, validates the OTP format, builds the HTML template, and
// calls transport.sendMail(). Only the actual network call is intercepted.
// This gives us confidence that the email service works correctly while
// keeping tests hermetic.
let capturedOtp = null;

jest.mock("nodemailer", () => ({
	createTransport: () => ({
		sendMail: async (options) => {
			// Extract the OTP from the plain-text body: "Your OTP is: 123456"
			const match = options.text?.match(/Your OTP is: (\d{6})/);
			if (match) capturedOtp = match[1];
			return { messageId: "test-message-id" };
		},
	}),
	getTestMessageUrl: () => null,
}));

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
	redis = createClient({ url: config.REDIS_URL });
	await redis.connect();
});

beforeEach(async () => {
	capturedOtp = null; // reset between tests
	await truncateAll(redis);
});

afterAll(async () => {
	await redis.close();
	await pool.end();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Creates an unverified user and returns both the user record and a valid
// Bearer token so the OTP endpoints (which require authenticate) can be called.
const setupUnverifiedUser = async () => {
	const user = await createUser({ is_email_verified: false });
	const loginRes = await loginAs(request, user);
	const token = loginRes.body.data.accessToken;
	return { user, token };
};

// ─── Group 1: OTP send ────────────────────────────────────────────────────────

describe("POST /api/v1/auth/otp/send", () => {
	it("returns 200 and stores a hashed OTP in Redis", async () => {
		const { user, token } = await setupUnverifiedUser();

		const res = await request.post("/api/v1/auth/otp/send").set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(200);
		expect(res.body.status).toBe("success");

		// The OTP hash must be stored in Redis under otp:{userId}
		const stored = await redis.get(`otp:${user.user_id}`);
		expect(stored).toBeTruthy();

		// The stored value must be a bcrypt hash, not the plain OTP
		// (bcrypt hashes start with $2a$ or $2b$)
		expect(stored).toMatch(/^\$2[ab]\$/);
	});

	it("resets the attempt counter in Redis when a new OTP is sent", async () => {
		const { user, token } = await setupUnverifiedUser();

		// Manually plant a stale attempt counter
		await redis.set(`otpAttempts:${user.user_id}`, "3");

		await request.post("/api/v1/auth/otp/send").set("Authorization", `Bearer ${token}`);

		// Sending a new OTP should delete the old attempt counter
		const attempts = await redis.get(`otpAttempts:${user.user_id}`);
		expect(attempts).toBeNull();
	});

	it("returns 409 when the user's email is already verified", async () => {
		const user = await createUser({ is_email_verified: true });
		const loginRes = await loginAs(request, user);
		const token = loginRes.body.data.accessToken;

		const res = await request.post("/api/v1/auth/otp/send").set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(409);
		expect(res.body.message).toMatch(/already verified/i);
	});

	it("returns 401 when called without authentication", async () => {
		const res = await request.post("/api/v1/auth/otp/send");
		expect(res.status).toBe(401);
	});
});

// ─── Group 2: OTP verify ──────────────────────────────────────────────────────

describe("POST /api/v1/auth/otp/verify", () => {
	it("returns 200 and flips is_email_verified in the database on a correct OTP", async () => {
		const { user, token } = await setupUnverifiedUser();

		// Send OTP first — this populates capturedOtp via the mock
		await request.post("/api/v1/auth/otp/send").set("Authorization", `Bearer ${token}`);

		expect(capturedOtp).toBeTruthy();

		const res = await request
			.post("/api/v1/auth/otp/verify")
			.set("Authorization", `Bearer ${token}`)
			.send({ otp: capturedOtp });

		expect(res.status).toBe(200);

		// Database must reflect the verification
		const { rows } = await pool.query(`SELECT is_email_verified FROM users WHERE user_id = $1`, [user.user_id]);
		expect(rows[0].is_email_verified).toBe(true);
	});

	it("cleans up the OTP and attempt counter from Redis on success", async () => {
		const { user, token } = await setupUnverifiedUser();

		await request.post("/api/v1/auth/otp/send").set("Authorization", `Bearer ${token}`);

		await request
			.post("/api/v1/auth/otp/verify")
			.set("Authorization", `Bearer ${token}`)
			.send({ otp: capturedOtp });

		// Both Redis keys must be deleted after successful verification
		const otpKey = await redis.get(`otp:${user.user_id}`);
		const attemptsKey = await redis.get(`otpAttempts:${user.user_id}`);

		expect(otpKey).toBeNull();
		expect(attemptsKey).toBeNull();
	});

	it("returns 400 on a wrong OTP and includes remaining attempts in the message", async () => {
		const { user, token } = await setupUnverifiedUser();

		await request.post("/api/v1/auth/otp/send").set("Authorization", `Bearer ${token}`);

		const res = await request
			.post("/api/v1/auth/otp/verify")
			.set("Authorization", `Bearer ${token}`)
			.send({ otp: "000000" }); // deliberately wrong

		expect(res.status).toBe(400);
		// Message must tell the user how many attempts remain
		expect(res.body.message).toMatch(/remaining/i);

		// Attempt counter must have been incremented
		const attempts = await redis.get(`otpAttempts:${user.user_id}`);
		expect(Number(attempts)).toBe(1);
	});

	it("returns 429 after 5 wrong OTP attempts", async () => {
		const { token } = await setupUnverifiedUser();

		await request.post("/api/v1/auth/otp/send").set("Authorization", `Bearer ${token}`);

		// Submit 4 wrong attempts — each should return 400
		for (let i = 0; i < 4; i++) {
			const r = await request
				.post("/api/v1/auth/otp/verify")
				.set("Authorization", `Bearer ${token}`)
				.send({ otp: "000000" });
			expect(r.status).toBe(400);
		}

		// The 5th wrong attempt should return 429
		const final = await request
			.post("/api/v1/auth/otp/verify")
			.set("Authorization", `Bearer ${token}`)
			.send({ otp: "000000" });

		expect(final.status).toBe(429);
	});

	it("returns 429 immediately if the attempt counter is already exhausted", async () => {
		// Simulates a user who exhausted their attempts in a previous session
		// and tries again without requesting a new OTP.
		const { user, token } = await setupUnverifiedUser();

		await request.post("/api/v1/auth/otp/send").set("Authorization", `Bearer ${token}`);

		// Plant an exhausted counter directly in Redis
		await redis.set(`otpAttempts:${user.user_id}`, "5");

		const res = await request
			.post("/api/v1/auth/otp/verify")
			.set("Authorization", `Bearer ${token}`)
			.send({ otp: capturedOtp ?? "123456" });

		expect(res.status).toBe(429);
		expect(res.body.message).toMatch(/too many/i);
	});

	it("returns 400 when the OTP has expired (key no longer in Redis)", async () => {
		// We seed the Redis key directly with a 1-second TTL rather than
		// waiting 600 seconds for the real TTL to expire.
		const { user, token } = await setupUnverifiedUser();

		// Plant a hash for a known OTP with a 1-second TTL
		const knownOtp = "999888";
		const hash = await bcrypt.hash(knownOtp, 4);
		await redis.setEx(`otp:${user.user_id}`, 1, hash);

		// Wait for the key to expire
		await new Promise((resolve) => setTimeout(resolve, 1100));

		const res = await request
			.post("/api/v1/auth/otp/verify")
			.set("Authorization", `Bearer ${token}`)
			.send({ otp: knownOtp });

		expect(res.status).toBe(400);
		expect(res.body.message).toMatch(/expired/i);
	});

	it("returns 400 when OTP format is invalid (not 6 digits)", async () => {
		const { token } = await setupUnverifiedUser();

		const res = await request
			.post("/api/v1/auth/otp/verify")
			.set("Authorization", `Bearer ${token}`)
			.send({ otp: "abc123" }); // contains letters

		// Zod validation rejects this before it reaches the service
		expect(res.status).toBe(400);
		expect(res.body.errors.some((e) => e.field.includes("otp"))).toBe(true);
	});

	it("returns 401 when called without authentication", async () => {
		const res = await request.post("/api/v1/auth/otp/verify").send({ otp: "123456" });

		expect(res.status).toBe(401);
	});
});
