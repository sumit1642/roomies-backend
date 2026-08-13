// tests/suites/08-listings-search.test.js
//
// Covers: GET /listings search filters — city, rent range, room/bed type,
// gender, amenities, lat/lng proximity, pincode resolution, cursor
// pagination (recent + compatibility sort).
//
// No dependency on 17-referenceData's own HTTP endpoints — searchListings()
// reads amenities/pincodes/rent_index/preferences tables directly via SQL,
// never through GET /amenities, GET /pincodes/:pincode, GET /rent-index, or
// GET /preferences/meta. Reference rows are seeded directly via SQL, same
// pattern already established in 06-properties.test.js for amenities.
//
// Fixture mix: both student_room (own lat/lng) and pg_room (location
// inherited from parent property) listings are used, per the property
// location-fallback path in searchListings' proximity clause:
//   (l.location IS NOT NULL AND ST_DWithin(l.location, point, radius))
//   OR (l.location IS NULL AND p.location IS NOT NULL AND ST_DWithin(p.location, point, radius))

import request from "supertest";
import { app } from "../../src/app.js";
import { registerStudent, registerPgOwner } from "../setup/testAuth.js";
import { pool } from "../../src/db/client.js";

const uniqueEmail = (label, domain = "college.edu") =>
	`${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@${domain}`;

const verifyOwner = async (userId) => {
	await pool.query(
		`UPDATE pg_owner_profiles SET verification_status = 'verified', verified_at = NOW() WHERE user_id = $1`,
		[userId],
	);
};

const registerVerifiedPgOwner = async (label) => {
	const result = await registerPgOwner({ email: uniqueEmail(label, "business.test") });
	await verifyOwner(result.user.userId);
	return result;
};

// Delhi coordinates as the default anchor — matches other suites' convention.
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

const createOwnedProperty = async (agent, overrides = {}) => {
	const res = await agent.post("/api/v1/properties").send({
		propertyName: "Test PG",
		propertyType: "pg",
		addressLine: "123 MG Road",
		city: "Pune",
		latitude: 18.5204,
		longitude: 73.8567,
		...overrides,
	});
	if (res.status !== 201) {
		throw new Error(`createOwnedProperty failed (${res.status}): ${JSON.stringify(res.body)}`);
	}
	return res.body.data.property_id;
};

const pgRoomBody = (propertyId, overrides = {}) => ({
	listingType: "pg_room",
	propertyId,
	title: "Sunny single occupancy room",
	rentPerMonth: 8000,
	roomType: "single",
	totalCapacity: 1,
	availableFrom: "2026-09-01",
	...overrides,
});

const createStudentListing = async (label, overrides = {}) => {
	const { agent, user } = await registerStudent({ email: uniqueEmail(label) });
	const res = await agent.post("/api/v1/listings").send(studentRoomBody(overrides));
	if (res.status !== 201) {
		throw new Error(`createStudentListing failed (${res.status}): ${JSON.stringify(res.body)}`);
	}
	return { agent, user, listing: res.body.data };
};

const createPgRoomListing = async (label, propertyOverrides = {}, listingOverrides = {}) => {
	const { agent, user } = await registerVerifiedPgOwner(label);
	const propertyId = await createOwnedProperty(agent, propertyOverrides);
	const res = await agent.post("/api/v1/listings").send(pgRoomBody(propertyId, listingOverrides));
	if (res.status !== 201) {
		throw new Error(`createPgRoomListing failed (${res.status}): ${JSON.stringify(res.body)}`);
	}
	return { agent, user, propertyId, listing: res.body.data };
};

const seedAmenities = async (names) => {
	const placeholders = names.map((_, i) => `($${i + 1}, 'utility')`).join(", ");
	const { rows } = await pool.query(
		`INSERT INTO amenities (name, category) VALUES ${placeholders} RETURNING amenity_id, name`,
		names,
	);
	return Object.fromEntries(rows.map((r) => [r.name, r.amenity_id]));
};

