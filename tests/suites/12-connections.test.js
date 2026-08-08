// tests/suites/12-connections.test.js
//
// Covers: get, list-mine, confirm (both parties).
//
// There is no direct "create connection" endpoint — connections are only
// created as a side effect of accepting an interest request (see
// _acceptInterestRequest in src/services/interest.service.js), which is why
// this suite is sequenced right after 11-interests in the rollout plan. The
// helper below drives the real create-listing -> express-interest -> accept
// flow to produce a connection, rather than inserting one directly via SQL,
// so the fixture itself exercises the real dependency chain.
//
// A freshly-created connection always has connection_type='student_roommate'
// here because every fixture uses student_room listings (the interests suite
// established this same pattern) — LISTING_TYPE_TO_CONNECTION_TYPE in
// interest.service.js maps student_room -> student_roommate.

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
	totalCapacity: 2,
	availableFrom: "2026-09-01",
	addressLine: "45 College Street",
	city: "Delhi",
	latitude: 28.6139,
	longitude: 77.209,
	...overrides,
});

// Drives the real flow to produce a connection: poster creates a listing,
// sender expresses interest, poster accepts. Returns both parties' agents,
// the connectionId, and the listingId, so tests can assert on any of them.
// totalCapacity defaults to 2 so acceptance does NOT auto-fill the listing —
// tests that specifically want the fill side effect pass totalCapacity: 1.
const createConnection = async (labelPrefix, listingOverrides = {}) => {
	const { agent: posterAgent, user: poster } = await registerStudent({
		email: uniqueEmail(`${labelPrefix}-poster`),
	});
	const createListingRes = await posterAgent.post("/api/v1/listings").send(studentRoomBody(listingOverrides));
	const listingId = createListingRes.body.data.listing_id;

	const { agent: senderAgent, user: sender } = await registerStudent({
		email: uniqueEmail(`${labelPrefix}-sender`),
	});
	const interestRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
	const interestId = interestRes.body.data.interestRequestId;

	const acceptRes = await posterAgent.patch(`/api/v1/interests/${interestId}/status`).send({ status: "accepted" });

	return {
		posterAgent,
		poster,
		senderAgent,
		sender,
		listingId,
		connectionId: acceptRes.body.data.connectionId,
	};
};

describe("GET /connections/:connectionId", () => {
	test("the initiator (sender) can view the connection", async () => {
		const { senderAgent, sender, poster, connectionId } = await createConnection("get-initiator");

		const res = await senderAgent.get(`/api/v1/connections/${connectionId}`);

		expect(res.status).toBe(200);
		expect(res.body.data.connectionId).toBe(connectionId);
		expect(res.body.data.otherParty.userId).toBe(poster.userId);
		expect(res.body.data.connectionType).toBe("student_roommate");
		expect(res.body.data.confirmationStatus).toBe("pending");
		expect(res.body.data.initiatorConfirmed).toBe(false);
		expect(res.body.data.counterpartConfirmed).toBe(false);
	});

	test("the counterpart (poster) can view the connection", async () => {
		const { posterAgent, sender, connectionId } = await createConnection("get-counterpart");

		const res = await posterAgent.get(`/api/v1/connections/${connectionId}`);

		expect(res.status).toBe(200);
		expect(res.body.data.otherParty.userId).toBe(sender.userId);
	});

	test("includes the associated listing summary", async () => {
		const { senderAgent, listingId, connectionId } = await createConnection("get-listing");

		const res = await senderAgent.get(`/api/v1/connections/${connectionId}`);

		expect(res.status).toBe(200);
		expect(res.body.data.listing).not.toBeNull();
		expect(res.body.data.listing.listingId).toBe(listingId);
		expect(res.body.data.listing.rentPerMonth).toBe(6000);
	});

	test("404 for a third party who is neither the initiator nor the counterpart", async () => {
		const { connectionId } = await createConnection("get-thirdparty");
		const { agent: strangerAgent } = await registerStudent({ email: uniqueEmail("get-thirdparty-stranger") });

		const res = await strangerAgent.get(`/api/v1/connections/${connectionId}`);

		expect(res.status).toBe(404);
	});

	test("404 for a non-existent connection", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("get-404") });

		const res = await agent.get(`/api/v1/connections/00000000-0000-0000-0000-000000000000`);

		expect(res.status).toBe(404);
	});

	test("requires authentication", async () => {
		const { connectionId } = await createConnection("get-noauth");

		const res = await request(app).get(`/api/v1/connections/${connectionId}`);

		expect(res.status).toBe(401);
	});

	test("rejects a malformed connection id with 400", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("get-badid") });

		const res = await agent.get(`/api/v1/connections/not-a-uuid`);

		expect(res.status).toBe(400);
	});
});

