// tests/suites/17-referenceData.test.js
//
// Covers: GET /preferences/meta, GET /amenities, GET /rent-index,
// GET /pincodes/:pincode.
//
// All four are pure read-only reference-data lookups — no state machines,
// no ownership checks. Lowest risk in the suite, per the rollout plan
// (Tier 4, "done last").
//
// Reference rows for amenities/rent-index/pincodes are never present by
// default in the test DB (resetDb() truncates everything each test, and
// amenities.js / pincodes.js are one-time ETL scripts, not migrations — see
// 06-properties.test.js and 08-listings-search.test.js, which already
// establish the pattern of seeding these tables directly via SQL per test).
//
// rent_index is deliberately never written by application code (see
// migrations/006's comment: "Materialised rent index — upserted by cron,
// never written from app code") so it's seeded directly here too, mirroring
// how src/cron/rentIndexRefresh.js's own INSERT shape looks.

import request from "supertest";
import { app } from "../../src/app.js";
import { registerStudent } from "../setup/testAuth.js";
import { pool } from "../../src/db/client.js";

const uniqueEmail = (label) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@college.edu`;

describe("GET /preferences/meta", () => {
	test("returns the full set of preference definitions with their allowed values", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("prefmeta-ok") });

		const res = await agent.get("/api/v1/preferences/meta");

		expect(res.status).toBe(200);
		expect(Array.isArray(res.body.data.preferences)).toBe(true);
		expect(res.body.data.preferences.length).toBeGreaterThan(0);

		const smoking = res.body.data.preferences.find((p) => p.preferenceKey === "smoking");
		expect(smoking).toBeDefined();
		expect(smoking.values.map((v) => v.value)).toEqual(expect.arrayContaining(["non_smoker", "smoker"]));
	});

	test("includes all seven known preference keys", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("prefmeta-keys") });

		const res = await agent.get("/api/v1/preferences/meta");

		const keys = res.body.data.preferences.map((p) => p.preferenceKey).sort();
		expect(keys).toEqual(
			[
				"alcohol",
				"cleanliness_level",
				"food_habit",
				"guest_policy",
				"noise_tolerance",
				"sleep_schedule",
				"smoking",
			].sort(),
		);
	});

	test("requires authentication", async () => {
		const res = await request(app).get("/api/v1/preferences/meta");
		expect(res.status).toBe(401);
	});
});

describe("GET /amenities", () => {
	test("returns an empty list when no amenities are seeded", async () => {
		const res = await request(app).get("/api/v1/amenities");

		expect(res.status).toBe(200);
		expect(res.body.data.items).toEqual([]);
	});

	test("returns seeded amenities ordered by category (enum declaration order) then name", async () => {
		await pool.query(
			`INSERT INTO amenities (name, category, icon_name) VALUES
         ('Zebra Utility', 'utility', 'zebra'),
         ('Alpha Utility', 'utility', 'alpha'),
         ('Gym', 'comfort', 'gym')`,
		);

		const res = await request(app).get("/api/v1/amenities");

		expect(res.status).toBe(200);
		expect(res.body.data.items).toHaveLength(3);

		const names = res.body.data.items.map((a) => a.name);
		// amenity_category_enum is declared as ('utility', 'safety', 'comfort')
		// in migration 001 — Postgres orders ENUM values by declaration
		// position, not string collation, so 'utility' sorts before 'comfort'.
		// Within utility, Alpha comes before Zebra by name.
		expect(names).toEqual(["Alpha Utility", "Zebra Utility", "Gym"]);
	});

	test("does not require authentication", async () => {
		await pool.query(`INSERT INTO amenities (name, category) VALUES ('WiFi', 'utility')`);

		const res = await request(app).get("/api/v1/amenities");

		expect(res.status).toBe(200);
		expect(res.body.data.items).toHaveLength(1);
	});

	test("each item exposes amenityId, name, category, and iconName", async () => {
		await pool.query(`INSERT INTO amenities (name, category, icon_name) VALUES ('Parking', 'comfort', 'parking')`);

		const res = await request(app).get("/api/v1/amenities");

		expect(res.body.data.items[0]).toMatchObject({
			amenityId: expect.any(String),
			name: "Parking",
			category: "comfort",
			iconName: "parking",
		});
	});
});

describe("GET /rent-index", () => {
	const seedRentIndex = async ({ city, locality = null, roomType = "single", p25, p50, p75, sampleCount = 10 }) => {
		await pool.query(
			`INSERT INTO rent_index (city, locality, room_type, p25, p50, p75, sample_count)
       VALUES ($1, $2, $3::room_type_enum, $4, $5, $6, $7)`,
			[city, locality, roomType, p25, p50, p75, sampleCount],
		);
	};

	test("resolves a locality-level row when one exists", async () => {
		await seedRentIndex({
			city: "delhi",
			locality: "hauz khas",
			roomType: "single",
			p25: 500000,
			p50: 600000,
			p75: 700000,
		});

		const res = await request(app)
			.get("/api/v1/rent-index")
			.query({ city: "Delhi", locality: "Hauz Khas", roomType: "single" });

		expect(res.status).toBe(200);
		expect(res.body.data.resolution).toBe("locality");
		expect(res.body.data.p25).toBe(5000);
		expect(res.body.data.p50).toBe(6000);
		expect(res.body.data.p75).toBe(7000);
		expect(res.body.data.sampleCount).toBe(10);
	});

	test("falls back to the city-wide row when no locality-specific row matches", async () => {
		await seedRentIndex({
			city: "mumbai",
			locality: null,
			roomType: "double",
			p25: 800000,
			p50: 900000,
			p75: 1000000,
		});

		const res = await request(app)
			.get("/api/v1/rent-index")
			.query({ city: "Mumbai", locality: "Some Unknown Area", roomType: "double" });

		expect(res.status).toBe(200);
		expect(res.body.data.resolution).toBe("city");
		expect(res.body.data.p50).toBe(9000);
	});

	test("404 when neither a locality nor a city-wide row exists for the combination", async () => {
		// rentIndex.controller.js requires city, locality, AND roomType to all
		// be present (its own manual pre-check ahead of the service call) even
		// though the locality field is .optional() at the Zod validator layer —
		// omitting locality trips that controller-level 400 before the service's
		// city-wide-fallback logic ever runs. Supply a real-but-unseeded
		// locality here so the request reaches the service and exercises the
		// intended "no matching data" 404 path instead.
		const res = await request(app)
			.get("/api/v1/rent-index")
			.query({ city: "NoDataCity", locality: "Nowhere", roomType: "entire_flat" });

		expect(res.status).toBe(404);
	});

	test("normalizes city/locality casing and whitespace before lookup", async () => {
		await seedRentIndex({
			city: "pune",
			locality: "kothrud",
			roomType: "triple",
			p25: 400000,
			p50: 500000,
			p75: 600000,
		});

		const res = await request(app)
			.get("/api/v1/rent-index")
			.query({ city: "  PUNE  ", locality: "  Kothrud ", roomType: "triple" });

		expect(res.status).toBe(200);
		expect(res.body.data.resolution).toBe("locality");
	});

	test("400 when required query parameters are missing", async () => {
		const res = await request(app).get("/api/v1/rent-index").query({ city: "Delhi" });

		expect(res.status).toBe(400);
	});

	test("400 for an invalid roomType", async () => {
		const res = await request(app).get("/api/v1/rent-index").query({ city: "Delhi", roomType: "mansion" });

		expect(res.status).toBe(400);
	});

	test("does not require authentication", async () => {
		await seedRentIndex({
			city: "guestcity",
			locality: null,
			roomType: "single",
			p25: 100000,
			p50: 200000,
			p75: 300000,
		});

		// See the note above — the controller's manual pre-check requires
		// locality to be present, so it must be supplied even though the
		// city-wide fallback is what actually resolves this lookup.
		const res = await request(app)
			.get("/api/v1/rent-index")
			.query({ city: "guestcity", locality: "AnyLocality", roomType: "single" });

		expect(res.status).toBe(200);
	});
});

describe("GET /pincodes/:pincode", () => {
	const seedPincode = async (pincode, overrides = {}) => {
		await pool.query(
			`INSERT INTO pincodes (pincode, city, district, state, latitude, longitude, office_count, resolution)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			[
				pincode,
				overrides.city ?? "Test City",
				overrides.district ?? "Test District",
				overrides.state ?? "Delhi",
				overrides.latitude ?? 28.6139,
				overrides.longitude ?? 77.209,
				overrides.officeCount ?? 1,
				overrides.resolution ?? "priority",
			],
		);
	};

	test("returns the pincode's resolved location", async () => {
		await seedPincode("110001", { city: "New Delhi GPO", latitude: 28.6139, longitude: 77.209 });

		const res = await request(app).get("/api/v1/pincodes/110001");

		expect(res.status).toBe(200);
		expect(res.body.data.pincode).toBe("110001");
		expect(res.body.data.city).toBe("New Delhi GPO");
		expect(Number(res.body.data.latitude)).toBeCloseTo(28.6139);
		expect(Number(res.body.data.longitude)).toBeCloseTo(77.209);
	});

	test("404 for a pincode not present in the reference table", async () => {
		const res = await request(app).get("/api/v1/pincodes/999999");

		expect(res.status).toBe(404);
	});

	test("400 for a malformed pincode (not exactly 6 digits)", async () => {
		const res = await request(app).get("/api/v1/pincodes/12345");

		expect(res.status).toBe(400);
	});

	test("400 for a non-numeric pincode", async () => {
		const res = await request(app).get("/api/v1/pincodes/abcdef");

		expect(res.status).toBe(400);
	});

	test("does not require authentication", async () => {
		await seedPincode("400001");

		const res = await request(app).get("/api/v1/pincodes/400001");

		expect(res.status).toBe(200);
	});
});