const attachAmenities = async (listingId, amenityIds) => {
	if (!amenityIds.length) return;
	const placeholders = amenityIds.map((_, i) => `($1, $${i + 2})`).join(", ");
	await pool.query(`INSERT INTO listing_amenities (listing_id, amenity_id) VALUES ${placeholders}`, [
		listingId,
		...amenityIds,
	]);
};

const seedPincode = async (pincode, { city, latitude, longitude, state = "Delhi" } = {}) => {
	await pool.query(
		`INSERT INTO pincodes (pincode, city, state, latitude, longitude, office_count, resolution)
     VALUES ($1, $2, $3, $4, $5, 1, 'priority')
     ON CONFLICT (pincode) DO NOTHING`,
		[pincode, city, state, latitude, longitude],
	);
};

describe("GET /listings — city filter", () => {
	test("matches listings whose city starts with the query (case-insensitive prefix)", async () => {
		await createStudentListing("city-delhi", { city: "Delhi" });
		await createStudentListing("city-mumbai", { city: "Mumbai" });

		const res = await request(app).get("/api/v1/listings").query({ city: "del" });

		expect(res.status).toBe(200);
		expect(res.body.data.items.length).toBeGreaterThanOrEqual(1);
		expect(res.body.data.items.every((i) => i.city.toLowerCase().startsWith("del"))).toBe(true);
	});

	test("does not match a city substring that is not a prefix", async () => {
		await createStudentListing("city-nonprefix", { city: "New Delhi" });

		const res = await request(app).get("/api/v1/listings").query({ city: "delhi" });

		// "delhi" is not a prefix of "New Delhi" — searchListings uses LIKE 'query%'
		const matched = res.body.data.items.some((i) => i.city === "New Delhi");
		expect(matched).toBe(false);
	});

	test("escapes special LIKE characters in the city query safely", async () => {
		const res = await request(app).get("/api/v1/listings").query({ city: "100%_test" });

		expect(res.status).toBe(200);
		expect(res.body.data.items).toEqual([]);
	});

	test("pg_room listing's city is inherited from its property", async () => {
		await createPgRoomListing("city-pgroom", { city: "Jaipur" });

		const res = await request(app).get("/api/v1/listings").query({ city: "Jaipur" });

		expect(res.status).toBe(200);
		expect(res.body.data.items.some((i) => i.city === "Jaipur")).toBe(true);
	});
});

describe("GET /listings — rent range filter", () => {
	test("filters by minRent and maxRent (rupees, converted to paise internally)", async () => {
		await createStudentListing("rent-low", { rentPerMonth: 3000, city: "RentCityA" });
		await createStudentListing("rent-mid", { rentPerMonth: 6000, city: "RentCityA" });
		await createStudentListing("rent-high", { rentPerMonth: 12000, city: "RentCityA" });

		const res = await request(app)
			.get("/api/v1/listings")
			.query({ city: "RentCityA", minRent: 5000, maxRent: 8000 });

		expect(res.status).toBe(200);
		expect(res.body.data.items).toHaveLength(1);
		expect(res.body.data.items[0].rentPerMonth).toBe(6000);
	});

	test("minRent alone excludes cheaper listings", async () => {
		await createStudentListing("rent-minonly-low", { rentPerMonth: 2000, city: "RentCityB" });
		await createStudentListing("rent-minonly-high", { rentPerMonth: 9000, city: "RentCityB" });

		const res = await request(app).get("/api/v1/listings").query({ city: "RentCityB", minRent: 5000 });

		expect(res.status).toBe(200);
		expect(res.body.data.items.every((i) => i.rentPerMonth >= 5000)).toBe(true);
	});

	test("rejects minRent greater than maxRent with 400", async () => {
		const res = await request(app).get("/api/v1/listings").query({ minRent: 9000, maxRent: 1000 });

		expect(res.status).toBe(400);
	});
});

