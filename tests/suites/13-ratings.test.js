// tests/suites/13-ratings.test.js
//
// Covers: submit (user + property), get-for-connection, public ratings
// (user + property), given-by-me.
//
// A rating requires a CONFIRMED connection between reviewer and reviewee
// (see rating.service.js's submitRating — both the user and property paths
// gate on c.confirmation_status = 'confirmed'). Reuses the same
// create-listing -> express-interest -> accept -> confirm-both-sides flow
// established in 12-connections.test.js as the fixture path, extended one
// step further (confirm) since ratings additionally require confirmation,
// not just an existing connection.
//
// trg_ratings_update_aggregates (migration 001) recalculates
// users.average_rating / rating_count (and properties.average_rating /
// rating_count for property ratings) on every visible-rating insert/update —
// one test asserts that side effect directly, not just the 201.

import request from "supertest";
import { app } from "../../src/app.js";
import { registerStudent, registerPgOwner } from "../setup/testAuth.js";
import { pool } from "../../src/db/client.js";

const uniqueEmail = (label, domain = "college.edu") =>
	`${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@${domain}`;

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

// Drives the real flow to a CONFIRMED connection: poster creates a listing,
// sender expresses interest, poster accepts, both parties confirm.
const createConfirmedConnection = async (labelPrefix, listingOverrides = {}) => {
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
	const connectionId = acceptRes.body.data.connectionId;

	await senderAgent.post(`/api/v1/connections/${connectionId}/confirm`);
	await posterAgent.post(`/api/v1/connections/${connectionId}/confirm`);

	return { posterAgent, poster, senderAgent, sender, listingId, connectionId };
};

const ratingBody = (revieweeId, overrides = {}) => ({
	revieweeType: "user",
	revieweeId,
	overallScore: 4,
	...overrides,
});

describe("POST /ratings — user reviewee", () => {
	test("sender rates the poster on a confirmed connection", async () => {
		const { senderAgent, poster, connectionId } = await createConfirmedConnection("submit-user-ok");

		const res = await senderAgent.post("/api/v1/ratings").send({
			connectionId,
			revieweeType: "user",
			revieweeId: poster.userId,
			overallScore: 5,
			cleanlinessScore: 4,
			communicationScore: 5,
			comment: "Great roommate experience.",
		});

		expect(res.status).toBe(201);
		expect(res.body.data.ratingId).toEqual(expect.any(String));
		expect(res.body.data.createdAt).toEqual(expect.any(String));
	});

	test("poster rates the sender on the same connection (both directions allowed)", async () => {
		const { posterAgent, sender, connectionId } = await createConfirmedConnection("submit-user-reverse");

		const res = await posterAgent
			.post("/api/v1/ratings")
			.send({ connectionId, ...ratingBody(sender.userId, { overallScore: 3 }) });

		expect(res.status).toBe(201);
	});

	test("updates the reviewee's aggregate average_rating and rating_count", async () => {
		const { senderAgent, poster, connectionId } = await createConfirmedConnection("submit-user-aggregate");

		const res = await senderAgent
			.post("/api/v1/ratings")
			.send({ connectionId, ...ratingBody(poster.userId, { overallScore: 4 }) });
		expect(res.status).toBe(201);

		const { rows } = await pool.query(`SELECT average_rating, rating_count FROM users WHERE user_id = $1`, [
			poster.userId,
		]);
		expect(Number(rows[0].average_rating)).toBeCloseTo(4.0);
		expect(rows[0].rating_count).toBe(1);
	});

	test("422 when the connection is not yet confirmed", async () => {
		const { agent: posterAgent, user: poster } = await registerStudent({
			email: uniqueEmail("submit-unconfirmed-poster"),
		});
		const createListingRes = await posterAgent.post("/api/v1/listings").send(studentRoomBody());
		const listingId = createListingRes.body.data.listing_id;

		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("submit-unconfirmed-sender") });
		const interestRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
		const acceptRes = await posterAgent
			.patch(`/api/v1/interests/${interestRes.body.data.interestRequestId}/status`)
			.send({ status: "accepted" });
		const connectionId = acceptRes.body.data.connectionId;
		// Deliberately not confirmed by either party.

		const res = await senderAgent.post("/api/v1/ratings").send({ connectionId, ...ratingBody(poster.userId) });

		expect(res.status).toBe(422);
	});

	test("409 on a duplicate rating for the same connection + reviewee", async () => {
		const { senderAgent, poster, connectionId } = await createConfirmedConnection("submit-dup");

		const first = await senderAgent.post("/api/v1/ratings").send({ connectionId, ...ratingBody(poster.userId) });
		expect(first.status).toBe(201);

		const second = await senderAgent.post("/api/v1/ratings").send({ connectionId, ...ratingBody(poster.userId) });

		expect(second.status).toBe(409);
	});

	test("422 when rating a user who is not a party to the connection", async () => {
		const { senderAgent, connectionId } = await createConfirmedConnection("submit-notparty");
		const { user: stranger } = await registerStudent({ email: uniqueEmail("submit-notparty-stranger") });

		const res = await senderAgent.post("/api/v1/ratings").send({ connectionId, ...ratingBody(stranger.userId) });

		expect(res.status).toBe(422);
	});

	test("404 for a non-existent connection", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("submit-404") });
		const { user: target } = await registerStudent({ email: uniqueEmail("submit-404-target") });

		const res = await agent
			.post("/api/v1/ratings")
			.send({ connectionId: "00000000-0000-0000-0000-000000000000", ...ratingBody(target.userId) });

		expect(res.status).toBe(404);
	});

	test("rejects overallScore out of range", async () => {
		const { senderAgent, poster, connectionId } = await createConfirmedConnection("submit-badscore");

		const res = await senderAgent
			.post("/api/v1/ratings")
			.send({ connectionId, ...ratingBody(poster.userId, { overallScore: 7 }) });

		expect(res.status).toBe(400);
	});

	test("requires authentication", async () => {
		const res = await request(app)
			.post("/api/v1/ratings")
			.send({
				connectionId: "00000000-0000-0000-0000-000000000000",
				...ratingBody("00000000-0000-0000-0000-000000000000"),
			});

		expect(res.status).toBe(401);
	});
});

