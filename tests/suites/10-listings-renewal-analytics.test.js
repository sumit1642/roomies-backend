// tests/suites/10-listings-renewal-analytics.test.js
//
// Covers: POST /listings/:id/renew, GET /listings/:id/analytics,
// GET+PUT /listings/:id/preferences, POST+DELETE /listings/:id/save,
// GET /listings/me/saved.
//
// All fixtures use student_room listings (simplest path — no property/
// verified-pg_owner setup needed) per the pattern established in
// 07-listings-crud.test.js and 11-interests.test.js.
//
// renewListing (listingRenewal.service.js) accepts current status
// active|expired|deactivated and always flips to 'active', extending
// expires_at by 60 days from GREATEST(expires_at, NOW()) — so a still-active
// listing gets 60 days added on top of its current expiry, not replaced.
//
// getListingAnalytics (listingAnalytics.service.js) aggregates interest
// counts by status and computes conversionRate = interests/views, null when
// views is 0 (division-by-zero guard). views_count only increments via
// GET /listings/:id (listing.service.js's getListing fire-and-forget
// UPDATE), so tests that need a nonzero view count call that endpoint first
// and poll briefly for the async increment to land.
//
// getListingPreferences has no ownership gate (route: authenticate only, no
// authorize/ownership check) — any authenticated user can read a listing's
// preferences. updateListingPreferences DOES require ownership (404 for a
// non-owner, matching listing.service.js's `if (!ownerCheck.length) throw 404`).

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

const createPosterWithListing = async (label, overrides = {}) => {
	const { agent, user } = await registerStudent({ email: uniqueEmail(label) });
	const createRes = await agent.post("/api/v1/listings").send(studentRoomBody(overrides));
	if (createRes.status !== 201) {
		throw new Error(`createPosterWithListing failed (${createRes.status}): ${JSON.stringify(createRes.body)}`);
	}
	return { agent, user, listingId: createRes.body.data.listing_id };
};

// Polls the listing's views_count until it reflects at least `min` views, or
// times out. getListing()'s view-count increment is fire-and-forget
// (`void pool.query(...)`) so it is not guaranteed to have landed by the
// time the HTTP response returns.
const waitForViewsAtLeast = async (listingId, min, timeoutMs = 3000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const { rows } = await pool.query(`SELECT views_count FROM listings WHERE listing_id = $1`, [listingId]);
		if (rows[0]?.views_count >= min) return rows[0].views_count;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`waitForViewsAtLeast: views_count for ${listingId} never reached ${min} within ${timeoutMs}ms`);
};

describe("POST /listings/:listingId/renew", () => {
	test("renews an active listing, extending expires_at by 60 days from its current expiry", async () => {
		const { agent, listingId } = await createPosterWithListing("renew-active");

		const { rows: beforeRows } = await pool.query(`SELECT expires_at FROM listings WHERE listing_id = $1`, [
			listingId,
		]);
		const beforeExpiry = new Date(beforeRows[0].expires_at);

		const res = await agent.post(`/api/v1/listings/${listingId}/renew`);

		expect(res.status).toBe(200);
		expect(res.body.data.status).toBe("active");
		expect(res.body.data.renewedFor).toBe("60 days");

		const newExpiry = new Date(res.body.data.expiresAt);
		const diffDays = (newExpiry - beforeExpiry) / (1000 * 60 * 60 * 24);
		expect(diffDays).toBeCloseTo(60, 0);
	});

	test("renews an expired listing back to active", async () => {
		const { agent, listingId } = await createPosterWithListing("renew-expired");
		await pool.query(
			`UPDATE listings SET status = 'expired', expires_at = NOW() - INTERVAL '5 days' WHERE listing_id = $1`,
			[listingId],
		);

		const res = await agent.post(`/api/v1/listings/${listingId}/renew`);

		expect(res.status).toBe(200);
		expect(res.body.data.status).toBe("active");

		// GREATEST(expires_at, NOW()) means the new expiry is ~60 days from NOW,
		// not from the stale past expires_at.
		const newExpiry = new Date(res.body.data.expiresAt);
		const diffDaysFromNow = (newExpiry - Date.now()) / (1000 * 60 * 60 * 24);
		expect(diffDaysFromNow).toBeGreaterThan(58);
		expect(diffDaysFromNow).toBeLessThan(62);
	});

	test("renews a deactivated listing back to active", async () => {
		const { agent, listingId } = await createPosterWithListing("renew-deactivated");
		await agent.patch(`/api/v1/listings/${listingId}/status`).send({ status: "deactivated" });

		const res = await agent.post(`/api/v1/listings/${listingId}/renew`);

		expect(res.status).toBe(200);
		expect(res.body.data.status).toBe("active");
	});

	test("422 when renewing a filled listing (not a renewable status)", async () => {
		const { agent, listingId } = await createPosterWithListing("renew-filled", { totalCapacity: 1 });
		await agent.patch(`/api/v1/listings/${listingId}/status`).send({ status: "filled" });

		const res = await agent.post(`/api/v1/listings/${listingId}/renew`);

		expect(res.status).toBe(422);
	});

	test("403 when a non-owner tries to renew", async () => {
		const { listingId } = await createPosterWithListing("renew-forbidden-owner");
		const { agent: attackerAgent } = await registerStudent({ email: uniqueEmail("renew-forbidden-attacker") });

		const res = await attackerAgent.post(`/api/v1/listings/${listingId}/renew`);

		expect(res.status).toBe(403);
	});

	test("404 for a non-existent listing", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("renew-404") });

		const res = await agent.post(`/api/v1/listings/00000000-0000-0000-0000-000000000000/renew`);

		expect(res.status).toBe(404);
	});

	test("requires authentication", async () => {
		const { listingId } = await createPosterWithListing("renew-noauth");

		const res = await request(app).post(`/api/v1/listings/${listingId}/renew`);

		expect(res.status).toBe(401);
	});
});