describe("GET /listings — room type / bed type / gender filters", () => {
	test("filters by roomType", async () => {
		await createStudentListing("roomtype-single", { roomType: "single", city: "RoomTypeCity" });
		await createStudentListing("roomtype-double", { roomType: "double", city: "RoomTypeCity" });

		const res = await request(app).get("/api/v1/listings").query({ city: "RoomTypeCity", roomType: "double" });

		expect(res.status).toBe(200);
		expect(res.body.data.items.every((i) => i.room_type === "double")).toBe(true);
	});

	test("filters by bedType", async () => {
		await createStudentListing("bedtype-single", { bedType: "single_bed", city: "BedTypeCity" });
		await createStudentListing("bedtype-bunk", { bedType: "bunk_bed", city: "BedTypeCity" });

		const res = await request(app).get("/api/v1/listings").query({ city: "BedTypeCity", bedType: "bunk_bed" });

		expect(res.status).toBe(200);
		expect(res.body.data.items.length).toBeGreaterThanOrEqual(1);
	});

	test("preferredGender filter includes listings with a matching gender OR no preference set", async () => {
		await createStudentListing("gender-female", { preferredGender: "female", city: "GenderCity" });
		await createStudentListing("gender-none", { city: "GenderCity" });
		await createStudentListing("gender-male", { preferredGender: "male", city: "GenderCity" });

		const res = await request(app).get("/api/v1/listings").query({ city: "GenderCity", preferredGender: "female" });

		expect(res.status).toBe(200);
		const genders = res.body.data.items.map((i) => i.preferred_gender);
		expect(genders.every((g) => g === "female" || g === null)).toBe(true);
		expect(genders).not.toContain("male");
	});
});

describe("GET /listings — amenities filter", () => {
	test("returns only listings that have ALL requested amenities", async () => {
		const amenities = await seedAmenities([`WiFi-${Date.now()}`, `Parking-${Date.now()}`, `Gym-${Date.now()}`]);
		const amenityIds = Object.values(amenities);

		const { listing: bothListing } = await createStudentListing("amenity-both", { city: "AmenityCity" });
		await attachAmenities(bothListing.listing_id, [amenityIds[0], amenityIds[1]]);

		const { listing: oneListing } = await createStudentListing("amenity-one", { city: "AmenityCity" });
		await attachAmenities(oneListing.listing_id, [amenityIds[0]]);

		const res = await request(app)
			.get("/api/v1/listings")
			.query({ city: "AmenityCity", amenityIds: [amenityIds[0], amenityIds[1]].join(",") });

		expect(res.status).toBe(200);
		const ids = res.body.data.items.map((i) => i.listing_id);
		expect(ids).toContain(bothListing.listing_id);
		expect(ids).not.toContain(oneListing.listing_id);
	});

	test("rejects a malformed amenityId with 400", async () => {
		const res = await request(app).get("/api/v1/listings").query({ amenityIds: "not-a-uuid" });

		expect(res.status).toBe(400);
	});

	test("empty amenityIds does not filter results", async () => {
		await createStudentListing("amenity-empty-filter", { city: "AmenityEmptyCity" });

		const res = await request(app).get("/api/v1/listings").query({ city: "AmenityEmptyCity" });

		expect(res.status).toBe(200);
		expect(res.body.data.items.length).toBeGreaterThanOrEqual(1);
	});
});