describe("POST /connections/:connectionId/confirm", () => {
	test("a single party confirming does not flip confirmationStatus to confirmed", async () => {
		const { senderAgent, connectionId } = await createConnection("confirm-single");

		const res = await senderAgent.post(`/api/v1/connections/${connectionId}/confirm`);

		expect(res.status).toBe(200);
		expect(res.body.data.initiatorConfirmed).toBe(true);
		expect(res.body.data.counterpartConfirmed).toBe(false);
		expect(res.body.data.confirmationStatus).toBe("pending");
	});

	test("both parties confirming flips confirmationStatus to confirmed", async () => {
		const { senderAgent, posterAgent, connectionId } = await createConnection("confirm-both");

		await senderAgent.post(`/api/v1/connections/${connectionId}/confirm`);
		const res = await posterAgent.post(`/api/v1/connections/${connectionId}/confirm`);

		expect(res.status).toBe(200);
		expect(res.body.data.initiatorConfirmed).toBe(true);
		expect(res.body.data.counterpartConfirmed).toBe(true);
		expect(res.body.data.confirmationStatus).toBe("confirmed");
	});

	test("order of confirmation does not matter — counterpart first also reaches confirmed", async () => {
		const { senderAgent, posterAgent, connectionId } = await createConnection("confirm-order");

		await posterAgent.post(`/api/v1/connections/${connectionId}/confirm`);
		const res = await senderAgent.post(`/api/v1/connections/${connectionId}/confirm`);

		expect(res.status).toBe(200);
		expect(res.body.data.confirmationStatus).toBe("confirmed");
	});

	test("confirming again after already confirmed is a harmless no-op for that party", async () => {
		const { senderAgent, posterAgent, connectionId } = await createConnection("confirm-idempotent");

		await senderAgent.post(`/api/v1/connections/${connectionId}/confirm`);
		await posterAgent.post(`/api/v1/connections/${connectionId}/confirm`);

		const res = await senderAgent.post(`/api/v1/connections/${connectionId}/confirm`);

		expect(res.status).toBe(200);
		expect(res.body.data.confirmationStatus).toBe("confirmed");
		expect(res.body.data.initiatorConfirmed).toBe(true);
		expect(res.body.data.counterpartConfirmed).toBe(true);
	});

	test("persists confirmation state in the database", async () => {
		const { senderAgent, connectionId } = await createConnection("confirm-persist");

		await senderAgent.post(`/api/v1/connections/${connectionId}/confirm`);

		const { rows } = await pool.query(
			`SELECT initiator_confirmed, counterpart_confirmed, confirmation_status
       FROM connections WHERE connection_id = $1`,
			[connectionId],
		);
		expect(rows[0].initiator_confirmed).toBe(true);
		expect(rows[0].counterpart_confirmed).toBe(false);
		expect(rows[0].confirmation_status).toBe("pending");
	});

	test("404 when a third party tries to confirm", async () => {
		const { connectionId } = await createConnection("confirm-thirdparty");
		const { agent: strangerAgent } = await registerStudent({ email: uniqueEmail("confirm-thirdparty-stranger") });

		const res = await strangerAgent.post(`/api/v1/connections/${connectionId}/confirm`);

		expect(res.status).toBe(404);
	});

	test("404 for a non-existent connection", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("confirm-404") });

		const res = await agent.post(`/api/v1/connections/00000000-0000-0000-0000-000000000000/confirm`);

		expect(res.status).toBe(404);
	});

	test("requires authentication", async () => {
		const { connectionId } = await createConnection("confirm-noauth");

		const res = await request(app).post(`/api/v1/connections/${connectionId}/confirm`);

		expect(res.status).toBe(401);
	});
});