describe("POST /ratings — property reviewee", () => {
	// Property ratings require the connection to be with the property's owner
	// and the listing to be a pg_room/hostel_bed linked to that property —
	// student_room connections (no property_id) can't rate a property.
	const verifyOwner = async (userId) => {
		await pool.query(
			`UPDATE pg_owner_profiles SET verification_status = 'verified', verified_at = NOW() WHERE user_id = $1`,
			[userId],
		);
	};

	const createConfirmedPropertyConnection = async (labelPrefix) => {
		const { agent: ownerAgent, user: owner } = await registerPgOwner({
			email: uniqueEmail(`${labelPrefix}-owner`, "business.test"),
		});
		await verifyOwner(owner.userId);

		const propRes = await ownerAgent.post("/api/v1/properties").send({
			propertyName: "Test PG",
			propertyType: "pg",
			addressLine: "123 MG Road",
			city: "Pune",
		});
		const propertyId = propRes.body.data.property_id;

		const listingRes = await ownerAgent.post("/api/v1/listings").send({
			listingType: "pg_room",
			propertyId,
			title: "Room for rating tests",
			rentPerMonth: 8000,
			roomType: "single",
			totalCapacity: 2,
			availableFrom: "2026-09-01",
		});
		const listingId = listingRes.body.data.listing_id;

		const { agent: studentAgent, user: student } = await registerStudent({
			email: uniqueEmail(`${labelPrefix}-student`),
		});
		const interestRes = await studentAgent.post(`/api/v1/listings/${listingId}/interests`);
		const acceptRes = await ownerAgent
			.patch(`/api/v1/interests/${interestRes.body.data.interestRequestId}/status`)
			.send({ status: "accepted" });
		const connectionId = acceptRes.body.data.connectionId;

		await studentAgent.post(`/api/v1/connections/${connectionId}/confirm`);
		await ownerAgent.post(`/api/v1/connections/${connectionId}/confirm`);

		return { ownerAgent, owner, studentAgent, student, propertyId, connectionId };
	};

	test("student rates the property on a confirmed pg_room connection", async () => {
		const { studentAgent, propertyId, connectionId } = await createConfirmedPropertyConnection("prop-ok");

		const res = await studentAgent.post("/api/v1/ratings").send({
			connectionId,
			revieweeType: "property",
			revieweeId: propertyId,
			overallScore: 5,
		});

		expect(res.status).toBe(201);
	});

	test("updates the property's aggregate average_rating and rating_count", async () => {
		const { studentAgent, propertyId, connectionId } = await createConfirmedPropertyConnection("prop-aggregate");

		await studentAgent.post("/api/v1/ratings").send({
			connectionId,
			revieweeType: "property",
			revieweeId: propertyId,
			overallScore: 4,
		});

		const { rows } = await pool.query(
			`SELECT average_rating, rating_count FROM properties WHERE property_id = $1`,
			[propertyId],
		);
		expect(Number(rows[0].average_rating)).toBeCloseTo(4.0);
		expect(rows[0].rating_count).toBe(1);
	});

	test("404 when the property does not exist", async () => {
		const { studentAgent, connectionId } = await createConfirmedPropertyConnection("prop-404");

		const res = await studentAgent.post("/api/v1/ratings").send({
			connectionId,
			revieweeType: "property",
			revieweeId: "00000000-0000-0000-0000-000000000000",
			overallScore: 4,
		});

		expect(res.status).toBe(404);
	});

	test("rejects an invalid revieweeType", async () => {
		const { studentAgent, propertyId, connectionId } = await createConfirmedPropertyConnection("prop-badtype");

		const res = await studentAgent.post("/api/v1/ratings").send({
			connectionId,
			revieweeType: "listing",
			revieweeId: propertyId,
			overallScore: 4,
		});

		expect(res.status).toBe(400);
	});
});

