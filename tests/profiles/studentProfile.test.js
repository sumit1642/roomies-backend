// tests/profiles/studentProfile.test.js
//
// Integration tests for the student profile endpoints:
//   GET /api/v1/students/:userId/profile
//   PUT /api/v1/students/:userId/profile

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "@jest/globals";
import supertest from "supertest";
import { createClient } from "redis";
import { app } from "../../src/app.js";
import { config } from "../../src/config/env.js";
import { pool, truncateAll, createUser, loginAs } from "../setup/dbHelpers.js";

const request = supertest(app);
let redis;

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

// ─── Group 1: GET profile ──────────────────────────────────────────────────────

describe("GET /api/v1/students/:userId/profile", () => {
	it("returns the profile for any authenticated user (world-readable)", async () => {
		// studentA is the profile owner; studentB is a different authenticated user.
		// studentB should be able to read studentA's profile — this is by design,
		// students need to evaluate potential roommates.
		const studentA = await createUser({ role: "student" });
		const studentB = await createUser({ role: "student" });

		const loginRes = await loginAs(request, studentB);
		const token = loginRes.body.data.accessToken;

		const res = await request
			.get(`/api/v1/students/${studentA.user_id}/profile`)
			.set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(200);
		expect(res.body.data.user_id).toBe(studentA.user_id);
		expect(res.body.data.email).toBe(studentA.email);
	});

	it("returns the correct profile fields and excludes sensitive data", async () => {
		const student = await createUser({ role: "student" });
		const loginRes = await loginAs(request, student);
		const token = loginRes.body.data.accessToken;

		const res = await request
			.get(`/api/v1/students/${student.user_id}/profile`)
			.set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(200);

		const profile = res.body.data;
		expect(profile).toHaveProperty("profile_id");
		expect(profile).toHaveProperty("user_id");
		expect(profile).toHaveProperty("full_name");
		expect(profile).toHaveProperty("email");
		expect(profile).toHaveProperty("average_rating");
		expect(profile).toHaveProperty("rating_count");

		// Sensitive fields must never appear in the response
		expect(profile).not.toHaveProperty("password_hash");
		expect(profile).not.toHaveProperty("google_id");
	});

	it("returns 404 for a valid UUID that has no matching profile", async () => {
		const student = await createUser({ role: "student" });
		const loginRes = await loginAs(request, student);
		const token = loginRes.body.data.accessToken;

		const res = await request
			.get(`/api/v1/students/00000000-0000-0000-0000-000000000000/profile`)
			.set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(404);
	});

	it("returns 400 for a malformed userId (not a UUID)", async () => {
		const student = await createUser({ role: "student" });
		const loginRes = await loginAs(request, student);
		const token = loginRes.body.data.accessToken;

		const res = await request.get(`/api/v1/students/not-a-uuid/profile`).set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(400);
	});

	it("returns 401 for an unauthenticated request", async () => {
		const student = await createUser({ role: "student" });
		const res = await request.get(`/api/v1/students/${student.user_id}/profile`);
		expect(res.status).toBe(401);
	});
});

// ─── Group 2: PUT profile ──────────────────────────────────────────────────────

