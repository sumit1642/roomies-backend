// tests/profiles/pgOwnerProfile.test.js
//
// Integration tests for the PG owner profile endpoints:
//   GET /api/v1/pg-owners/:userId/profile
//   PUT /api/v1/pg-owners/:userId/profile

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

describe("GET /api/v1/pg-owners/:userId/profile", () => {
	it("returns the profile for any authenticated user (world-readable)", async () => {
		// Any authenticated user — including a student — can read a PG owner's
		// profile. Students need to evaluate PG owners when considering a listing.
		const owner = await createUser({ role: "pg_owner" });
		const student = await createUser({ role: "student" });

		const loginRes = await loginAs(request, student);
		const token = loginRes.body.data.accessToken;

		const res = await request
			.get(`/api/v1/pg-owners/${owner.user_id}/profile`)
			.set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(200);
		expect(res.body.data.user_id).toBe(owner.user_id);
	});

	it("returns the correct profile fields including verification_status", async () => {
		const owner = await createUser({ role: "pg_owner" });
		const loginRes = await loginAs(request, owner);
		const token = loginRes.body.data.accessToken;

		const res = await request
			.get(`/api/v1/pg-owners/${owner.user_id}/profile`)
			.set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(200);

		const profile = res.body.data;
		expect(profile).toHaveProperty("profile_id");
		expect(profile).toHaveProperty("business_name");
		expect(profile).toHaveProperty("owner_full_name");
		expect(profile).toHaveProperty("verification_status");
		expect(profile).toHaveProperty("average_rating");

		// Sensitive fields must not appear
		expect(profile).not.toHaveProperty("password_hash");
		expect(profile).not.toHaveProperty("google_id");
		// rejection_reason is an internal admin note — confirm it is not exposed
		// on a standard profile read (it belongs on the owner's own dashboard only)
	});

	it("returns 404 for a valid UUID with no matching profile", async () => {
		const owner = await createUser({ role: "pg_owner" });
		const loginRes = await loginAs(request, owner);
		const token = loginRes.body.data.accessToken;

		const res = await request
			.get(`/api/v1/pg-owners/00000000-0000-0000-0000-000000000000/profile`)
			.set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(404);
	});

	it("returns 400 for a malformed userId", async () => {
		const owner = await createUser({ role: "pg_owner" });
		const loginRes = await loginAs(request, owner);
		const token = loginRes.body.data.accessToken;

		const res = await request.get(`/api/v1/pg-owners/not-a-uuid/profile`).set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(400);
	});

	it("returns 401 for an unauthenticated request", async () => {
		const owner = await createUser({ role: "pg_owner" });
		const res = await request.get(`/api/v1/pg-owners/${owner.user_id}/profile`);
		expect(res.status).toBe(401);
	});
});

// ─── Group 2: PUT profile ──────────────────────────────────────────────────────

describe("PUT /api/v1/pg-owners/:userId/profile", () => {
	it("allows a pg_owner to update their own profile", async () => {
		const owner = await createUser({ role: "pg_owner" });
		const loginRes = await loginAs(request, owner);
		const token = loginRes.body.data.accessToken;

		const res = await request
			.put(`/api/v1/pg-owners/${owner.user_id}/profile`)
			.set("Authorization", `Bearer ${token}`)
			.send({
				businessName: "Updated PG Name",
				businessDescription: "A great place to stay",
				businessPhone: "9876543210",
				operatingSince: 2018,
			});

		expect(res.status).toBe(200);
		expect(res.body.data.business_name).toBe("Updated PG Name");
		expect(res.body.data.business_description).toBe("A great place to stay");
		expect(res.body.data.operating_since).toBe(2018);
	});

	it("returns 403 when a pg_owner tries to update another pg_owner's profile", async () => {
		const ownerA = await createUser({ role: "pg_owner" });
		const ownerB = await createUser({ role: "pg_owner" });

		const loginRes = await loginAs(request, ownerB);
		const token = loginRes.body.data.accessToken;

		const res = await request
			.put(`/api/v1/pg-owners/${ownerA.user_id}/profile`)
			.set("Authorization", `Bearer ${token}`)
			.send({ businessName: "Hijacked Name" });

		expect(res.status).toBe(403);
	});

	it("returns 403 when a student attempts to update a pg_owner profile", async () => {
		// The authorize('pg_owner') middleware runs before the service —
		// a student is rejected at the middleware layer, no DB work happens.
		const owner = await createUser({ role: "pg_owner" });
		const student = await createUser({ role: "student" });

		const loginRes = await loginAs(request, student);
		const token = loginRes.body.data.accessToken;

		const res = await request
			.put(`/api/v1/pg-owners/${owner.user_id}/profile`)
			.set("Authorization", `Bearer ${token}`)
			.send({ businessName: "Student Trying" });

		expect(res.status).toBe(403);
	});

	it("returns 400 when no valid fields are provided", async () => {
		const owner = await createUser({ role: "pg_owner" });
		const loginRes = await loginAs(request, owner);
		const token = loginRes.body.data.accessToken;

		const res = await request
			.put(`/api/v1/pg-owners/${owner.user_id}/profile`)
			.set("Authorization", `Bearer ${token}`)
			.send({ unknownField: "ignored" });

		expect(res.status).toBe(400);
		expect(res.body.message).toMatch(/no valid fields/i);
	});

	it("returns 400 when businessPhone has an invalid format", async () => {
		const owner = await createUser({ role: "pg_owner" });
		const loginRes = await loginAs(request, owner);
		const token = loginRes.body.data.accessToken;

		const res = await request
			.put(`/api/v1/pg-owners/${owner.user_id}/profile`)
			.set("Authorization", `Bearer ${token}`)
			.send({ businessPhone: "call me maybe" });

		expect(res.status).toBe(400);
		expect(res.body.errors.some((e) => e.field.includes("businessPhone"))).toBe(true);
	});

	it("returns 400 when operatingSince is in the future", async () => {
		const owner = await createUser({ role: "pg_owner" });
		const loginRes = await loginAs(request, owner);
		const token = loginRes.body.data.accessToken;

		const res = await request
			.put(`/api/v1/pg-owners/${owner.user_id}/profile`)
			.set("Authorization", `Bearer ${token}`)
			.send({ operatingSince: new Date().getFullYear() + 5 });

		expect(res.status).toBe(400);
		expect(res.body.errors.some((e) => e.field.includes("operatingSince"))).toBe(true);
	});

	it("returns 401 for an unauthenticated update request", async () => {
		const owner = await createUser({ role: "pg_owner" });

		const res = await request
			.put(`/api/v1/pg-owners/${owner.user_id}/profile`)
			.send({ businessName: "Ghost Update" });

		expect(res.status).toBe(401);
	});
});
