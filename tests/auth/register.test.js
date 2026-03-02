// tests/auth/register.test.js
//
// Integration tests for POST /api/v1/auth/register.
//
// These tests exercise the full stack: HTTP → middleware → service → database.
// No mocking of the database or Redis — real infrastructure, real SQL,
// real constraints. This is what gives these tests their value: they prove
// the registration transaction actually works against the live schema.
//
// Test groups:
//   1. Happy path — student and pg_owner registration
//   2. Institution auto-verification
//   3. Zod validation errors (HTTP boundary)
//   4. Conflict errors (duplicate email)
//   5. Cross-field business rules (pg_owner requires businessName)

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "@jest/globals";
import supertest from "supertest";
import { createClient } from "redis";
import { app } from "../../src/app.js";
import { config } from "../../src/config/env.js";
import { pool, truncateAll, createInstitution } from "../setup/dbHelpers.js";

const request = supertest(app);
let redis;

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
	redis = createClient({ url: config.REDIS_URL });
	await redis.connect();
});

beforeEach(async () => {
	// Wipe DB and Redis before every test — each test starts from a clean slate.
	// No test should ever depend on state left by a previous test.
	await truncateAll(redis);
});

afterAll(async () => {
	await redis.close();
	await pool.end();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Minimum valid student payload — tests that care about one specific field
// spread over this and override only what they need.
const validStudent = () => ({
	email: `student-${Date.now()}@example.com`,
	password: "TestPass1",
	role: "student",
	fullName: "Priya Sharma",
});

const validPgOwner = () => ({
	email: `owner-${Date.now()}@example.com`,
	password: "TestPass1",
	role: "pg_owner",
	fullName: "Rajesh Kumar",
	businessName: "Kumar PG House",
});

// ─── Group 1: Happy path ──────────────────────────────────────────────────────

describe("POST /api/v1/auth/register — happy path", () => {
	it("registers a student and returns 201 with tokens and user object", async () => {
		const payload = validStudent();
		const res = await request.post("/api/v1/auth/register").send(payload);

		expect(res.status).toBe(201);
		expect(res.body.status).toBe("success");

		// Both tokens must be present in the body (Android client path)
		expect(res.body.data.accessToken).toBeTruthy();
		expect(res.body.data.refreshToken).toBeTruthy();

		// User object shape
		const user = res.body.data.user;
		expect(user.email).toBe(payload.email);
		expect(user.roles).toEqual(["student"]);
		// A plain email registration starts unverified (no institution match here)
		expect(user.isEmailVerified).toBe(false);

		// Password must never appear in any response field
		expect(JSON.stringify(res.body)).not.toContain(payload.password);
	});

	it("sets HttpOnly accessToken and refreshToken cookies (browser client path)", async () => {
		const res = await request.post("/api/v1/auth/register").send(validStudent());

		expect(res.status).toBe(201);

		const cookies = res.headers["set-cookie"];
		expect(cookies).toBeDefined();

		// Both cookies must be present
		const cookieStr = cookies.join("; ");
		expect(cookieStr).toMatch(/accessToken=/);
		expect(cookieStr).toMatch(/refreshToken=/);

		// Both must be HttpOnly — this is the XSS defence
		const httpOnlyCount = cookies.filter((c) => c.toLowerCase().includes("httponly")).length;
		expect(httpOnlyCount).toBe(2);

		// Both must be SameSite=Strict — this is the CSRF defence
		const sameSiteCount = cookies.filter((c) => c.toLowerCase().includes("samesite=strict")).length;
		expect(sameSiteCount).toBe(2);
	});

	it("creates the expected rows in users, user_roles, and student_profiles", async () => {
		const payload = validStudent();
		const res = await request.post("/api/v1/auth/register").send(payload);

		expect(res.status).toBe(201);
		const userId = res.body.data.user.userId;

		// Verify users row
		const { rows: userRows } = await pool.query(
			`SELECT email, account_status, is_email_verified FROM users WHERE user_id = $1`,
			[userId],
		);
		expect(userRows).toHaveLength(1);
		expect(userRows[0].email).toBe(payload.email);
		expect(userRows[0].account_status).toBe("active");

		// Verify user_roles row
		const { rows: roleRows } = await pool.query(`SELECT role_name FROM user_roles WHERE user_id = $1`, [userId]);
		expect(roleRows).toHaveLength(1);
		expect(roleRows[0].role_name).toBe("student");

		// Verify student_profiles row
		const { rows: profileRows } = await pool.query(`SELECT full_name FROM student_profiles WHERE user_id = $1`, [
			userId,
		]);
		expect(profileRows).toHaveLength(1);
		expect(profileRows[0].full_name).toBe(payload.fullName);
	});

	it("registers a pg_owner and creates pg_owner_profiles row with unverified status", async () => {
		const payload = validPgOwner();
		const res = await request.post("/api/v1/auth/register").send(payload);

		expect(res.status).toBe(201);
		const userId = res.body.data.user.userId;

		const { rows } = await pool.query(
			`SELECT business_name, verification_status FROM pg_owner_profiles WHERE user_id = $1`,
			[userId],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].business_name).toBe(payload.businessName);
		expect(rows[0].verification_status).toBe("unverified");
	});

	it("stores the refresh token in Redis so the refresh endpoint can validate it", async () => {
		const res = await request.post("/api/v1/auth/register").send(validStudent());

		expect(res.status).toBe(201);
		const userId = res.body.data.user.userId;
		const { refreshToken } = res.body.data;

		// The refresh token must be stored under refreshToken:{userId}
		const stored = await redis.get(`refreshToken:${userId}`);
		expect(stored).toBe(refreshToken);
	});
});

// ─── Group 2: Institution auto-verification ────────────────────────────────────

describe("POST /api/v1/auth/register — institution auto-verification", () => {
	it("auto-verifies a student whose email domain matches an institution", async () => {
		const institution = await createInstitution({ email_domain: "iitb.ac.in" });

		const res = await request.post("/api/v1/auth/register").send({
			...validStudent(),
			email: `student-${Date.now()}@iitb.ac.in`,
		});

		expect(res.status).toBe(201);

		// Token response must reflect verified state
		expect(res.body.data.user.isEmailVerified).toBe(true);

		const userId = res.body.data.user.userId;

		const { rows: userRows } = await pool.query(`SELECT is_email_verified FROM users WHERE user_id = $1`, [userId]);
		expect(userRows[0].is_email_verified).toBe(true);

		const { rows: profileRows } = await pool.query(
			`SELECT institution_id FROM student_profiles WHERE user_id = $1`,
			[userId],
		);
		expect(profileRows[0].institution_id).toBe(institution.institution_id);
	});

	it("does not auto-verify a student whose domain has no institution match", async () => {
		const res = await request.post("/api/v1/auth/register").send({
			...validStudent(),
			email: `student-${Date.now()}@gmail.com`,
		});

		expect(res.status).toBe(201);
		expect(res.body.data.user.isEmailVerified).toBe(false);

		const { rows } = await pool.query(`SELECT institution_id FROM student_profiles WHERE user_id = $1`, [
			res.body.data.user.userId,
		]);
		expect(rows[0].institution_id).toBeNull();
	});

	it("does not auto-verify a pg_owner even if their domain matches an institution", async () => {
		// Institution auto-verification is a student-only feature.
		// PG owners go through manual document review regardless of email domain.
		await createInstitution({ email_domain: "iitb.ac.in" });

		const res = await request.post("/api/v1/auth/register").send({
			...validPgOwner(),
			email: `owner-${Date.now()}@iitb.ac.in`,
		});

		expect(res.status).toBe(201);

		const { rows } = await pool.query(`SELECT verification_status FROM pg_owner_profiles WHERE user_id = $1`, [
			res.body.data.user.userId,
		]);
		expect(rows[0].verification_status).toBe("unverified");
	});
});

// ─── Group 3: Validation errors ───────────────────────────────────────────────

describe("POST /api/v1/auth/register — Zod validation errors", () => {
	it("returns 400 when email is missing", async () => {
		const { email, ...rest } = validStudent();
		const res = await request.post("/api/v1/auth/register").send(rest);

		expect(res.status).toBe(400);
		expect(res.body.status).toBe("error");
		expect(res.body.errors).toBeDefined();
	});

	it("returns 400 when email is not a valid address", async () => {
		const res = await request.post("/api/v1/auth/register").send({ ...validStudent(), email: "not-an-email" });

		expect(res.status).toBe(400);
		expect(res.body.errors.some((e) => e.field.includes("email"))).toBe(true);
	});

	it("returns 400 when password is too short", async () => {
		const res = await request.post("/api/v1/auth/register").send({ ...validStudent(), password: "Ab1" });

		expect(res.status).toBe(400);
		expect(res.body.errors.some((e) => e.field.includes("password"))).toBe(true);
	});

	it("returns 400 when password has no number", async () => {
		const res = await request.post("/api/v1/auth/register").send({ ...validStudent(), password: "OnlyLetters" });

		expect(res.status).toBe(400);
		expect(res.body.errors.some((e) => e.field.includes("password"))).toBe(true);
	});

	it("returns 400 when password has no letter", async () => {
		const res = await request.post("/api/v1/auth/register").send({ ...validStudent(), password: "12345678" });

		expect(res.status).toBe(400);
		expect(res.body.errors.some((e) => e.field.includes("password"))).toBe(true);
	});

	it("returns 400 when role is invalid", async () => {
		const res = await request.post("/api/v1/auth/register").send({ ...validStudent(), role: "superadmin" });

		expect(res.status).toBe(400);
		expect(res.body.errors.some((e) => e.field.includes("role"))).toBe(true);
	});

	it("returns 400 when fullName is too short", async () => {
		const res = await request.post("/api/v1/auth/register").send({ ...validStudent(), fullName: "A" });

		expect(res.status).toBe(400);
		expect(res.body.errors.some((e) => e.field.includes("fullName"))).toBe(true);
	});
});

// ─── Group 4: Conflict errors ─────────────────────────────────────────────────

describe("POST /api/v1/auth/register — duplicate email", () => {
	it("returns 409 when the email is already registered", async () => {
		const payload = validStudent();

		const first = await request.post("/api/v1/auth/register").send(payload);
		expect(first.status).toBe(201);

		// Same payload again — must be rejected
		const second = await request.post("/api/v1/auth/register").send(payload);
		expect(second.status).toBe(409);
		expect(second.body.message).toMatch(/already exists/i);
	});
});

// ─── Group 5: Cross-field business rules ─────────────────────────────────────

describe("POST /api/v1/auth/register — pg_owner business rules", () => {
	it("returns 400 when role is pg_owner but businessName is absent", async () => {
		const { businessName, ...rest } = validPgOwner();
		const res = await request.post("/api/v1/auth/register").send(rest);

		// The service layer enforces this — Zod marks businessName as optional
		// because it is only required for pg_owner registrations.
		expect(res.status).toBe(400);
		expect(res.body.message).toMatch(/business name/i);
	});

	it("returns 400 when role is pg_owner and businessName is only whitespace", async () => {
		const res = await request.post("/api/v1/auth/register").send({ ...validPgOwner(), businessName: "   " });

		expect(res.status).toBe(400);
		expect(res.body.message).toMatch(/business name/i);
	});

	it("allows businessName to be absent when role is student", async () => {
		// businessName is optional for students — its absence must not cause an error
		const payload = validStudent();
		delete payload.businessName;
		const res = await request.post("/api/v1/auth/register").send(payload);

		expect(res.status).toBe(201);
	});
});
