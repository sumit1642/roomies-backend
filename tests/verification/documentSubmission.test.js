// tests/verification/documentSubmission.test.js
//
// Integration tests for POST /api/v1/pg-owners/:userId/documents
//
// This endpoint has two independent guards that need to be tested separately:
//   1. authorize('pg_owner') — checks req.user.roles at the middleware layer
//   2. Service ownership check — compares requestingUserId to targetUserId
//   3. Profile existence check — confirms a pg_owner_profiles row exists
//
// Both guards exist because they catch different failure modes at different
// layers. The middleware guard has zero DB cost; the service guard catches
// integrity anomalies the role check cannot see.

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

const validDocument = {
	documentType: "owner_id",
	documentUrl: "https://storage.example.com/doc.pdf",
};

// ─── Group 1: Happy path ──────────────────────────────────────────────────────

describe("POST /api/v1/pg-owners/:userId/documents — happy path", () => {
	it("creates a verification_requests row with status pending and returns 201", async () => {
		const owner = await createUser({ role: "pg_owner" });
		const loginRes = await loginAs(request, owner);
		const token = loginRes.body.data.accessToken;

		const res = await request
			.post(`/api/v1/pg-owners/${owner.user_id}/documents`)
			.set("Authorization", `Bearer ${token}`)
			.send(validDocument);

		expect(res.status).toBe(201);
		expect(res.body.status).toBe("success");
		expect(res.body.data.status).toBe("pending");
		expect(res.body.data.document_type).toBe(validDocument.documentType);
		expect(res.body.data.request_id).toBeTruthy();
	});

	it("persists the row in the database", async () => {
		const owner = await createUser({ role: "pg_owner" });
		const loginRes = await loginAs(request, owner);
		const token = loginRes.body.data.accessToken;

		const res = await request
			.post(`/api/v1/pg-owners/${owner.user_id}/documents`)
			.set("Authorization", `Bearer ${token}`)
			.send(validDocument);

		expect(res.status).toBe(201);

		const { rows } = await pool.query(
			`SELECT user_id, document_type, document_url, status
			 FROM verification_requests
			 WHERE request_id = $1`,
			[res.body.data.request_id],
		);

		expect(rows).toHaveLength(1);
		expect(rows[0].user_id).toBe(owner.user_id);
		expect(rows[0].status).toBe("pending");
		expect(rows[0].document_url).toBe(validDocument.documentUrl);
	});

	it("allows a pg_owner to submit multiple documents of different types", async () => {
		const owner = await createUser({ role: "pg_owner" });
		const loginRes = await loginAs(request, owner);
		const token = loginRes.body.data.accessToken;

		const types = ["owner_id", "property_document", "rental_agreement"];
		for (const documentType of types) {
			const res = await request
				.post(`/api/v1/pg-owners/${owner.user_id}/documents`)
				.set("Authorization", `Bearer ${token}`)
				.send({ documentType, documentUrl: `https://storage.example.com/${documentType}.pdf` });

			expect(res.status).toBe(201);
		}

		const { rows } = await pool.query(`SELECT COUNT(*) FROM verification_requests WHERE user_id = $1`, [
			owner.user_id,
		]);
		expect(Number(rows[0].count)).toBe(3);
	});
});

// ─── Group 2: Authorization guards ───────────────────────────────────────────

describe("POST /api/v1/pg-owners/:userId/documents — authorization", () => {
	it("returns 403 when a student attempts to submit a document", async () => {
		// authorize('pg_owner') catches this at the middleware layer —
		// the service never runs, zero DB cost.
		const student = await createUser({ role: "student" });
		const loginRes = await loginAs(request, student);
		const token = loginRes.body.data.accessToken;

		const res = await request
			.post(`/api/v1/pg-owners/${student.user_id}/documents`)
			.set("Authorization", `Bearer ${token}`)
			.send(validDocument);

		expect(res.status).toBe(403);
	});

	it("returns 403 when a pg_owner submits a document for a different pg_owner's userId", async () => {
		// This tests the service-layer ownership check. The role check passes
		// (both are pg_owners) but the userId mismatch is caught in the service.
		const ownerA = await createUser({ role: "pg_owner" });
		const ownerB = await createUser({ role: "pg_owner" });

		const loginRes = await loginAs(request, ownerB);
		const token = loginRes.body.data.accessToken;

		// ownerB tries to submit a document under ownerA's userId
		const res = await request
			.post(`/api/v1/pg-owners/${ownerA.user_id}/documents`)
			.set("Authorization", `Bearer ${token}`)
			.send(validDocument);

		expect(res.status).toBe(403);
	});

	it("returns 401 for an unauthenticated request", async () => {
		const owner = await createUser({ role: "pg_owner" });

		const res = await request.post(`/api/v1/pg-owners/${owner.user_id}/documents`).send(validDocument);

		expect(res.status).toBe(401);
	});
});

// ─── Group 3: Validation errors ───────────────────────────────────────────────

describe("POST /api/v1/pg-owners/:userId/documents — validation", () => {
	it("returns 400 when documentType is not one of the allowed enum values", async () => {
		const owner = await createUser({ role: "pg_owner" });
		const loginRes = await loginAs(request, owner);
		const token = loginRes.body.data.accessToken;

		const res = await request
			.post(`/api/v1/pg-owners/${owner.user_id}/documents`)
			.set("Authorization", `Bearer ${token}`)
			.send({ ...validDocument, documentType: "fake_document_type" });

		expect(res.status).toBe(400);
		expect(res.body.errors.some((e) => e.field.includes("documentType"))).toBe(true);
	});

	it("returns 400 when documentUrl is missing", async () => {
		const owner = await createUser({ role: "pg_owner" });
		const loginRes = await loginAs(request, owner);
		const token = loginRes.body.data.accessToken;

		const { documentUrl, ...rest } = validDocument;
		const res = await request
			.post(`/api/v1/pg-owners/${owner.user_id}/documents`)
			.set("Authorization", `Bearer ${token}`)
			.send(rest);

		expect(res.status).toBe(400);
		expect(res.body.errors.some((e) => e.field.includes("documentUrl"))).toBe(true);
	});

	it("returns 400 when documentUrl is an empty string", async () => {
		const owner = await createUser({ role: "pg_owner" });
		const loginRes = await loginAs(request, owner);
		const token = loginRes.body.data.accessToken;

		const res = await request
			.post(`/api/v1/pg-owners/${owner.user_id}/documents`)
			.set("Authorization", `Bearer ${token}`)
			.send({ ...validDocument, documentUrl: "" });

		expect(res.status).toBe(400);
	});

	it("returns 400 when userId param is not a valid UUID", async () => {
		const owner = await createUser({ role: "pg_owner" });
		const loginRes = await loginAs(request, owner);
		const token = loginRes.body.data.accessToken;

		const res = await request
			.post(`/api/v1/pg-owners/not-a-uuid/documents`)
			.set("Authorization", `Bearer ${token}`)
			.send(validDocument);

		expect(res.status).toBe(400);
	});
});
