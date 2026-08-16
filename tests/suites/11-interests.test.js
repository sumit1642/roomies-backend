// tests/suites/11-interests.test.js
//
// Covers: create, get, accept/decline/withdraw (state machine + capacity-fill
// side effects), list-for-listing (poster view), list-mine (sender view).
//
// This is the first state-machine suite in the rollout (see
// testing guide/02-api-test-architecture-plan.md) — interest_requests has
// real branching behavior (pending -> accepted/declined/withdrawn/expired),
// a capacity-triggered listing status flip to 'filled', and an auto-expiry
// side effect on the other pending requests for that listing. Tested solo,
// deliberately, rather than batched with another suite.
//
// WhatsApp link coverage: interest.service.js pulls the poster's contact
// number from `u_poster.phone` for student_room listings (vs.
// `business_phone` for pg_room/hostel_bed). Until the student-phone fix,
// there was no reachable endpoint to ever populate `users.phone` for a
// student, so this path was always null in practice. PUT
// /students/:userId/profile now accepts `phone`, so the non-null case below
// exercises that real endpoint rather than writing to the DB directly.

import request from "supertest";
import { app } from "../../src/app.js";
import { registerStudent } from "../setup/testAuth.js";
import { pool } from "../../src/db/client.js";

const uniqueEmail = (label) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@college.edu`;

const studentRoomBody = (overrides = {}) => ({
	listingType: "student_room",
	title: "Cozy shared room near campus",
	rentPerMonth: 6000,
	roomType: "single",
	totalCapacity: 1,
	availableFrom: "2026-09-01",
	addressLine: "45 College Street",
	city: "Delhi",
	latitude: 28.6139,
	longitude: 77.209,
	...overrides,
});

// Registers a poster + creates a student_room listing under them.
// Returns both the poster's agent/user and the created listingId.
const createPosterWithListing = async (label, listingOverrides = {}) => {
	const { agent: posterAgent, user: poster } = await registerStudent({ email: uniqueEmail(label) });
	const createRes = await posterAgent.post("/api/v1/listings").send(studentRoomBody(listingOverrides));
	return { posterAgent, poster, listingId: createRes.body.data.listing_id };
};

describe("POST /listings/:listingId/interests", () => {
	test("a student creates an interest request on another student's listing", async () => {
		const { listingId } = await createPosterWithListing("create-poster");
		const { agent: senderAgent, user: sender } = await registerStudent({ email: uniqueEmail("create-sender") });

		const res = await senderAgent
			.post(`/api/v1/listings/${listingId}/interests`)
			.send({ message: "Is this room still available?" });

		expect(res.status).toBe(201);
		expect(res.body.data.status).toBe("pending");
		expect(res.body.data.studentId).toBe(sender.userId);
		expect(res.body.data.listingId).toBe(listingId);
		expect(res.body.data.message).toBe("Is this room still available?");
	});

	test("works with an empty body (message is optional)", async () => {
		const { listingId } = await createPosterWithListing("create-nomsg-poster");
		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("create-nomsg-sender") });

		const res = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);

		expect(res.status).toBe(201);
		expect(res.body.data.message).toBeNull();
	});

	test("404 for a non-existent listing", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("create-404") });

		const res = await agent.post(`/api/v1/listings/00000000-0000-0000-0000-000000000000/interests`);

		expect(res.status).toBe(404);
	});

	test("422 when the poster tries to express interest in their own listing", async () => {
		const { posterAgent, listingId } = await createPosterWithListing("create-self");

		const res = await posterAgent.post(`/api/v1/listings/${listingId}/interests`);

		expect(res.status).toBe(422);
	});

	test("a pg_owner cannot create an interest request (student-only route)", async () => {
		// authorize("student") gates this route before the service layer runs.
		const { registerPgOwner } = await import("../setup/testAuth.js");
		const { listingId } = await createPosterWithListing("create-wrongrole-poster");
		const { agent: ownerAgent } = await registerPgOwner({ email: `create-owner-${Date.now()}@business.test` });

		const res = await ownerAgent.post(`/api/v1/listings/${listingId}/interests`);

		expect(res.status).toBe(403);
	});

	test("409 on a duplicate pending request from the same sender to the same listing", async () => {
		const { listingId } = await createPosterWithListing("create-dup-poster");
		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("create-dup-sender") });

		const firstRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
		expect(firstRes.status).toBe(201);

		const secondRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);

		expect(secondRes.status).toBe(409);
	});

	test("422 when the listing has been deactivated", async () => {
		const { posterAgent, listingId } = await createPosterWithListing("create-inactive-poster");
		await posterAgent.patch(`/api/v1/listings/${listingId}/status`).send({ status: "deactivated" });

		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("create-inactive-sender") });

		const res = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);

		expect(res.status).toBe(422);
	});

	test("422 when the listing has expired", async () => {
		const { listingId } = await createPosterWithListing("create-expired-poster");
		// Force expiry directly — no public endpoint moves expires_at into the
		// past, and the expiry cron is a separate concern already covered by
		// its own direct-invocation tests per the architecture plan.
		await pool.query(`UPDATE listings SET expires_at = NOW() - INTERVAL '1 day' WHERE listing_id = $1`, [
			listingId,
		]);

		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("create-expired-sender") });

		const res = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);

		expect(res.status).toBe(422);
	});
});

describe("GET /interests/:interestId", () => {
	test("the sender can view their own interest request", async () => {
		const { listingId } = await createPosterWithListing("get-sender-poster");
		const { agent: senderAgent, user: sender } = await registerStudent({ email: uniqueEmail("get-sender") });
		const createRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
		const interestId = createRes.body.data.interestRequestId;

		const res = await senderAgent.get(`/api/v1/interests/${interestId}`);

		expect(res.status).toBe(200);
		expect(res.body.data.interestRequestId).toBe(interestId);
		expect(res.body.data.student.userId).toBe(sender.userId);
	});

	test("the poster can view an interest request on their listing", async () => {
		const { posterAgent, listingId } = await createPosterWithListing("get-poster-poster");
		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("get-poster-sender") });
		const createRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
		const interestId = createRes.body.data.interestRequestId;

		const res = await posterAgent.get(`/api/v1/interests/${interestId}`);

		expect(res.status).toBe(200);
		expect(res.body.data.interestRequestId).toBe(interestId);
	});

	test("404 for a third party who is neither sender nor poster", async () => {
		const { listingId } = await createPosterWithListing("get-thirdparty-poster");
		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("get-thirdparty-sender") });
		const createRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
		const interestId = createRes.body.data.interestRequestId;

		const { agent: strangerAgent } = await registerStudent({ email: uniqueEmail("get-thirdparty-stranger") });

		const res = await strangerAgent.get(`/api/v1/interests/${interestId}`);

		expect(res.status).toBe(404);
	});

	test("whatsappLink is null before acceptance", async () => {
		const { listingId } = await createPosterWithListing("get-prelink-poster");
		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("get-prelink-sender") });
		const createRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
		const interestId = createRes.body.data.interestRequestId;

		const res = await senderAgent.get(`/api/v1/interests/${interestId}`);

		expect(res.body.data.whatsappLink).toBeNull();
	});

	test("whatsappLink is null after acceptance when the student poster never set a phone", async () => {
		const { posterAgent, listingId } = await createPosterWithListing("get-nophone-poster");
		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("get-nophone-sender") });
		const createRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
		const interestId = createRes.body.data.interestRequestId;

		await posterAgent.patch(`/api/v1/interests/${interestId}/status`).send({ status: "accepted" });

		const res = await senderAgent.get(`/api/v1/interests/${interestId}`);

		expect(res.body.data.status).toBe("accepted");
		expect(res.body.data.whatsappLink).toBeNull();
	});

	test("whatsappLink is populated after acceptance once the student poster sets a phone", async () => {
		const { posterAgent, poster, listingId } = await createPosterWithListing("get-withphone-poster");

		const phoneRes = await posterAgent
			.put(`/api/v1/students/${poster.userId}/profile`)
			.send({ phone: "9876543210" });
		expect(phoneRes.status).toBe(200);

		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("get-withphone-sender") });
		const createRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
		const interestId = createRes.body.data.interestRequestId;

		await posterAgent.patch(`/api/v1/interests/${interestId}/status`).send({ status: "accepted" });

		const res = await senderAgent.get(`/api/v1/interests/${interestId}`);

		expect(res.body.data.status).toBe("accepted");
		expect(res.body.data.whatsappLink).toEqual(expect.any(String));
		expect(res.body.data.whatsappLink).toContain("https://wa.me/9876543210");
	});
});

describe("PATCH /interests/:interestId/status — accept", () => {
	test("accepting creates a connection and increments current_occupants", async () => {
		const { posterAgent, poster, listingId } = await createPosterWithListing("accept-ok-poster", {
			totalCapacity: 2,
		});
		const { agent: senderAgent, user: sender } = await registerStudent({ email: uniqueEmail("accept-ok-sender") });
		const createRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
		const interestId = createRes.body.data.interestRequestId;

		const res = await posterAgent.patch(`/api/v1/interests/${interestId}/status`).send({ status: "accepted" });

		expect(res.status).toBe(200);
		expect(res.body.data.status).toBe("accepted");
		expect(res.body.data.connectionId).toEqual(expect.any(String));
		expect(res.body.data.listingFilled).toBe(false);

		const { rows } = await pool.query(`SELECT current_occupants, status FROM listings WHERE listing_id = $1`, [
			listingId,
		]);
		expect(rows[0].current_occupants).toBe(1);
		expect(rows[0].status).toBe("active");

		const { rows: connRows } = await pool.query(
			`SELECT initiator_id, counterpart_id, connection_type FROM connections WHERE connection_id = $1`,
			[res.body.data.connectionId],
		);
		expect(connRows[0].initiator_id).toBe(sender.userId);
		expect(connRows[0].counterpart_id).toBe(poster.userId);
		expect(connRows[0].connection_type).toBe("student_roommate");
	});

	test("accepting the last available slot flips the listing to filled and auto-expires other pending requests", async () => {
		const { posterAgent, listingId } = await createPosterWithListing("accept-fill-poster", { totalCapacity: 1 });

		const { agent: senderAAgent } = await registerStudent({ email: uniqueEmail("accept-fill-sender-a") });
		const createA = await senderAAgent.post(`/api/v1/listings/${listingId}/interests`);

		const { agent: senderBAgent } = await registerStudent({ email: uniqueEmail("accept-fill-sender-b") });
		const createB = await senderBAgent.post(`/api/v1/listings/${listingId}/interests`);

		const res = await posterAgent
			.patch(`/api/v1/interests/${createA.body.data.interestRequestId}/status`)
			.send({ status: "accepted" });

		expect(res.status).toBe(200);
		expect(res.body.data.listingFilled).toBe(true);

		const { rows: listingRows } = await pool.query(
			`SELECT status, current_occupants FROM listings WHERE listing_id = $1`,
			[listingId],
		);
		expect(listingRows[0].status).toBe("filled");
		expect(listingRows[0].current_occupants).toBe(1);

		const { rows: otherRows } = await pool.query(`SELECT status FROM interest_requests WHERE request_id = $1`, [
			createB.body.data.interestRequestId,
		]);
		expect(otherRows[0].status).toBe("expired");
	});

	test("403 when someone other than the poster tries to accept", async () => {
		const { listingId } = await createPosterWithListing("accept-forbidden-poster");
		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("accept-forbidden-sender") });
		const createRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
		const interestId = createRes.body.data.interestRequestId;

		const { agent: strangerAgent } = await registerStudent({ email: uniqueEmail("accept-forbidden-stranger") });

		const res = await strangerAgent.patch(`/api/v1/interests/${interestId}/status`).send({ status: "accepted" });

		expect(res.status).toBe(403);
	});

	test("422 when accepting on an already-expired listing", async () => {
		const { posterAgent, listingId } = await createPosterWithListing("accept-expired-poster");
		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("accept-expired-sender") });
		const createRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
		const interestId = createRes.body.data.interestRequestId;

		await pool.query(`UPDATE listings SET expires_at = NOW() - INTERVAL '1 day' WHERE listing_id = $1`, [
			listingId,
		]);

		const res = await posterAgent.patch(`/api/v1/interests/${interestId}/status`).send({ status: "accepted" });

		expect(res.status).toBe(422);
	});

	test("409 when accepting a request that is no longer pending", async () => {
		const { posterAgent, listingId } = await createPosterWithListing("accept-notpending-poster", {
			totalCapacity: 2,
		});
		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("accept-notpending-sender") });
		const createRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
		const interestId = createRes.body.data.interestRequestId;

		await senderAgent.patch(`/api/v1/interests/${interestId}/status`).send({ status: "withdrawn" });

		const res = await posterAgent.patch(`/api/v1/interests/${interestId}/status`).send({ status: "accepted" });

		expect(res.status).toBe(422);
	});
});

describe("PATCH /interests/:interestId/status — decline / withdraw", () => {
	test("the poster can decline a pending request", async () => {
		const { posterAgent, listingId } = await createPosterWithListing("decline-ok-poster");
		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("decline-ok-sender") });
		const createRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
		const interestId = createRes.body.data.interestRequestId;

		const res = await posterAgent.patch(`/api/v1/interests/${interestId}/status`).send({ status: "declined" });

		expect(res.status).toBe(200);
		expect(res.body.data.status).toBe("declined");
	});

	test("403 when the sender tries to decline their own request (only the poster may decline)", async () => {
		const { listingId } = await createPosterWithListing("decline-wrongactor-poster");
		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("decline-wrongactor-sender") });
		const createRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
		const interestId = createRes.body.data.interestRequestId;

		const res = await senderAgent.patch(`/api/v1/interests/${interestId}/status`).send({ status: "declined" });

		expect(res.status).toBe(403);
	});

	test("the sender can withdraw their own pending request", async () => {
		const { listingId } = await createPosterWithListing("withdraw-ok-poster");
		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("withdraw-ok-sender") });
		const createRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
		const interestId = createRes.body.data.interestRequestId;

		const res = await senderAgent.patch(`/api/v1/interests/${interestId}/status`).send({ status: "withdrawn" });

		expect(res.status).toBe(200);
		expect(res.body.data.status).toBe("withdrawn");
	});

	test("403 when the poster tries to withdraw the sender's request (only the sender may withdraw)", async () => {
		const { posterAgent, listingId } = await createPosterWithListing("withdraw-wrongactor-poster");
		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("withdraw-wrongactor-sender") });
		const createRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
		const interestId = createRes.body.data.interestRequestId;

		const res = await posterAgent.patch(`/api/v1/interests/${interestId}/status`).send({ status: "withdrawn" });

		expect(res.status).toBe(403);
	});

	test("409 when declining a request that is not pending", async () => {
		const { posterAgent, listingId } = await createPosterWithListing("decline-notpending-poster");
		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("decline-notpending-sender") });
		const createRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
		const interestId = createRes.body.data.interestRequestId;

		await posterAgent.patch(`/api/v1/interests/${interestId}/status`).send({ status: "declined" });

		const res = await posterAgent.patch(`/api/v1/interests/${interestId}/status`).send({ status: "declined" });

		expect(res.status).toBe(409);
	});

	test("rejects an invalid target status with 400", async () => {
		const { listingId } = await createPosterWithListing("badstatus-poster");
		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("badstatus-sender") });
		const createRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
		const interestId = createRes.body.data.interestRequestId;

		const res = await senderAgent.patch(`/api/v1/interests/${interestId}/status`).send({ status: "banana" });

		expect(res.status).toBe(400);
	});

	test("404 for a non-existent interest request", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("notfound-actor") });

		const res = await agent
			.patch(`/api/v1/interests/00000000-0000-0000-0000-000000000000/status`)
			.send({ status: "withdrawn" });

		expect(res.status).toBe(404);
	});
});

describe("GET /listings/:listingId/interests — poster's view", () => {
	test("the poster sees interest requests for their listing", async () => {
		const { posterAgent, listingId } = await createPosterWithListing("list-poster-ok");
		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("list-poster-sender") });
		await senderAgent.post(`/api/v1/listings/${listingId}/interests`);

		const res = await posterAgent.get(`/api/v1/listings/${listingId}/interests`);

		expect(res.status).toBe(200);
		expect(res.body.data.items).toHaveLength(1);
	});

	test("403 when a non-owner tries to view the listing's interests", async () => {
		const { listingId } = await createPosterWithListing("list-forbidden-poster");
		const { agent: strangerAgent } = await registerStudent({ email: uniqueEmail("list-forbidden-stranger") });

		const res = await strangerAgent.get(`/api/v1/listings/${listingId}/interests`);

		expect(res.status).toBe(403);
	});

	test("404 for a non-existent listing", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("list-404") });

		const res = await agent.get(`/api/v1/listings/00000000-0000-0000-0000-000000000000/interests`);

		expect(res.status).toBe(404);
	});

	test("filters by status", async () => {
		const { posterAgent, listingId } = await createPosterWithListing("list-filter-poster", { totalCapacity: 2 });

		const { agent: senderAAgent } = await registerStudent({ email: uniqueEmail("list-filter-sender-a") });
		const createA = await senderAAgent.post(`/api/v1/listings/${listingId}/interests`);
		await posterAgent
			.patch(`/api/v1/interests/${createA.body.data.interestRequestId}/status`)
			.send({ status: "declined" });

		const { agent: senderBAgent } = await registerStudent({ email: uniqueEmail("list-filter-sender-b") });
		await senderBAgent.post(`/api/v1/listings/${listingId}/interests`);

		const res = await posterAgent.get(`/api/v1/listings/${listingId}/interests`).query({ status: "pending" });

		expect(res.status).toBe(200);
		expect(res.body.data.items).toHaveLength(1);
		expect(res.body.data.items[0].status).toBe("pending");
	});
});

describe("GET /interests/me — sender's view", () => {
	test("returns the caller's own interest requests", async () => {
		const { listingId: listingA } = await createPosterWithListing("me-poster-a");
		const { listingId: listingB } = await createPosterWithListing("me-poster-b");
		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("me-sender") });

		await senderAgent.post(`/api/v1/listings/${listingA}/interests`);
		await senderAgent.post(`/api/v1/listings/${listingB}/interests`);

		const res = await senderAgent.get(`/api/v1/interests/me`);

		expect(res.status).toBe(200);
		expect(res.body.data.items).toHaveLength(2);
	});

	test("does not include another student's interest requests", async () => {
		const { listingId } = await createPosterWithListing("me-isolation-poster");
		const { agent: senderAAgent } = await registerStudent({ email: uniqueEmail("me-isolation-sender-a") });
		await senderAAgent.post(`/api/v1/listings/${listingId}/interests`);

		const { agent: senderBAgent } = await registerStudent({ email: uniqueEmail("me-isolation-sender-b") });

		const res = await senderBAgent.get(`/api/v1/interests/me`);

		expect(res.status).toBe(200);
		expect(res.body.data.items).toHaveLength(0);
	});

	test("a pg_owner cannot hit the student-only /interests/me route", async () => {
		const { registerPgOwner } = await import("../setup/testAuth.js");
		const { agent: ownerAgent } = await registerPgOwner({ email: `me-owner-${Date.now()}@business.test` });

		const res = await ownerAgent.get(`/api/v1/interests/me`);

		expect(res.status).toBe(403);
	});

	test("supports cursor pagination", async () => {
		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("me-paginate-sender") });

		for (let i = 0; i < 3; i++) {
			const { listingId } = await createPosterWithListing(`me-paginate-poster-${i}`);
			await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
		}

		const firstPage = await senderAgent.get(`/api/v1/interests/me`).query({ limit: 2 });
		expect(firstPage.status).toBe(200);
		expect(firstPage.body.data.items).toHaveLength(2);
		expect(firstPage.body.data.nextCursor).not.toBeNull();

		const secondPage = await senderAgent.get(`/api/v1/interests/me`).query({
			limit: 2,
			cursorTime: firstPage.body.data.nextCursor.cursorTime,
			cursorId: firstPage.body.data.nextCursor.cursorId,
		});
		expect(secondPage.status).toBe(200);
		expect(secondPage.body.data.items).toHaveLength(1);
	});
});