describe("PUT /api/v1/students/:userId/profile", () => {
	it("allows a student to update their own profile and returns the updated data", async () => {
		const student = await createUser({ role: "student" });
		const loginRes = await loginAs(request, student);
		const token = loginRes.body.data.accessToken;

		const res = await request
			.put(`/api/v1/students/${student.user_id}/profile`)
			.set("Authorization", `Bearer ${token}`)
			.send({
				fullName: "Updated Name",
				bio: "New bio here",
				course: "Computer Science",
				yearOfStudy: 3,
			});

		expect(res.status).toBe(200);
		expect(res.body.data.full_name).toBe("Updated Name");
		expect(res.body.data.bio).toBe("New bio here");
		expect(res.body.data.year_of_study).toBe(3);
	});

	it("persists changes to the database", async () => {
		const student = await createUser({ role: "student" });
		const loginRes = await loginAs(request, student);
		const token = loginRes.body.data.accessToken;

		await request
			.put(`/api/v1/students/${student.user_id}/profile`)
			.set("Authorization", `Bearer ${token}`)
			.send({ fullName: "Persisted Name", course: "Physics" });

		const { rows } = await pool.query(`SELECT full_name, course FROM student_profiles WHERE user_id = $1`, [
			student.user_id,
		]);
		expect(rows[0].full_name).toBe("Persisted Name");
		expect(rows[0].course).toBe("Physics");
	});

	it("returns 403 when a student tries to update another student's profile", async () => {
		const studentA = await createUser({ role: "student" });
		const studentB = await createUser({ role: "student" });

		const loginRes = await loginAs(request, studentB);
		const token = loginRes.body.data.accessToken;

		const res = await request
			.put(`/api/v1/students/${studentA.user_id}/profile`)
			.set("Authorization", `Bearer ${token}`)
			.send({ fullName: "Hacked Name" });

		expect(res.status).toBe(403);

		// Confirm studentA's profile is unchanged
		const { rows } = await pool.query(`SELECT full_name FROM student_profiles WHERE user_id = $1`, [
			studentA.user_id,
		]);
		expect(rows[0].full_name).toBe("Test User"); // factory default
	});

	it("returns 400 when no valid fields are provided in the request body", async () => {
		const student = await createUser({ role: "student" });
		const loginRes = await loginAs(request, student);
		const token = loginRes.body.data.accessToken;

		const res = await request
			.put(`/api/v1/students/${student.user_id}/profile`)
			.set("Authorization", `Bearer ${token}`)
			.send({ unknownField: "ignored" });

		expect(res.status).toBe(400);
		expect(res.body.message).toMatch(/no valid fields/i);
	});

	it("returns 400 when yearOfStudy is outside the valid range (1–7)", async () => {
		const student = await createUser({ role: "student" });
		const loginRes = await loginAs(request, student);
		const token = loginRes.body.data.accessToken;

		const res = await request
			.put(`/api/v1/students/${student.user_id}/profile`)
			.set("Authorization", `Bearer ${token}`)
			.send({ yearOfStudy: 10 });

		expect(res.status).toBe(400);
		expect(res.body.errors.some((e) => e.field.includes("yearOfStudy"))).toBe(true);
	});

	it("returns 400 when gender is not one of the allowed enum values", async () => {
		const student = await createUser({ role: "student" });
		const loginRes = await loginAs(request, student);
		const token = loginRes.body.data.accessToken;

		const res = await request
			.put(`/api/v1/students/${student.user_id}/profile`)
			.set("Authorization", `Bearer ${token}`)
			.send({ gender: "nonbinary" });

		expect(res.status).toBe(400);
		expect(res.body.errors.some((e) => e.field.includes("gender"))).toBe(true);
	});

	it("performs partial updates — only the provided fields change", async () => {
		const student = await createUser({ role: "student" });
		const loginRes = await loginAs(request, student);
		const token = loginRes.body.data.accessToken;

		await request
			.put(`/api/v1/students/${student.user_id}/profile`)
			.set("Authorization", `Bearer ${token}`)
			.send({ course: "Mathematics" });

		// Update bio only — course must remain "Mathematics"
		await request
			.put(`/api/v1/students/${student.user_id}/profile`)
			.set("Authorization", `Bearer ${token}`)
			.send({ bio: "Loves numbers" });

		const { rows } = await pool.query(`SELECT course, bio FROM student_profiles WHERE user_id = $1`, [
			student.user_id,
		]);
		expect(rows[0].course).toBe("Mathematics");
		expect(rows[0].bio).toBe("Loves numbers");
	});

	it("returns 401 for an unauthenticated update request", async () => {
		const student = await createUser({ role: "student" });

		const res = await request.put(`/api/v1/students/${student.user_id}/profile`).send({ fullName: "Ghost Update" });

		expect(res.status).toBe(401);
	});
});
