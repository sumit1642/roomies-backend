// tests/suites/05-verification.test.js
//
// Covers: POST /verification/submit, GET /verification/queue (admin),
// PATCH /verification/:requestId/approve (admin),
// PATCH /verification/:requestId/reject (admin).
//
// This suite is deliberately thin — it only asserts the HTTP contract
// (status codes, role/auth gates, response shape). The real behavior behind
// these endpoints (the verification_event_outbox trigger, the
// drainOutbox -> email pipeline, pg_owner_profiles.verification_status
// transitions) is already covered end-to-end by 05-verification-email.test.js
// and at the branching-logic level by verification-event-unit.test.js —
// duplicating that here would only add flake risk without adding coverage.
//
// Note this route file has NO validate() middleware wrapping any of the four
// routes (unlike most other route files in this codebase) — request bodies
// are only checked inside the service layer, so malformed input doesn't
// necessarily produce a clean Zod-style 400. Each test below asserts the
// actual current contract rather than an assumed one.
//
// submitDocument uses req.user.userId for both requesting and target user —
// there's no :userId param on this route (unlike POST
// /pg-owners/:userId/documents, already covered in 04-pgOwners.test.js,
// which is a distinct route hitting the same service function). This suite
// exercises the /verification/submit alias specifically.

import request from "supertest";
import { app } from "../../src/app.js";
import { registerPgOwner, registerStudent } from "../setup/testAuth.js";
import { pool } from "../../src/db/client.js";