describe("GET /listings — lat/lng proximity search", () => {
	test("finds a student_room listing within radius using its own location", async () => {
		// Delhi anchor, listing 1km away roughly.
		await createStudentListing("proximity-student", {
			latitude: 28.62,
			longitude: 77.21,
			city: "ProximityStudentCity",
		});

		const res = await request(app).get("/api/v1/listings").query({
			lat: 28.6139,
			lng: 77.209,
			radius: 10000,
		});

		expect(res.status).toBe(200);
		expect(res.body.data.items.some((i) => i.city === "ProximityStudentCity")).toBe(true);
	});

	test("finds a pg_room listing via its property's inherited location", async () => {
		await createPgRoomListing(
			"proximity-pgroom",
			{ city: "ProximityPgCity", latitude: 18.5204, longitude: 73.8567 },
			{},
		);

		const res = await request(app).get("/api/v1/listings").query({
			lat: 18.5204,
			lng: 73.8567,
			radius: 5000,
		});

		expect(res.status).toBe(200);
		expect(res.body.data.items.some((i) => i.city === "ProximityPgCity")).toBe(true);
	});

	test("excludes listings outside the radius", async () => {
		await createStudentListing("proximity-far", {
			latitude: 12.9716, // Bengaluru — far from Delhi
			longitude: 77.5946,
			city: "ProximityFarCity",
		});

		const res = await request(app).get("/api/v1/listings").query({
			lat: 28.6139,
			lng: 77.209,
			radius: 5000,
		});

		expect(res.status).toBe(200);
		expect(res.body.data.items.some((i) => i.city === "ProximityFarCity")).toBe(false);
	});

	test("rejects lat without lng", async () => {
		const res = await request(app).get("/api/v1/listings").query({ lat: 28.6139 });

		expect(res.status).toBe(400);
	});

	test("rejects a radius below the minimum (100m)", async () => {
		const res = await request(app).get("/api/v1/listings").query({ lat: 28.6139, lng: 77.209, radius: 10 });

		expect(res.status).toBe(400);
	});
});

describe("GET /listings — pincode resolution", () => {
	test("resolves a pincode to lat/lng and applies proximity filtering", async () => {
		const pincode = "110001";
		await seedPincode(pincode, { city: "PincodeResolveCity", latitude: 28.6139, longitude: 77.209 });

		await createStudentListing("pincode-nearby", {
			latitude: 28.62,
			longitude: 77.21,
			city: "PincodeResolveCity",
		});

		const res = await request(app).get("/api/v1/listings").query({ pincode, radius: 10000 });

		expect(res.status).toBe(200);
		expect(res.body.data.items.some((i) => i.city === "PincodeResolveCity")).toBe(true);
	});

	test("falls back gracefully (no proximity filter) when the pincode is not found in the reference table", async () => {
		await createStudentListing("pincode-notfound", { city: "PincodeNotFoundCity" });

		const res = await request(app)
			.get("/api/v1/listings")
			.query({ pincode: "999999", city: "PincodeNotFoundCity" });

		// getPincode() throws a 404 AppError internally, which searchListings
		// catches and logs, proceeding without the proximity filter — the
		// overall request should still succeed (200), not surface the 404.
		expect(res.status).toBe(200);
		expect(res.body.data.items.some((i) => i.city === "PincodeNotFoundCity")).toBe(true);
	});

	test("lat/lng takes precedence over pincode when both are provided", async () => {
		const pincode = "400001";
		await seedPincode(pincode, { city: "PincodePrecedenceWrong", latitude: 19.076, longitude: 72.8777 }); // Mumbai

		await createStudentListing("pincode-precedence-correct", {
			latitude: 28.6139,
			longitude: 77.209,
			city: "PincodePrecedenceCity",
		});

		// Explicit lat/lng (Delhi) should win over the pincode's Mumbai location.
		const res = await request(app).get("/api/v1/listings").query({
			lat: 28.6139,
			lng: 77.209,
			pincode,
			radius: 5000,
		});

		expect(res.status).toBe(200);
		expect(res.body.data.items.some((i) => i.city === "PincodePrecedenceCity")).toBe(true);
	});

	test("rejects a malformed pincode with 400", async () => {
		const res = await request(app).get("/api/v1/listings").query({ pincode: "12" });

		expect(res.status).toBe(400);
	});
});

