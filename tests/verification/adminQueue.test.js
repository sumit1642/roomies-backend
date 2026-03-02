// tests/verification/adminQueue.test.js
//
// Integration tests for GET /api/v1/admin/verification-queue
//
// This endpoint is protected at the router level by both authenticate and
// authorize('admin') — it is architecturally impossible to reach it without
// both passing. Tests cover: access control, response shape, and the keyset
// pagination system.
//
// Pagination note: keyset pagination is more complex to test than offset
// pagination because the cursor is opaque — you have to actually consume one
// page to get the cursor for the next. The tests below do exactly that,
// which also means they exercise the real pagination code path end-to-end.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "@jest/globals";
import supertest from "supertest";
import { createClient } from "redis";
import { app } from "../../src/app.js";
import { config } from "../../src/config/env.js";
import { pool, truncateAll, createUser, loginAs, createVerificationRequest } from "../setup/dbHelpers.js";

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Creates an admin user and returns a Bearer token for them.
// Admins have no profile table — only users + user_roles rows needed.
const getAdminToken = async () => {
	const admin = await createUser({ role: "admin" });
	const loginRes = await loginAs(request, admin);
	return loginRes.body.data.accessToken;
};

// ─── Group 1: Access control ──────────────────────────────────────────────────

describe("GET /api/v1/admin/verification-queue — access control", () => {
	it("returns 401 for an unauthenticated request", async () => {
		const res = await request.get("/api/v1/admin/verification-queue");
		expect(res.status).toBe(401);
	});

	it("returns 403 for an authenticated student", async () => {
		const student = await createUser({ role: "student" });
		const loginRes = await loginAs(request, student);
		const token = loginRes.body.data.accessToken;

		const res = await request.get("/api/v1/admin/verification-queue").set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(403);
	});

	it("returns 403 for an authenticated pg_owner", async () => {
		const owner = await createUser({ role: "pg_owner" });
		const loginRes = await loginAs(request, owner);
		const token = loginRes.body.data.accessToken;

		const res = await request.get("/api/v1/admin/verification-queue").set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(403);
	});

	it("returns 200 for an authenticated admin", async () => {
		const token = await getAdminToken();

		const res = await request.get("/api/v1/admin/verification-queue").set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(200);
	});
});

// ─── Group 2: Response shape ──────────────────────────────────────────────────

describe("GET /api/v1/admin/verification-queue — response shape", () => {
	it("returns items array and nextCursor when the queue is empty", async () => {
		const token = await getAdminToken();

		const res = await request.get("/api/v1/admin/verification-queue").set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(200);
		expect(res.body.data.items).toEqual([]);
		expect(res.body.data.nextCursor).toBeNull();
	});

	it("returns the expected fields on each queue item", async () => {
		const owner = await createUser({ role: "pg_owner" });
		await createVerificationRequest(owner.user_id);

		const token = await getAdminToken();

		const res = await request.get("/api/v1/admin/verification-queue").set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(200);
		expect(res.body.data.items).toHaveLength(1);

		const item = res.body.data.items[0];

		// Fields needed for the admin to make a decision
		expect(item).toHaveProperty("request_id");
		expect(item).toHaveProperty("document_type");
		expect(item).toHaveProperty("document_url");
		expect(item).toHaveProperty("submitted_at");
		expect(item).toHaveProperty("business_name");
		expect(item).toHaveProperty("owner_full_name");
		expect(item).toHaveProperty("email");

		// user_id is required so the admin UI can deep-link to the owner's profile
		// (/pg-owners/:userId/profile) directly from the queue row
		expect(item).toHaveProperty("user_id");
		expect(item.user_id).toBe(owner.user_id);
	});

	it("returns only pending requests — not approved or rejected ones", async () => {
		const owner = await createUser({ role: "pg_owner" });

		// Create one pending and one pre-approved (as if already actioned)
		await createVerificationRequest(owner.user_id, { status: "pending" });
		await createVerificationRequest(owner.user_id, { status: "verified" });
		await createVerificationRequest(owner.user_id, { status: "rejected" });

		const token = await getAdminToken();

		const res = await request.get("/api/v1/admin/verification-queue").set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(200);
		// Only the pending one should appear
		expect(res.body.data.items).toHaveLength(1);
		expect(res.body.data.items[0].user_id).toBe(owner.user_id);
	});

	it("returns items oldest-first to prevent starvation of old submissions", async () => {
		// Create requests with a deliberate delay between them so submitted_at differs
		const ownerA = await createUser({ role: "pg_owner" });
		await createVerificationRequest(ownerA.user_id);

		// Small delay to ensure different submitted_at timestamps
		await new Promise((r) => setTimeout(r, 20));

		const ownerB = await createUser({ role: "pg_owner" });
		await createVerificationRequest(ownerB.user_id);

		const token = await getAdminToken();

		const res = await request.get("/api/v1/admin/verification-queue").set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(200);
		expect(res.body.data.items).toHaveLength(2);

		// ownerA submitted first — must appear first in the response
		expect(res.body.data.items[0].user_id).toBe(ownerA.user_id);
		expect(res.body.data.items[1].user_id).toBe(ownerB.user_id);
	});
});

