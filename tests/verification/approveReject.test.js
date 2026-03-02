// tests/verification/approveReject.test.js
//
// Integration tests for the verification resolution endpoints:
//   POST /api/v1/admin/verification-queue/:requestId/approve
//   POST /api/v1/admin/verification-queue/:requestId/reject
//
// These are the most transactionally significant tests in Phase 1. Each
// resolution modifies TWO tables atomically — verification_requests AND
// pg_owner_profiles. A failure in either write must roll back both.
//
// The 409-on-double-action test is the practical proxy for the concurrency
// guard: the AND status='pending' clause in the UPDATE means the second
// actor always gets rowCount=0 regardless of timing.

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

const getAdminToken = async () => {
	const admin = await createUser({ role: "admin" });
	const loginRes = await loginAs(request, admin);
	return { token: loginRes.body.data.accessToken, admin };
};

// Creates a pg_owner and a pending verification request, returns both.
const setupPendingRequest = async () => {
	const owner = await createUser({ role: "pg_owner" });
	const verificationRequest = await createVerificationRequest(owner.user_id);
	return { owner, verificationRequest };
};

// ─── Group 1: Approve ─────────────────────────────────────────────────────────

describe("POST /api/v1/admin/verification-queue/:requestId/approve", () => {
	it("returns 200 and updates both tables atomically on success", async () => {
		const { owner, verificationRequest } = await setupPendingRequest();
		const { token, admin } = await getAdminToken();

		const res = await request
			.post(`/api/v1/admin/verification-queue/${verificationRequest.request_id}/approve`)
			.set("Authorization", `Bearer ${token}`)
			.send({ adminNotes: "Documents look good." });

		expect(res.status).toBe(200);
		expect(res.body.data.status).toBe("verified");

		// verification_requests row must be updated
		const { rows: reqRows } = await pool.query(
			`SELECT status, reviewed_by, admin_notes, reviewed_at
			 FROM verification_requests WHERE request_id = $1`,
			[verificationRequest.request_id],
		);
		expect(reqRows[0].status).toBe("verified");
		expect(reqRows[0].reviewed_by).toBe(admin.user_id);
		expect(reqRows[0].admin_notes).toBe("Documents look good.");
		expect(reqRows[0].reviewed_at).not.toBeNull();

		// pg_owner_profiles row must also be updated in the same transaction
		const { rows: profileRows } = await pool.query(
			`SELECT verification_status, verified_at, verified_by
			 FROM pg_owner_profiles WHERE user_id = $1`,
			[owner.user_id],
		);
		expect(profileRows[0].verification_status).toBe("verified");
		expect(profileRows[0].verified_by).toBe(admin.user_id);
		expect(profileRows[0].verified_at).not.toBeNull();
	});

	it("returns 409 when attempting to approve an already-approved request", async () => {
		// This is the concurrency guard in action. The AND status='pending' clause
		// in the UPDATE means a second actor gets rowCount=0 and sees a 409.
		const { verificationRequest } = await setupPendingRequest();
		const { token } = await getAdminToken();

		// First approval succeeds
		const first = await request
			.post(`/api/v1/admin/verification-queue/${verificationRequest.request_id}/approve`)
			.set("Authorization", `Bearer ${token}`);
		expect(first.status).toBe(200);

		// Second approval on the same (now non-pending) request must fail
		const second = await request
			.post(`/api/v1/admin/verification-queue/${verificationRequest.request_id}/approve`)
			.set("Authorization", `Bearer ${token}`);
		expect(second.status).toBe(409);
	});

	it("returns 409 when the request_id does not exist", async () => {
		const { token } = await getAdminToken();

		const res = await request
			.post(`/api/v1/admin/verification-queue/00000000-0000-0000-0000-000000000000/approve`)
			.set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(409);
	});

	it("works when adminNotes is omitted (it is optional)", async () => {
		const { verificationRequest } = await setupPendingRequest();
		const { token } = await getAdminToken();

		const res = await request
			.post(`/api/v1/admin/verification-queue/${verificationRequest.request_id}/approve`)
			.set("Authorization", `Bearer ${token}`)
			.send({}); // no adminNotes

		expect(res.status).toBe(200);
	});

	it("returns 403 when called by a non-admin user", async () => {
		const { verificationRequest } = await setupPendingRequest();
		const student = await createUser({ role: "student" });
		const loginRes = await loginAs(request, student);
		const token = loginRes.body.data.accessToken;

		const res = await request
			.post(`/api/v1/admin/verification-queue/${verificationRequest.request_id}/approve`)
			.set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(403);
	});

	it("returns 401 for an unauthenticated request", async () => {
		const { verificationRequest } = await setupPendingRequest();

		const res = await request.post(`/api/v1/admin/verification-queue/${verificationRequest.request_id}/approve`);

		expect(res.status).toBe(401);
	});

	it("returns 400 when requestId param is not a valid UUID", async () => {
		const { token } = await getAdminToken();

		const res = await request
			.post(`/api/v1/admin/verification-queue/not-a-uuid/approve`)
			.set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(400);
	});
});