describe("GET /listings/:listingId/analytics", () => {
	test("returns zeroed interest counts and null conversionRate with no views", async () => {
		const { agent, listingId } = await createPosterWithListing("analytics-empty");

		const res = await agent.get(`/api/v1/listings/${listingId}/analytics`);

		expect(res.status).toBe(200);
		expect(res.body.data.views).toBe(0);
		expect(res.body.data.interests.total).toBe(0);
		expect(res.body.data.conversionRate).toBeNull();
	});

	test("counts interest requests by status", async () => {
		const { agent: posterAgent, listingId } = await createPosterWithListing("analytics-counts", {
			totalCapacity: 3,
		});

		const { agent: senderAAgent } = await registerStudent({ email: uniqueEmail("analytics-sender-a") });
		const createA = await senderAAgent.post(`/api/v1/listings/${listingId}/interests`);
		await posterAgent
			.patch(`/api/v1/interests/${createA.body.data.interestRequestId}/status`)
			.send({ status: "accepted" });

		const { agent: senderBAgent } = await registerStudent({ email: uniqueEmail("analytics-sender-b") });
		const createB = await senderBAgent.post(`/api/v1/listings/${listingId}/interests`);
		await posterAgent
			.patch(`/api/v1/interests/${createB.body.data.interestRequestId}/status`)
			.send({ status: "declined" });

		const { agent: senderCAgent } = await registerStudent({ email: uniqueEmail("analytics-sender-c") });
		await senderCAgent.post(`/api/v1/listings/${listingId}/interests`);

		const res = await posterAgent.get(`/api/v1/listings/${listingId}/analytics`);

		expect(res.status).toBe(200);
		expect(res.body.data.interests.total).toBe(3);
		expect(res.body.data.interests.accepted).toBe(1);
		expect(res.body.data.interests.declined).toBe(1);
		expect(res.body.data.interests.pending).toBe(1);
	});

	test("computes conversionRate once views exist", async () => {
		const { agent, listingId } = await createPosterWithListing("analytics-conversion");

		// Drive a real view increment via the public detail endpoint.
		await request(app).get(`/api/v1/listings/${listingId}`);
		await waitForViewsAtLeast(listingId, 1);

		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("analytics-conversion-sender") });
		await senderAgent.post(`/api/v1/listings/${listingId}/interests`);

		const res = await agent.get(`/api/v1/listings/${listingId}/analytics`);

		expect(res.status).toBe(200);
		expect(res.body.data.views).toBeGreaterThanOrEqual(1);
		expect(res.body.data.conversionRate).toEqual(expect.any(Number));
	});

	test("403 when a non-owner requests analytics for someone else's listing", async () => {
		const { listingId } = await createPosterWithListing("analytics-forbidden-owner");
		const { agent: strangerAgent } = await registerStudent({ email: uniqueEmail("analytics-forbidden-stranger") });

		const res = await strangerAgent.get(`/api/v1/listings/${listingId}/analytics`);

		expect(res.status).toBe(403);
	});

	test("404 for a non-existent listing", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("analytics-404") });

		const res = await agent.get(`/api/v1/listings/00000000-0000-0000-0000-000000000000/analytics`);

		expect(res.status).toBe(404);
	});

	test("requires authentication", async () => {
		const { listingId } = await createPosterWithListing("analytics-noauth");

		const res = await request(app).get(`/api/v1/listings/${listingId}/analytics`);

		expect(res.status).toBe(401);
	});
});