describe("GET /listings — cursor pagination (recent sort)", () => {
	test("paginates through all created listings with no gaps or duplicates", async () => {
		const cityTag = `PaginateRecentCity-${Date.now()}`;
		const createdIds = new Set();
		for (let i = 0; i < 5; i++) {
			const { listing } = await createStudentListing(`paginate-recent-${i}`, { city: cityTag });
			createdIds.add(listing.listing_id);
		}

		const seenIds = [];
		let cursorTime, cursorId;
		let guard = 0;

		while (true) {
			guard++;
			if (guard > 20) throw new Error("pagination guard exceeded — possible infinite loop");

			const query = { city: cityTag, limit: 2 };
			if (cursorTime !== undefined) {
				query.cursorTime = cursorTime;
				query.cursorId = cursorId;
			}

			const page = await request(app).get("/api/v1/listings").query(query);
			expect(page.status).toBe(200);

			for (const item of page.body.data.items) {
				if (createdIds.has(item.listing_id)) seenIds.push(item.listing_id);
			}

			if (!page.body.data.nextCursor) break;
			cursorTime = page.body.data.nextCursor.cursorTime;
			cursorId = page.body.data.nextCursor.cursorId;
		}

		expect(seenIds.sort()).toEqual([...createdIds].sort());
	});

	test("rejects cursorTime without cursorId", async () => {
		const res = await request(app).get("/api/v1/listings").query({ cursorTime: new Date().toISOString() });

		expect(res.status).toBe(400);
	});
});

describe("GET /listings — compatibility sort", () => {
	test("authenticated user with preferences sees compatibilityScore reflecting shared preferences", async () => {
		const { agent: viewerAgent, user: viewer } = await registerStudent({ email: uniqueEmail("compat-viewer") });
		await viewerAgent.put(`/api/v1/students/${viewer.userId}/preferences`).send({
			preferences: [
				{ preferenceKey: "smoking", preferenceValue: "non_smoker" },
				{ preferenceKey: "food_habit", preferenceValue: "vegetarian" },
			],
		});

		const cityTag = `CompatCity-${Date.now()}`;
		const { agent: posterAgent, listing: matchListing } = await createStudentListing("compat-match-poster", {
			city: cityTag,
		});
		await posterAgent.put(`/api/v1/listings/${matchListing.listing_id}/preferences`).send({
			preferences: [{ preferenceKey: "smoking", preferenceValue: "non_smoker" }],
		});

		const { listing: noMatchListing } = await createStudentListing("compat-nomatch-poster", { city: cityTag });

		const res = await viewerAgent.get("/api/v1/listings").query({ city: cityTag, sortBy: "compatibility" });

		expect(res.status).toBe(200);
		const matchItem = res.body.data.items.find((i) => i.listing_id === matchListing.listing_id);
		const noMatchItem = res.body.data.items.find((i) => i.listing_id === noMatchListing.listing_id);
		expect(matchItem).toBeDefined();
		expect(noMatchItem).toBeDefined();
		expect(matchItem.compatibilityScore).toBeGreaterThan(noMatchItem.compatibilityScore);
	});

	test("guest (unauthenticated) sees compatibilityScore of 0 for all items", async () => {
		const cityTag = `CompatGuestCity-${Date.now()}`;
		await createStudentListing("compat-guest", { city: cityTag });

		const res = await request(app).get("/api/v1/listings").query({ city: cityTag, sortBy: "compatibility" });

		expect(res.status).toBe(200);
		expect(res.body.data.items.every((i) => i.compatibilityScore === 0)).toBe(true);
	});

	test("compatibility sort uses cursorScore, not cursorTime — providing cursorTime is rejected", async () => {
		const res = await request(app)
			.get("/api/v1/listings")
			.query({
				sortBy: "compatibility",
				cursorTime: new Date().toISOString(),
				cursorId: "00000000-0000-0000-0000-000000000000",
			});

		expect(res.status).toBe(400);
	});

	test("paginates compatibility-sorted results using cursorScore + cursorId", async () => {
		const cityTag = `CompatPaginateCity-${Date.now()}`;
		const createdIds = new Set();
		for (let i = 0; i < 3; i++) {
			const { listing } = await createStudentListing(`compat-paginate-${i}`, { city: cityTag });
			createdIds.add(listing.listing_id);
		}

		const firstPage = await request(app)
			.get("/api/v1/listings")
			.query({ city: cityTag, sortBy: "compatibility", limit: 2 });

		expect(firstPage.status).toBe(200);
		expect(firstPage.body.data.items).toHaveLength(2);
		expect(firstPage.body.data.nextCursor).not.toBeNull();
		expect(firstPage.body.data.nextCursor).toHaveProperty("cursorScore");
		expect(firstPage.body.data.nextCursor).toHaveProperty("cursorId");

		const secondPage = await request(app).get("/api/v1/listings").query({
			city: cityTag,
			sortBy: "compatibility",
			limit: 2,
			cursorScore: firstPage.body.data.nextCursor.cursorScore,
			cursorId: firstPage.body.data.nextCursor.cursorId,
		});

		expect(secondPage.status).toBe(200);
		expect(secondPage.body.data.items).toHaveLength(1);

		const firstIds = firstPage.body.data.items.map((i) => i.listing_id);
		const secondIds = secondPage.body.data.items.map((i) => i.listing_id);
		expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
	});
});