// ─── Group 3: Pagination ──────────────────────────────────────────────────────

describe("GET /api/v1/admin/verification-queue — keyset pagination", () => {
	// Seed 5 owners with one pending request each, in order.
	const seedOwners = async (count) => {
		const owners = [];
		for (let i = 0; i < count; i++) {
			const owner = await createUser({ role: "pg_owner" });
			await createVerificationRequest(owner.user_id);
			// Small delay to create distinct submitted_at timestamps for stable ordering
			await new Promise((r) => setTimeout(r, 15));
			owners.push(owner);
		}
		return owners;
	};

	it("returns limit items and a nextCursor when there are more pages", async () => {
		await seedOwners(5);
		const token = await getAdminToken();

		const res = await request
			.get("/api/v1/admin/verification-queue?limit=2")
			.set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(200);
		expect(res.body.data.items).toHaveLength(2);
		expect(res.body.data.nextCursor).not.toBeNull();
		expect(res.body.data.nextCursor.cursorTime).toBeDefined();
		expect(res.body.data.nextCursor.cursorId).toBeDefined();
	});

	it("returns null nextCursor on the last page", async () => {
		await seedOwners(3);
		const token = await getAdminToken();

		const res = await request
			.get("/api/v1/admin/verification-queue?limit=10")
			.set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(200);
		expect(res.body.data.items).toHaveLength(3);
		expect(res.body.data.nextCursor).toBeNull();
	});

	it("uses the cursor to return the correct next page", async () => {
		const owners = await seedOwners(5);
		const token = await getAdminToken();

		// Fetch first page of 2
		const page1 = await request
			.get("/api/v1/admin/verification-queue?limit=2")
			.set("Authorization", `Bearer ${token}`);

		expect(page1.body.data.items).toHaveLength(2);
		const { cursorTime, cursorId } = page1.body.data.nextCursor;

		// Fetch second page using the cursor
		const page2 = await request
			.get(
				`/api/v1/admin/verification-queue?limit=2&cursorTime=${encodeURIComponent(cursorTime)}&cursorId=${cursorId}`,
			)
			.set("Authorization", `Bearer ${token}`);

		expect(page2.body.data.items).toHaveLength(2);

		// No overlap between pages — all 4 items must be distinct
		const page1Ids = page1.body.data.items.map((i) => i.request_id);
		const page2Ids = page2.body.data.items.map((i) => i.request_id);
		const overlap = page1Ids.filter((id) => page2Ids.includes(id));
		expect(overlap).toHaveLength(0);

		// Page 2 items are the 3rd and 4th owners (0-indexed)
		expect(page2.body.data.items[0].user_id).toBe(owners[2].user_id);
		expect(page2.body.data.items[1].user_id).toBe(owners[3].user_id);
	});

	it("can paginate through all items with no duplicates or gaps", async () => {
		const owners = await seedOwners(5);
		const token = await getAdminToken();

		const allItems = [];
		let cursor = null;

		// Consume all pages with limit=2
		do {
			const url =
				cursor ?
					`/api/v1/admin/verification-queue?limit=2&cursorTime=${encodeURIComponent(cursor.cursorTime)}&cursorId=${cursor.cursorId}`
				:	"/api/v1/admin/verification-queue?limit=2";

			const res = await request.get(url).set("Authorization", `Bearer ${token}`);
			expect(res.status).toBe(200);

			allItems.push(...res.body.data.items);
			cursor = res.body.data.nextCursor;
		} while (cursor !== null);

		// All 5 items retrieved, no duplicates
		expect(allItems).toHaveLength(5);
		const uniqueIds = new Set(allItems.map((i) => i.request_id));
		expect(uniqueIds.size).toBe(5);
	});
});

// ─── Group 4: Cursor validation ───────────────────────────────────────────────

describe("GET /api/v1/admin/verification-queue — cursor validation", () => {
	it("returns 400 when cursorTime is provided without cursorId", async () => {
		const token = await getAdminToken();

		const res = await request
			.get("/api/v1/admin/verification-queue?cursorTime=2024-01-01T00:00:00.000Z")
			.set("Authorization", `Bearer ${token}`);

		// The Zod refine() rule requires both cursor fields or neither
		expect(res.status).toBe(400);
	});

	it("returns 400 when cursorId is provided without cursorTime", async () => {
		const token = await getAdminToken();

		const res = await request
			.get("/api/v1/admin/verification-queue?cursorId=00000000-0000-0000-0000-000000000000")
			.set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(400);
	});

	it("returns 400 when cursorId is not a valid UUID", async () => {
		const token = await getAdminToken();

		const res = await request
			.get("/api/v1/admin/verification-queue?cursorTime=2024-01-01T00:00:00.000Z&cursorId=not-a-uuid")
			.set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(400);
	});

	it("returns 400 when limit exceeds the maximum of 100", async () => {
		const token = await getAdminToken();

		const res = await request
			.get("/api/v1/admin/verification-queue?limit=200")
			.set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(400);
	});
});