// ─── Group 2: Reject ──────────────────────────────────────────────────────────

describe("POST /api/v1/admin/verification-queue/:requestId/reject", () => {
	it("returns 200 and writes rejectionReason to the profile row", async () => {
		const { owner, verificationRequest } = await setupPendingRequest();
		const { token } = await getAdminToken();

		const rejectionReason = "The provided document is expired. Please resubmit with a valid ID.";

		const res = await request
			.post(`/api/v1/admin/verification-queue/${verificationRequest.request_id}/reject`)
			.set("Authorization", `Bearer ${token}`)
			.send({ rejectionReason });

		expect(res.status).toBe(200);
		expect(res.body.data.status).toBe("rejected");

		// Verify rejection_reason is written to the profile — this is what
		// the PG owner sees when they check their verification status.
		const { rows: profileRows } = await pool.query(
			`SELECT verification_status, rejection_reason
			 FROM pg_owner_profiles WHERE user_id = $1`,
			[owner.user_id],
		);
		expect(profileRows[0].verification_status).toBe("rejected");
		expect(profileRows[0].rejection_reason).toBe(rejectionReason);

		// verification_requests row must also be updated
		const { rows: reqRows } = await pool.query(`SELECT status FROM verification_requests WHERE request_id = $1`, [
			verificationRequest.request_id,
		]);
		expect(reqRows[0].status).toBe("rejected");
	});

	it("returns 400 when rejectionReason is missing (it is required for rejection)", async () => {
		const { verificationRequest } = await setupPendingRequest();
		const { token } = await getAdminToken();

		// rejectionReason is mandatory on rejection — a rejection without explanation
		// gives the PG owner nothing actionable to fix.
		const res = await request
			.post(`/api/v1/admin/verification-queue/${verificationRequest.request_id}/reject`)
			.set("Authorization", `Bearer ${token}`)
			.send({}); // no rejectionReason

		expect(res.status).toBe(400);
		expect(res.body.errors.some((e) => e.field.includes("rejectionReason"))).toBe(true);
	});

	it("returns 400 when rejectionReason is an empty string", async () => {
		const { verificationRequest } = await setupPendingRequest();
		const { token } = await getAdminToken();

		const res = await request
			.post(`/api/v1/admin/verification-queue/${verificationRequest.request_id}/reject`)
			.set("Authorization", `Bearer ${token}`)
			.send({ rejectionReason: "" });

		expect(res.status).toBe(400);
	});

	it("returns 409 when attempting to reject an already-rejected request", async () => {
		const { verificationRequest } = await setupPendingRequest();
		const { token } = await getAdminToken();

		const first = await request
			.post(`/api/v1/admin/verification-queue/${verificationRequest.request_id}/reject`)
			.set("Authorization", `Bearer ${token}`)
			.send({ rejectionReason: "Initial rejection reason." });
		expect(first.status).toBe(200);

		const second = await request
			.post(`/api/v1/admin/verification-queue/${verificationRequest.request_id}/reject`)
			.set("Authorization", `Bearer ${token}`)
			.send({ rejectionReason: "Trying to reject again." });
		expect(second.status).toBe(409);
	});

	it("returns 409 when attempting to reject an already-approved request", async () => {
		// Cross-action: approve then reject. The AND status='pending' guard on
		// the rejection UPDATE means this correctly returns 409.
		const { verificationRequest } = await setupPendingRequest();
		const { token } = await getAdminToken();

		await request
			.post(`/api/v1/admin/verification-queue/${verificationRequest.request_id}/approve`)
			.set("Authorization", `Bearer ${token}`);

		const res = await request
			.post(`/api/v1/admin/verification-queue/${verificationRequest.request_id}/reject`)
			.set("Authorization", `Bearer ${token}`)
			.send({ rejectionReason: "Trying to reject after approval." });

		expect(res.status).toBe(409);
	});

	it("returns 403 when called by a non-admin user", async () => {
		const { verificationRequest } = await setupPendingRequest();
		const student = await createUser({ role: "student" });
		const loginRes = await loginAs(request, student);
		const token = loginRes.body.data.accessToken;

		const res = await request
			.post(`/api/v1/admin/verification-queue/${verificationRequest.request_id}/reject`)
			.set("Authorization", `Bearer ${token}`)
			.send({ rejectionReason: "A student should not be here." });

		expect(res.status).toBe(403);
	});
});