describe("GET /listings/:listingId/preferences, PUT /listings/:listingId/preferences", () => {
	test("returns an empty array when no preferences are set", async () => {
		const { agent, listingId } = await createPosterWithListing("prefs-empty");

		const res = await agent.get(`/api/v1/listings/${listingId}/preferences`);

		expect(res.status).toBe(200);
		expect(res.body.data).toEqual([]);
	});

	test("owner sets and retrieves preferences", async () => {
		const { agent, listingId } = await createPosterWithListing("prefs-set");

		const putRes = await agent.put(`/api/v1/listings/${listingId}/preferences`).send({
			preferences: [
				{ preferenceKey: "smoking", preferenceValue: "non_smoker" },
				{ preferenceKey: "cleanliness_level", preferenceValue: "high" },
			],
		});

		expect(putRes.status).toBe(200);
		expect(putRes.body.data).toHaveLength(2);

		const getRes = await agent.get(`/api/v1/listings/${listingId}/preferences`);
		expect(getRes.body.data).toHaveLength(2);
		expect(getRes.body.data.map((p) => p.preferenceKey).sort()).toEqual(["cleanliness_level", "smoking"]);
	});

	test("any authenticated user (not just the owner) can read preferences", async () => {
		const { agent: posterAgent, listingId } = await createPosterWithListing("prefs-read-anyone");
		await posterAgent.put(`/api/v1/listings/${listingId}/preferences`).send({
			preferences: [{ preferenceKey: "alcohol", preferenceValue: "okay" }],
		});

		const { agent: viewerAgent } = await registerStudent({ email: uniqueEmail("prefs-read-viewer") });

		const res = await viewerAgent.get(`/api/v1/listings/${listingId}/preferences`);

		expect(res.status).toBe(200);
		expect(res.body.data).toHaveLength(1);
	});

	test("404 when a non-owner tries to update preferences", async () => {
		const { listingId } = await createPosterWithListing("prefs-forbidden-owner");
		const { agent: attackerAgent } = await registerStudent({ email: uniqueEmail("prefs-forbidden-attacker") });

		const res = await attackerAgent.put(`/api/v1/listings/${listingId}/preferences`).send({
			preferences: [{ preferenceKey: "smoking", preferenceValue: "smoker" }],
		});

		expect(res.status).toBe(404);
	});

	test("rejects an invalid preferenceValue for a known key", async () => {
		const { agent, listingId } = await createPosterWithListing("prefs-invalid");

		const res = await agent.put(`/api/v1/listings/${listingId}/preferences`).send({
			preferences: [{ preferenceKey: "smoking", preferenceValue: "occasionally" }],
		});

		expect(res.status).toBe(400);
	});

	test("replaces the full preference set on each PUT (not a merge)", async () => {
		const { agent, listingId } = await createPosterWithListing("prefs-replace");

		await agent.put(`/api/v1/listings/${listingId}/preferences`).send({
			preferences: [{ preferenceKey: "smoking", preferenceValue: "non_smoker" }],
		});

		const secondRes = await agent.put(`/api/v1/listings/${listingId}/preferences`).send({
			preferences: [{ preferenceKey: "alcohol", preferenceValue: "not_okay" }],
		});

		expect(secondRes.status).toBe(200);
		expect(secondRes.body.data).toHaveLength(1);
		expect(secondRes.body.data[0].preferenceKey).toBe("alcohol");
	});

	test("404 for GET preferences on a non-existent listing", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("prefs-get-404") });

		const res = await agent.get(`/api/v1/listings/00000000-0000-0000-0000-000000000000/preferences`);

		expect(res.status).toBe(404);
	});

	test("requires authentication to read preferences", async () => {
		const { listingId } = await createPosterWithListing("prefs-noauth");

		const res = await request(app).get(`/api/v1/listings/${listingId}/preferences`);

		expect(res.status).toBe(401);
	});
});