describe("GET /ratings/connection/:connectionId", () => {
	test("splits ratings into myRatings and theirRatings for the caller", async () => {
		const { senderAgent, poster, posterAgent, sender, connectionId } =
			await createConfirmedConnection("getconn-split");

		await senderAgent
			.post("/api/v1/ratings")
			.send({ connectionId, ...ratingBody(poster.userId, { overallScore: 5 }) });
		await posterAgent
			.post("/api/v1/ratings")
			.send({ connectionId, ...ratingBody(sender.userId, { overallScore: 3 }) });

		const res = await senderAgent.get(`/api/v1/ratings/connection/${connectionId}`);

		expect(res.status).toBe(200);
		expect(res.body.data.myRatings).toHaveLength(1);
		expect(res.body.data.myRatings[0].overallScore).toBe(5);
		expect(res.body.data.theirRatings).toHaveLength(1);
		expect(res.body.data.theirRatings[0].overallScore).toBe(3);
	});

	test("404 when the caller is not a party to the connection", async () => {
		const { connectionId } = await createConfirmedConnection("getconn-notparty");
		const { agent: strangerAgent } = await registerStudent({ email: uniqueEmail("getconn-notparty-stranger") });

		const res = await strangerAgent.get(`/api/v1/ratings/connection/${connectionId}`);

		expect(res.status).toBe(404);
	});

	test("requires authentication", async () => {
		const { connectionId } = await createConfirmedConnection("getconn-noauth");

		const res = await request(app).get(`/api/v1/ratings/connection/${connectionId}`);

		expect(res.status).toBe(401);
	});
});

describe("GET /ratings/user/:userId — public", () => {
	test("lists visible ratings for a user, with reviewer info", async () => {
		const { senderAgent, poster, connectionId } = await createConfirmedConnection("public-user-ok");
		await senderAgent
			.post("/api/v1/ratings")
			.send({ connectionId, ...ratingBody(poster.userId, { overallScore: 4, comment: "Solid." }) });

		const res = await request(app).get(`/api/v1/ratings/user/${poster.userId}`);

		expect(res.status).toBe(200);
		expect(res.body.data.items).toHaveLength(1);
		expect(res.body.data.items[0].overallScore).toBe(4);
		expect(res.body.data.items[0].reviewer.fullName).toEqual(expect.any(String));
	});

	test("does not require authentication", async () => {
		const { user: target } = await registerStudent({ email: uniqueEmail("public-user-noauth") });

		const res = await request(app).get(`/api/v1/ratings/user/${target.userId}`);

		expect(res.status).toBe(200);
		expect(res.body.data.items).toEqual([]);
	});

	test("supports cursor pagination", async () => {
		const { agent: targetAgent, user: target } = await registerStudent({
			email: uniqueEmail("public-user-paginate"),
		});

		for (let i = 0; i < 3; i++) {
			const { senderAgent, connectionId } = await createConfirmedConnectionToFixedTarget(
				`public-user-paginate-${i}`,
				targetAgent,
				target,
			);
			await senderAgent
				.post("/api/v1/ratings")
				.send({ connectionId, ...ratingBody(target.userId, { overallScore: 4 }) });
		}

		const firstPage = await request(app).get(`/api/v1/ratings/user/${target.userId}`).query({ limit: 2 });
		expect(firstPage.status).toBe(200);
		expect(firstPage.body.data.items).toHaveLength(2);
		expect(firstPage.body.data.nextCursor).not.toBeNull();

		const secondPage = await request(app).get(`/api/v1/ratings/user/${target.userId}`).query({
			limit: 2,
			cursorTime: firstPage.body.data.nextCursor.cursorTime,
			cursorId: firstPage.body.data.nextCursor.cursorId,
		});
		expect(secondPage.status).toBe(200);
		expect(secondPage.body.data.items).toHaveLength(1);
	});
});