describe("GET /connections/me", () => {
	test("returns connections the caller is a party to", async () => {
		const { senderAgent } = await createConnection("me-basic");

		const res = await senderAgent.get(`/api/v1/connections/me`);

		expect(res.status).toBe(200);
		expect(res.body.data.items).toHaveLength(1);
		expect(res.body.data.items[0].confirmationStatus).toBe("pending");
	});

	test("does not include connections the caller is not a party to", async () => {
		await createConnection("me-isolation-other");
		const { agent: strangerAgent } = await registerStudent({ email: uniqueEmail("me-isolation-stranger") });

		const res = await strangerAgent.get(`/api/v1/connections/me`);

		expect(res.status).toBe(200);
		expect(res.body.data.items).toHaveLength(0);
	});

	test("appears for both the initiator and the counterpart", async () => {
		const { senderAgent, posterAgent } = await createConnection("me-both-sides");

		const senderRes = await senderAgent.get(`/api/v1/connections/me`);
		const posterRes = await posterAgent.get(`/api/v1/connections/me`);

		expect(senderRes.body.data.items).toHaveLength(1);
		expect(posterRes.body.data.items).toHaveLength(1);
		expect(senderRes.body.data.items[0].connectionId).toBe(posterRes.body.data.items[0].connectionId);
	});

	test("filters by confirmationStatus", async () => {
		const { senderAgent: pendingSenderAgent } = await createConnection("me-filter-pending");
		const {
			senderAgent: confirmedSenderAgent,
			posterAgent: confirmedPosterAgent,
			connectionId: confirmedConnectionId,
		} = await createConnection("me-filter-confirmed");
		await confirmedSenderAgent.post(`/api/v1/connections/${confirmedConnectionId}/confirm`);
		await confirmedPosterAgent.post(`/api/v1/connections/${confirmedConnectionId}/confirm`);

		// pendingSenderAgent and confirmedSenderAgent are different users, so
		// query each caller's own list filtered by status rather than assuming
		// a shared caller — that mirrors how a real user would only ever see
		// their own connections regardless of filter.
		const pendingRes = await pendingSenderAgent
			.get(`/api/v1/connections/me`)
			.query({ confirmationStatus: "pending" });
		expect(pendingRes.status).toBe(200);
		expect(pendingRes.body.data.items).toHaveLength(1);
		expect(pendingRes.body.data.items[0].confirmationStatus).toBe("pending");

		const confirmedRes = await confirmedSenderAgent
			.get(`/api/v1/connections/me`)
			.query({ confirmationStatus: "confirmed" });
		expect(confirmedRes.status).toBe(200);
		expect(confirmedRes.body.data.items).toHaveLength(1);
		expect(confirmedRes.body.data.items[0].confirmationStatus).toBe("confirmed");
	});

	test("filters by connectionType", async () => {
		const { senderAgent } = await createConnection("me-filter-type");

		const matchRes = await senderAgent.get(`/api/v1/connections/me`).query({ connectionType: "student_roommate" });
		expect(matchRes.status).toBe(200);
		expect(matchRes.body.data.items).toHaveLength(1);

		const noMatchRes = await senderAgent.get(`/api/v1/connections/me`).query({ connectionType: "pg_stay" });
		expect(noMatchRes.status).toBe(200);
		expect(noMatchRes.body.data.items).toHaveLength(0);
	});

	test("rejects an invalid connectionType enum value with 400", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("me-badtype") });

		const res = await agent.get(`/api/v1/connections/me`).query({ connectionType: "not_a_real_type" });

		expect(res.status).toBe(400);
	});

	test("supports cursor pagination", async () => {
		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("me-paginate-sender") });

		for (let i = 0; i < 3; i++) {
			const { agent: posterAgent } = await registerStudent({
				email: uniqueEmail(`me-paginate-poster-${i}`),
			});
			const createRes = await posterAgent.post("/api/v1/listings").send(studentRoomBody({ totalCapacity: 2 }));
			const listingId = createRes.body.data.listing_id;

			const interestRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
			await posterAgent
				.patch(`/api/v1/interests/${interestRes.body.data.interestRequestId}/status`)
				.send({ status: "accepted" });
		}

		const firstPage = await senderAgent.get(`/api/v1/connections/me`).query({ limit: 2 });
		expect(firstPage.status).toBe(200);
		expect(firstPage.body.data.items).toHaveLength(2);
		expect(firstPage.body.data.nextCursor).not.toBeNull();

		const secondPage = await senderAgent.get(`/api/v1/connections/me`).query({
			limit: 2,
			cursorTime: firstPage.body.data.nextCursor.cursorTime,
			cursorId: firstPage.body.data.nextCursor.cursorId,
		});
		expect(secondPage.status).toBe(200);
		expect(secondPage.body.data.items).toHaveLength(1);
	});

	test("requires authentication", async () => {
		const res = await request(app).get(`/api/v1/connections/me`);
		expect(res.status).toBe(401);
	});
});