describe("POST /listings/:listingId/save, DELETE /listings/:listingId/save", () => {
	test("a student saves an active listing", async () => {
		const { listingId } = await createPosterWithListing("save-ok-poster");
		const { agent: saverAgent } = await registerStudent({ email: uniqueEmail("save-ok-saver") });

		const res = await saverAgent.post(`/api/v1/listings/${listingId}/save`);

		expect(res.status).toBe(200);
		expect(res.body.data.saved).toBe(true);
		expect(res.body.data.listingId).toBe(listingId);
	});

	test("saving twice is idempotent (upsert clears any prior soft-delete)", async () => {
		const { listingId } = await createPosterWithListing("save-dup-poster");
		const { agent: saverAgent } = await registerStudent({ email: uniqueEmail("save-dup-saver") });

		const first = await saverAgent.post(`/api/v1/listings/${listingId}/save`);
		expect(first.status).toBe(200);

		const second = await saverAgent.post(`/api/v1/listings/${listingId}/save`);
		expect(second.status).toBe(200);
	});

	test("422 when saving an expired listing", async () => {
		const { listingId } = await createPosterWithListing("save-expired-poster");
		await pool.query(`UPDATE listings SET expires_at = NOW() - INTERVAL '1 day' WHERE listing_id = $1`, [
			listingId,
		]);
		const { agent: saverAgent } = await registerStudent({ email: uniqueEmail("save-expired-saver") });

		const res = await saverAgent.post(`/api/v1/listings/${listingId}/save`);

		expect(res.status).toBe(422);
	});

	test("422 when saving a deactivated listing", async () => {
		const { agent: posterAgent, listingId } = await createPosterWithListing("save-deactivated-poster");
		await posterAgent.patch(`/api/v1/listings/${listingId}/status`).send({ status: "deactivated" });
		const { agent: saverAgent } = await registerStudent({ email: uniqueEmail("save-deactivated-saver") });

		const res = await saverAgent.post(`/api/v1/listings/${listingId}/save`);

		expect(res.status).toBe(422);
	});

	test("404 for a non-existent listing", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("save-404") });

		const res = await agent.post(`/api/v1/listings/00000000-0000-0000-0000-000000000000/save`);

		expect(res.status).toBe(404);
	});

	test("a pg_owner cannot save a listing (student-only route)", async () => {
		const { registerPgOwner } = await import("../setup/testAuth.js");
		const { listingId } = await createPosterWithListing("save-wrongrole-poster");
		const { agent: ownerAgent } = await registerPgOwner({ email: `save-owner-${Date.now()}@business.test` });

		const res = await ownerAgent.post(`/api/v1/listings/${listingId}/save`);

		expect(res.status).toBe(403);
	});

	test("unsaves a previously saved listing", async () => {
		const { listingId } = await createPosterWithListing("unsave-ok-poster");
		const { agent: saverAgent } = await registerStudent({ email: uniqueEmail("unsave-ok-saver") });
		await saverAgent.post(`/api/v1/listings/${listingId}/save`);

		const res = await saverAgent.delete(`/api/v1/listings/${listingId}/save`);

		expect(res.status).toBe(200);
		expect(res.body.data.saved).toBe(false);
	});

	test("unsaving a listing that was never saved is a harmless no-op", async () => {
		const { listingId } = await createPosterWithListing("unsave-noop-poster");
		const { agent: saverAgent } = await registerStudent({ email: uniqueEmail("unsave-noop-saver") });

		const res = await saverAgent.delete(`/api/v1/listings/${listingId}/save`);

		expect(res.status).toBe(200);
		expect(res.body.data.saved).toBe(false);
	});

	test("requires authentication", async () => {
		const { listingId } = await createPosterWithListing("save-noauth");

		const res = await request(app).post(`/api/v1/listings/${listingId}/save`);

		expect(res.status).toBe(401);
	});
});