const uniqueEmail = (label) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@business.test`;

// Promotes a registered user to admin directly via SQL — there's no public
// admin-signup endpoint. Mirrors the pattern already established in
// 05-verification-email.test.js and 14-reports.test.js.
const makeAdmin = async (userId) => {
	await pool.query(`INSERT INTO user_roles (user_id, role_name) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`, [
		userId,
	]);
	await pool.query(`UPDATE users SET is_email_verified = TRUE WHERE user_id = $1`, [userId]);
};

const submitBody = (overrides = {}) => ({
	documentType: "owner_id",
	documentUrl: "https://example.com/doc.pdf",
	...overrides,
});

describe("POST /verification/submit", () => {
	test("a pg_owner submits a verification document", async () => {
		const { agent } = await registerPgOwner({ email: uniqueEmail("submit-ok") });

		const res = await agent.post("/api/v1/verification/submit").send(submitBody());

		expect(res.status).toBe(201);
		expect(res.body.data.status).toBe("pending");
		expect(res.body.data.document_type).toBe("owner_id");
		expect(res.body.data.request_id).toEqual(expect.any(String));
	});

	test("flips pg_owner_profiles.verification_status to pending", async () => {
		const { agent, user } = await registerPgOwner({ email: uniqueEmail("submit-flips-status") });

		await agent.post("/api/v1/verification/submit").send(submitBody());

		const { rows } = await pool.query(`SELECT verification_status FROM pg_owner_profiles WHERE user_id = $1`, [
			user.userId,
		]);
		expect(rows[0].verification_status).toBe("pending");
	});

	test("409 on a second submission while one is already pending", async () => {
		const { agent } = await registerPgOwner({ email: uniqueEmail("submit-dup") });

		const first = await agent.post("/api/v1/verification/submit").send(submitBody());
		expect(first.status).toBe(201);

		const second = await agent
			.post("/api/v1/verification/submit")
			.send(submitBody({ documentType: "trade_license", documentUrl: "https://example.com/doc2.pdf" }));

		expect(second.status).toBe(409);
	});

	test("a student cannot submit a verification document (role gate)", async () => {
		const { agent } = await registerStudent({ email: `submit-student-${Date.now()}@college.edu` });

		const res = await agent.post("/api/v1/verification/submit").send(submitBody());

		expect(res.status).toBe(403);
	});

	test("requires authentication", async () => {
		const res = await request(app).post("/api/v1/verification/submit").send(submitBody());

		expect(res.status).toBe(401);
	});
});

describe("GET /verification/queue — admin", () => {
	test("lists pending requests with owner context", async () => {
		const { agent: ownerAgent, user: owner } = await registerPgOwner({ email: uniqueEmail("queue-ok-owner") });
		await ownerAgent.post("/api/v1/verification/submit").send(submitBody());

		const { agent: adminAgent, user: admin } = await registerPgOwner({ email: uniqueEmail("queue-ok-admin") });
		await makeAdmin(admin.userId);

		const res = await adminAgent.get("/api/v1/verification/queue");

		expect(res.status).toBe(200);
		expect(res.body.data.items.length).toBeGreaterThanOrEqual(1);
		const item = res.body.data.items.find((i) => i.user_id === owner.userId);
		expect(item).toBeDefined();
		expect(item.business_name).toEqual(expect.any(String));
	});

	test("does not include an already-approved request", async () => {
		const { agent: ownerAgent } = await registerPgOwner({ email: uniqueEmail("queue-excl-owner") });
		const submitRes = await ownerAgent.post("/api/v1/verification/submit").send(submitBody());
		const requestId = submitRes.body.data.request_id;

		const { agent: adminAgent, user: admin } = await registerPgOwner({ email: uniqueEmail("queue-excl-admin") });
		await makeAdmin(admin.userId);

		await adminAgent.patch(`/api/v1/verification/${requestId}/approve`).send({});

		const res = await adminAgent.get("/api/v1/verification/queue");

		expect(res.status).toBe(200);
		expect(res.body.data.items.some((i) => i.request_id === requestId)).toBe(false);
	});

	test("403 for a non-admin authenticated user", async () => {
		const { agent } = await registerPgOwner({ email: uniqueEmail("queue-forbidden") });

		const res = await agent.get("/api/v1/verification/queue");

		expect(res.status).toBe(403);
	});

	test("403 for an admin whose email is not verified", async () => {
		const { agent, user } = await registerPgOwner({ email: uniqueEmail("queue-unverified-admin") });
		await pool.query(`INSERT INTO user_roles (user_id, role_name) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`, [
			user.userId,
		]);
		// Deliberately not calling makeAdmin's is_email_verified update.

		const res = await agent.get("/api/v1/verification/queue");

		expect(res.status).toBe(403);
	});

	test("requires authentication", async () => {
		const res = await request(app).get("/api/v1/verification/queue");
		expect(res.status).toBe(401);
	});

	test("supports cursor pagination", async () => {
		const { agent: adminAgent, user: admin } = await registerPgOwner({
			email: uniqueEmail("queue-paginate-admin"),
		});
		await makeAdmin(admin.userId);

		const submittedRequestIds = new Set();
		for (let i = 0; i < 3; i++) {
			const { agent: ownerAgent } = await registerPgOwner({ email: uniqueEmail(`queue-paginate-owner-${i}`) });
			const submitRes = await ownerAgent.post("/api/v1/verification/submit").send(submitBody());
			submittedRequestIds.add(submitRes.body.data.request_id);
		}

		const firstPage = await adminAgent.get("/api/v1/verification/queue").query({ limit: 2 });
		expect(firstPage.status).toBe(200);
		expect(firstPage.body.data.items).toHaveLength(2);
		expect(firstPage.body.data.nextCursor).not.toBeNull();

		const secondPage = await adminAgent.get("/api/v1/verification/queue").query({
			limit: 2,
			cursorTime: firstPage.body.data.nextCursor.cursorTime,
			cursorId: firstPage.body.data.nextCursor.cursorId,
		});
		expect(secondPage.status).toBe(200);

		const firstIds = firstPage.body.data.items.map((i) => i.request_id);
		const secondIds = secondPage.body.data.items.map((i) => i.request_id);
		expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
	});
});

describe("PATCH /verification/:requestId/approve — admin", () => {
	test("approves a pending request", async () => {
		const { agent: ownerAgent } = await registerPgOwner({ email: uniqueEmail("approve-ok-owner") });
		const submitRes = await ownerAgent.post("/api/v1/verification/submit").send(submitBody());
		const requestId = submitRes.body.data.request_id;

		const { agent: adminAgent, user: admin } = await registerPgOwner({ email: uniqueEmail("approve-ok-admin") });
		await makeAdmin(admin.userId);

		const res = await adminAgent.patch(`/api/v1/verification/${requestId}/approve`).send({});

		expect(res.status).toBe(200);
		expect(res.body.data.status).toBe("verified");
	});

	test("409 when approving a request that is already resolved", async () => {
		const { agent: ownerAgent } = await registerPgOwner({ email: uniqueEmail("approve-double-owner") });
		const submitRes = await ownerAgent.post("/api/v1/verification/submit").send(submitBody());
		const requestId = submitRes.body.data.request_id;

		const { agent: adminAgent, user: admin } = await registerPgOwner({
			email: uniqueEmail("approve-double-admin"),
		});
		await makeAdmin(admin.userId);

		const first = await adminAgent.patch(`/api/v1/verification/${requestId}/approve`).send({});
		expect(first.status).toBe(200);

		const second = await adminAgent.patch(`/api/v1/verification/${requestId}/approve`).send({});

		expect(second.status).toBe(409);
	});

	test("409 for a non-existent request", async () => {
		const { agent: adminAgent, user: admin } = await registerPgOwner({ email: uniqueEmail("approve-404-admin") });
		await makeAdmin(admin.userId);

		const res = await adminAgent
			.patch(`/api/v1/verification/00000000-0000-0000-0000-000000000000/approve`)
			.send({});

		expect(res.status).toBe(409);
	});

	test("403 for a non-admin authenticated user", async () => {
		const { agent: ownerAgent } = await registerPgOwner({ email: uniqueEmail("approve-forbidden-owner") });
		const submitRes = await ownerAgent.post("/api/v1/verification/submit").send(submitBody());
		const requestId = submitRes.body.data.request_id;

		const { agent: nonAdminAgent } = await registerPgOwner({ email: uniqueEmail("approve-forbidden-nonadmin") });

		const res = await nonAdminAgent.patch(`/api/v1/verification/${requestId}/approve`).send({});

		expect(res.status).toBe(403);
	});

	test("requires authentication", async () => {
		const res = await request(app)
			.patch(`/api/v1/verification/00000000-0000-0000-0000-000000000000/approve`)
			.send({});

		expect(res.status).toBe(401);
	});
});

describe("PATCH /verification/:requestId/reject — admin", () => {
	test("rejects a pending request with a reason", async () => {
		const { agent: ownerAgent } = await registerPgOwner({ email: uniqueEmail("reject-ok-owner") });
		const submitRes = await ownerAgent.post("/api/v1/verification/submit").send(submitBody());
		const requestId = submitRes.body.data.request_id;

		const { agent: adminAgent, user: admin } = await registerPgOwner({ email: uniqueEmail("reject-ok-admin") });
		await makeAdmin(admin.userId);

		const res = await adminAgent
			.patch(`/api/v1/verification/${requestId}/reject`)
			.send({ rejectionReason: "Document was illegible" });

		expect(res.status).toBe(200);
		expect(res.body.data.status).toBe("rejected");
	});

	test("persists the rejection reason on both verification_requests and pg_owner_profiles", async () => {
		const { agent: ownerAgent, user: owner } = await registerPgOwner({
			email: uniqueEmail("reject-persist-owner"),
		});
		const submitRes = await ownerAgent.post("/api/v1/verification/submit").send(submitBody());
		const requestId = submitRes.body.data.request_id;

		const { agent: adminAgent, user: admin } = await registerPgOwner({
			email: uniqueEmail("reject-persist-admin"),
		});
		await makeAdmin(admin.userId);

		await adminAgent.patch(`/api/v1/verification/${requestId}/reject`).send({ rejectionReason: "Blurry photo" });

		const { rows: requestRows } = await pool.query(
			`SELECT status, rejection_reason FROM verification_requests WHERE request_id = $1`,
			[requestId],
		);
		expect(requestRows[0].status).toBe("rejected");
		expect(requestRows[0].rejection_reason).toBe("Blurry photo");

		const { rows: profileRows } = await pool.query(
			`SELECT verification_status, rejection_reason FROM pg_owner_profiles WHERE user_id = $1`,
			[owner.userId],
		);
		expect(profileRows[0].verification_status).toBe("rejected");
		expect(profileRows[0].rejection_reason).toBe("Blurry photo");
	});

	test("409 when rejecting a request that is already resolved", async () => {
		const { agent: ownerAgent } = await registerPgOwner({ email: uniqueEmail("reject-double-owner") });
		const submitRes = await ownerAgent.post("/api/v1/verification/submit").send(submitBody());
		const requestId = submitRes.body.data.request_id;

		const { agent: adminAgent, user: admin } = await registerPgOwner({
			email: uniqueEmail("reject-double-admin"),
		});
		await makeAdmin(admin.userId);

		const first = await adminAgent
			.patch(`/api/v1/verification/${requestId}/reject`)
			.send({ rejectionReason: "First rejection" });
		expect(first.status).toBe(200);

		const second = await adminAgent
			.patch(`/api/v1/verification/${requestId}/reject`)
			.send({ rejectionReason: "Second rejection" });

		expect(second.status).toBe(409);
	});

	test("403 for a non-admin authenticated user", async () => {
		const { agent: ownerAgent } = await registerPgOwner({ email: uniqueEmail("reject-forbidden-owner") });
		const submitRes = await ownerAgent.post("/api/v1/verification/submit").send(submitBody());
		const requestId = submitRes.body.data.request_id;

		const { agent: nonAdminAgent } = await registerPgOwner({ email: uniqueEmail("reject-forbidden-nonadmin") });

		const res = await nonAdminAgent
			.patch(`/api/v1/verification/${requestId}/reject`)
			.send({ rejectionReason: "x" });

		expect(res.status).toBe(403);
	});

	test("requires authentication", async () => {
		const res = await request(app)
			.patch(`/api/v1/verification/00000000-0000-0000-0000-000000000000/reject`)
			.send({ rejectionReason: "x" });

		expect(res.status).toBe(401);
	});
});