// Helper for the pagination test above: creates a fresh poster+listing each
// time (interest_requests has a one-pending/accepted-per-sender-per-listing
// constraint) but always routes the connection back to the SAME target user
// as reviewee by making `target` the poster for each iteration's listing.
const createConfirmedConnectionToFixedTarget = async (labelPrefix, targetAgent, target) => {
	const createListingRes = await targetAgent.post("/api/v1/listings").send(studentRoomBody());
	const listingId = createListingRes.body.data.listing_id;

	const { agent: senderAgent } = await registerStudent({ email: uniqueEmail(`${labelPrefix}-sender`) });
	const interestRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
	const acceptRes = await targetAgent
		.patch(`/api/v1/interests/${interestRes.body.data.interestRequestId}/status`)
		.send({ status: "accepted" });
	const connectionId = acceptRes.body.data.connectionId;

	await senderAgent.post(`/api/v1/connections/${connectionId}/confirm`);
	await targetAgent.post(`/api/v1/connections/${connectionId}/confirm`);

	return { senderAgent, connectionId };
};

describe("GET /ratings/property/:propertyId — public", () => {
	const verifyOwner = async (userId) => {
		await pool.query(
			`UPDATE pg_owner_profiles SET verification_status = 'verified', verified_at = NOW() WHERE user_id = $1`,
			[userId],
		);
	};

	test("lists visible ratings for a property", async () => {
		const { agent: ownerAgent, user: owner } = await registerPgOwner({
			email: uniqueEmail("public-prop-owner", "business.test"),
		});
		await verifyOwner(owner.userId);

		const propRes = await ownerAgent.post("/api/v1/properties").send({
			propertyName: "Rated PG",
			propertyType: "pg",
			addressLine: "123 MG Road",
			city: "Pune",
		});
		const propertyId = propRes.body.data.property_id;

		const listingRes = await ownerAgent.post("/api/v1/listings").send({
			listingType: "pg_room",
			propertyId,
			title: "Room for public property rating test",
			rentPerMonth: 8000,
			roomType: "single",
			totalCapacity: 2,
			availableFrom: "2026-09-01",
		});
		const listingId = listingRes.body.data.listing_id;

		const { agent: studentAgent } = await registerStudent({ email: uniqueEmail("public-prop-student") });
		const interestRes = await studentAgent.post(`/api/v1/listings/${listingId}/interests`);
		const acceptRes = await ownerAgent
			.patch(`/api/v1/interests/${interestRes.body.data.interestRequestId}/status`)
			.send({ status: "accepted" });
		const connectionId = acceptRes.body.data.connectionId;

		await studentAgent.post(`/api/v1/connections/${connectionId}/confirm`);
		await ownerAgent.post(`/api/v1/connections/${connectionId}/confirm`);

		await studentAgent.post("/api/v1/ratings").send({
			connectionId,
			revieweeType: "property",
			revieweeId: propertyId,
			overallScore: 5,
		});

		const res = await request(app).get(`/api/v1/ratings/property/${propertyId}`);

		expect(res.status).toBe(200);
		expect(res.body.data.items).toHaveLength(1);
		expect(res.body.data.items[0].overallScore).toBe(5);
	});

	test("404 for a non-existent property", async () => {
		const res = await request(app).get(`/api/v1/ratings/property/00000000-0000-0000-0000-000000000000`);
		expect(res.status).toBe(404);
	});
});

describe("GET /ratings/me/given", () => {
	test("returns ratings the caller has submitted, with reviewee info", async () => {
		const { senderAgent, poster, connectionId } = await createConfirmedConnection("given-ok");
		await senderAgent
			.post("/api/v1/ratings")
			.send({ connectionId, ...ratingBody(poster.userId, { overallScore: 4 }) });

		const res = await senderAgent.get("/api/v1/ratings/me/given");

		expect(res.status).toBe(200);
		expect(res.body.data.items).toHaveLength(1);
		expect(res.body.data.items[0].reviewee.userId ?? res.body.data.items[0].revieweeId).toBeTruthy();
		expect(res.body.data.items[0].overallScore).toBe(4);
	});

	test("does not include ratings given by other users", async () => {
		const { senderAgent, posterAgent, poster, sender, connectionId } =
			await createConfirmedConnection("given-isolation");
		await posterAgent
			.post("/api/v1/ratings")
			.send({ connectionId, ...ratingBody(sender.userId, { overallScore: 2 }) });

		const res = await senderAgent.get("/api/v1/ratings/me/given");

		expect(res.status).toBe(200);
		expect(res.body.data.items).toHaveLength(0);
	});

	test("requires authentication", async () => {
		const res = await request(app).get("/api/v1/ratings/me/given");
		expect(res.status).toBe(401);
	});
});