describe("GET /listings/me/saved", () => {
	test("returns the caller's saved listings, most recently saved first", async () => {
		const { agent: saverAgent } = await registerStudent({ email: uniqueEmail("mysaved-order-saver") });
		const { listingId: firstListingId } = await createPosterWithListing("mysaved-order-poster-1");
		const { listingId: secondListingId } = await createPosterWithListing("mysaved-order-poster-2");

		await saverAgent.post(`/api/v1/listings/${firstListingId}/save`);
		await saverAgent.post(`/api/v1/listings/${secondListingId}/save`);

		const res = await saverAgent.get("/api/v1/listings/me/saved");

		expect(res.status).toBe(200);
		expect(res.body.data.items).toHaveLength(2);
		expect(res.body.data.items[0].listing_id).toBe(secondListingId);
		expect(res.body.data.items[1].listing_id).toBe(firstListingId);
	});

	test("excludes an unsaved listing", async () => {
		const { agent: saverAgent } = await registerStudent({ email: uniqueEmail("mysaved-exclude-saver") });
		const { listingId } = await createPosterWithListing("mysaved-exclude-poster");

		await saverAgent.post(`/api/v1/listings/${listingId}/save`);
		await saverAgent.delete(`/api/v1/listings/${listingId}/save`);

		const res = await saverAgent.get("/api/v1/listings/me/saved");

		expect(res.status).toBe(200);
		expect(res.body.data.items).toEqual([]);
	});

	test("excludes a listing that became inactive after being saved", async () => {
		const { agent: posterAgent, listingId } = await createPosterWithListing("mysaved-inactive-poster");
		const { agent: saverAgent } = await registerStudent({ email: uniqueEmail("mysaved-inactive-saver") });
		await saverAgent.post(`/api/v1/listings/${listingId}/save`);

		await posterAgent.patch(`/api/v1/listings/${listingId}/status`).send({ status: "deactivated" });

		const res = await saverAgent.get("/api/v1/listings/me/saved");

		expect(res.status).toBe(200);
		expect(res.body.data.items).toEqual([]);
	});

	test("does not include another user's saved listings", async () => {
		const { agent: saverAAgent } = await registerStudent({ email: uniqueEmail("mysaved-isolation-a") });
		const { agent: saverBAgent } = await registerStudent({ email: uniqueEmail("mysaved-isolation-b") });
		const { listingId } = await createPosterWithListing("mysaved-isolation-poster");

		await saverAAgent.post(`/api/v1/listings/${listingId}/save`);

		const res = await saverBAgent.get("/api/v1/listings/me/saved");

		expect(res.status).toBe(200);
		expect(res.body.data.items).toEqual([]);
	});

	test("supports cursor pagination", async () => {
		const { agent: saverAgent } = await registerStudent({ email: uniqueEmail("mysaved-paginate-saver") });

		for (let i = 0; i < 3; i++) {
			const { listingId } = await createPosterWithListing(`mysaved-paginate-poster-${i}`);
			await saverAgent.post(`/api/v1/listings/${listingId}/save`);
		}

		const firstPage = await saverAgent.get("/api/v1/listings/me/saved").query({ limit: 2 });
		expect(firstPage.status).toBe(200);
		expect(firstPage.body.data.items).toHaveLength(2);
		expect(firstPage.body.data.nextCursor).not.toBeNull();

		const secondPage = await saverAgent.get("/api/v1/listings/me/saved").query({
			limit: 2,
			cursorTime: firstPage.body.data.nextCursor.cursorTime,
			cursorId: firstPage.body.data.nextCursor.cursorId,
		});
		expect(secondPage.status).toBe(200);
		expect(secondPage.body.data.items).toHaveLength(1);

		const firstIds = firstPage.body.data.items.map((i) => i.listing_id);
		const secondIds = secondPage.body.data.items.map((i) => i.listing_id);
		expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
	});

	test("a pg_owner cannot hit the student-only saved-listings route", async () => {
		const { registerPgOwner } = await import("../setup/testAuth.js");
		const { agent: ownerAgent } = await registerPgOwner({ email: `mysaved-owner-${Date.now()}@business.test` });

		const res = await ownerAgent.get("/api/v1/listings/me/saved");

		expect(res.status).toBe(403);
	});

	test("requires authentication", async () => {
		const res = await request(app).get("/api/v1/listings/me/saved");
		expect(res.status).toBe(401);
	});
});