describe("GET /listings — guest listing gate", () => {
	test("an unauthenticated guest's limit is capped at 20 even if a higher value is requested", async () => {
		const res = await request(app).get("/api/v1/listings").query({ limit: 100 });

		// guestListingGate clamps req.query.limit to 20 before validate() would
		// otherwise allow up to 100 for an authenticated user. Since
		// searchListingsSchema's own validate() already ran and set limit=100,
		// but guestListingGate runs AFTER validate() in the route chain
		// (optionalAuthenticate -> validate -> guestListingGate -> searchListings),
		// confirm the response never exceeds 20 items regardless.
		expect(res.status).toBe(200);
		expect(res.body.data.items.length).toBeLessThanOrEqual(20);
	});

	test("an authenticated user can request up to the validator's max of 100", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("gate-authed") });

		const res = await agent.get("/api/v1/listings").query({ limit: 100 });

		expect(res.status).toBe(200);
	});

	test("rejects a limit over the validator's hard cap of 100 with 400", async () => {
		const res = await request(app).get("/api/v1/listings").query({ limit: 500 });

		expect(res.status).toBe(400);
	});
});

describe("GET /listings — general filtering behavior", () => {
	test("only returns active, non-expired, non-deleted listings", async () => {
		const cityTag = `ActiveOnlyCity-${Date.now()}`;
		const { listing: activeListing } = await createStudentListing("active-only-active", {
			city: cityTag,
		});
		const { agent: deactivatedPosterAgent, listing: deactivatedListing } = await createStudentListing(
			"active-only-deactivated",
			{ city: cityTag },
		);
		const deactivateRes = await deactivatedPosterAgent
			.patch(`/api/v1/listings/${deactivatedListing.listing_id}/status`)
			.send({ status: "deactivated" });
		expect(deactivateRes.status).toBe(200);

		const res = await request(app).get("/api/v1/listings").query({ city: cityTag });

		expect(res.status).toBe(200);
		const ids = res.body.data.items.map((i) => i.listing_id);
		expect(ids).toContain(activeListing.listing_id);
		expect(ids).not.toContain(deactivatedListing.listing_id);
	});

	test("filters by listingType", async () => {
		const cityTag = `ListingTypeCity-${Date.now()}`;
		await createStudentListing("listingtype-student", { city: cityTag });
		await createPgRoomListing("listingtype-pg", { city: cityTag });

		const res = await request(app).get("/api/v1/listings").query({ city: cityTag, listingType: "student_room" });

		expect(res.status).toBe(200);
		expect(res.body.data.items.every((i) => i.listing_type === "student_room")).toBe(true);
	});

	test("filters by availableFrom (listing must be available on/before the given date)", async () => {
		const cityTag = `AvailFromCity-${Date.now()}`;
		await createStudentListing("availfrom-early", { city: cityTag, availableFrom: "2026-08-01" });
		await createStudentListing("availfrom-late", { city: cityTag, availableFrom: "2026-12-01" });

		const res = await request(app).get("/api/v1/listings").query({ city: cityTag, availableFrom: "2026-09-01" });

		expect(res.status).toBe(200);
		expect(res.body.data.items.every((i) => i.available_from <= "2026-09-01")).toBe(true);
	});

	test("works without authentication (guest search)", async () => {
		const res = await request(app).get("/api/v1/listings");

		expect(res.status).toBe(200);
		expect(Array.isArray(res.body.data.items)).toBe(true);
	});
});
