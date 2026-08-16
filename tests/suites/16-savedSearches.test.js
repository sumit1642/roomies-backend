// tests/suites/16-savedSearches.test.js
//
// Covers: create (incl. the 10-cap trigger), list, update, delete.
//
// Fully synchronous CRUD against saved_searches — no BullMQ/worker
// involvement, unlike 15-notifications. The one piece of real behavior worth
// deliberate coverage is the 10-saved-searches-per-user cap, which is
// enforced in TWO places that have to agree:
//   1. An application-level COUNT(*) check inside createSavedSearch's
//      transaction (savedSearch.service.js), gated behind a
//      pg_advisory_xact_lock(hashtext(userId)) to avoid a TOCTOU race between
//      concurrent creates for the same user.
//   2. A DB trigger (enforce_saved_search_cap, migration 010) that
//      independently re-checks the same 10-row limit and raises a Postgres
//      exception (ERRCODE 23514) if the app-level check is ever bypassed.
// createSavedSearch's catch block specifically maps that trigger's
// (23514, saved_searches_active_cap_per_user) back into the same 422
// AppError the app-level check throws — so a test that hits exactly 10 rows
// and then attempts an 11th create through the real endpoint exercises the
// app-level guard, while the trigger itself is defense-in-depth that isn't
// independently distinguishable from the outside without inspecting
// err.constraint, which application code already does for us.

import request from "supertest";
import { app } from "../../src/app.js";
import { registerStudent } from "../setup/testAuth.js";
import { pool } from "../../src/db/client.js";

const uniqueEmail = (label) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@college.edu`;

const basicFilters = (overrides = {}) => ({
	city: "Delhi",
	minRent: 5000,
	maxRent: 10000,
	roomType: "single",
	...overrides,
});

const createSearch = (agent, overrides = {}) =>
	agent.post("/api/v1/saved-searches").send({
		name: "My search",
		filters: basicFilters(),
		...overrides,
	});

describe("POST /saved-searches", () => {
	test("creates a saved search with the given name and filters", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("create-ok") });

		const res = await createSearch(agent, { name: "Cheap rooms near campus" });

		expect(res.status).toBe(201);
		expect(res.body.data.name).toBe("Cheap rooms near campus");
		expect(res.body.data.filters).toMatchObject({
			city: "Delhi",
			minRent: 5000,
			maxRent: 10000,
			roomType: "single",
		});
		expect(res.body.data.searchId).toEqual(expect.any(String));
		expect(res.body.data.lastAlertedAt).toBeNull();
	});

	test("accepts an empty filters object (all filter fields optional)", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("create-emptyfilters") });

		const res = await agent.post("/api/v1/saved-searches").send({ name: "Anything anywhere", filters: {} });

		expect(res.status).toBe(201);
		expect(res.body.data.filters).toMatchObject({ amenityIds: [] });
	});

	test("rejects minRent greater than maxRent", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("create-badrange") });

		const res = await createSearch(agent, { filters: basicFilters({ minRent: 10000, maxRent: 5000 }) });

		expect(res.status).toBe(400);
	});

	test("rejects an invalid roomType enum value", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("create-badroomtype") });

		const res = await createSearch(agent, { filters: basicFilters({ roomType: "mansion" }) });

		expect(res.status).toBe(400);
	});

	test("rejects a malformed amenityId", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("create-badamenity") });

		const res = await createSearch(agent, { filters: basicFilters({ amenityIds: ["not-a-uuid"] }) });

		expect(res.status).toBe(400);
	});

	test("rejects a missing name", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("create-noname") });

		const res = await agent.post("/api/v1/saved-searches").send({ filters: basicFilters() });

		expect(res.status).toBe(400);
	});

	test("rejects a name over 100 characters", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("create-longname") });

		const res = await createSearch(agent, { name: "x".repeat(101) });

		expect(res.status).toBe(400);
	});

	test("requires authentication", async () => {
		const res = await request(app).post("/api/v1/saved-searches").send({ name: "x", filters: {} });
		expect(res.status).toBe(401);
	});

	test("enforces the 10-saved-search cap per user", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("create-cap") });

		for (let i = 0; i < 10; i++) {
			const res = await createSearch(agent, { name: `Search ${i}` });
			expect(res.status).toBe(201);
		}

		const eleventh = await createSearch(agent, { name: "Search 11" });

		expect(eleventh.status).toBe(422);
		expect(eleventh.body.message).toMatch(/at most 10/i);

		const { rows } = await pool.query(
			`SELECT COUNT(*)::int AS cnt FROM saved_searches WHERE user_id = (
         SELECT user_id FROM users WHERE email = $1
       ) AND deleted_at IS NULL`,
			[(await pool.query(`SELECT email FROM users ORDER BY created_at DESC LIMIT 1`)).rows[0].email],
		);
		expect(rows[0].cnt).toBe(10);
	});

	test("deleting a search frees a slot under the 10-search cap", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("create-capfree") });

		const createdIds = [];
		for (let i = 0; i < 10; i++) {
			const res = await createSearch(agent, { name: `Search ${i}` });
			createdIds.push(res.body.data.searchId);
		}

		const blockedRes = await createSearch(agent, { name: "Should be blocked" });
		expect(blockedRes.status).toBe(422);

		const deleteRes = await agent.delete(`/api/v1/saved-searches/${createdIds[0]}`);
		expect(deleteRes.status).toBe(200);

		const afterFreeRes = await createSearch(agent, { name: "Should now succeed" });
		expect(afterFreeRes.status).toBe(201);
	});

	test("the cap is scoped per user, not global", async () => {
		const { agent: userAAgent } = await registerStudent({ email: uniqueEmail("create-capscope-a") });
		const { agent: userBAgent } = await registerStudent({ email: uniqueEmail("create-capscope-b") });

		for (let i = 0; i < 10; i++) {
			const res = await createSearch(userAAgent, { name: `A Search ${i}` });
			expect(res.status).toBe(201);
		}

		// User A is now at the cap; User B, a different user, must be unaffected.
		const bRes = await createSearch(userBAgent, { name: "B Search 1" });

		expect(bRes.status).toBe(201);
	});
});

describe("GET /saved-searches", () => {
	test("lists the caller's saved searches, most recently created first", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("list-order") });

		const first = await createSearch(agent, { name: "First" });
		const second = await createSearch(agent, { name: "Second" });

		const res = await agent.get("/api/v1/saved-searches");

		expect(res.status).toBe(200);
		expect(res.body.data).toHaveLength(2);
		expect(res.body.data[0].searchId).toBe(second.body.data.searchId);
		expect(res.body.data[1].searchId).toBe(first.body.data.searchId);
	});

	test("returns an empty array when the caller has no saved searches", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("list-empty") });

		const res = await agent.get("/api/v1/saved-searches");

		expect(res.status).toBe(200);
		expect(res.body.data).toEqual([]);
	});

	test("does not include another user's saved searches", async () => {
		const { agent: ownerAgent } = await registerStudent({ email: uniqueEmail("list-isolation-owner") });
		await createSearch(ownerAgent, { name: "Owner's search" });

		const { agent: strangerAgent } = await registerStudent({ email: uniqueEmail("list-isolation-stranger") });

		const res = await strangerAgent.get("/api/v1/saved-searches");

		expect(res.status).toBe(200);
		expect(res.body.data).toEqual([]);
	});

	test("does not include a soft-deleted search", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("list-excludedeleted") });
		const createRes = await createSearch(agent, { name: "To be deleted" });
		await agent.delete(`/api/v1/saved-searches/${createRes.body.data.searchId}`);

		const res = await agent.get("/api/v1/saved-searches");

		expect(res.status).toBe(200);
		expect(res.body.data).toEqual([]);
	});

	test("requires authentication", async () => {
		const res = await request(app).get("/api/v1/saved-searches");
		expect(res.status).toBe(401);
	});
});

describe("PATCH /saved-searches/:searchId", () => {
	test("updates the name only", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("update-name") });
		const createRes = await createSearch(agent, { name: "Original name" });

		const res = await agent
			.patch(`/api/v1/saved-searches/${createRes.body.data.searchId}`)
			.send({ name: "Renamed search" });

		expect(res.status).toBe(200);
		expect(res.body.data.name).toBe("Renamed search");
		expect(res.body.data.filters).toMatchObject({ city: "Delhi" });
	});

	test("updates the filters only", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("update-filters") });
		const createRes = await createSearch(agent, { name: "Keep this name" });

		const res = await agent
			.patch(`/api/v1/saved-searches/${createRes.body.data.searchId}`)
			.send({ filters: basicFilters({ city: "Mumbai", minRent: 8000, maxRent: 15000 }) });

		expect(res.status).toBe(200);
		expect(res.body.data.name).toBe("Keep this name");
		expect(res.body.data.filters).toMatchObject({ city: "Mumbai", minRent: 8000, maxRent: 15000 });
	});

	test("updates both name and filters together", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("update-both") });
		const createRes = await createSearch(agent);

		const res = await agent.patch(`/api/v1/saved-searches/${createRes.body.data.searchId}`).send({
			name: "New name",
			filters: basicFilters({ city: "Pune" }),
		});

		expect(res.status).toBe(200);
		expect(res.body.data.name).toBe("New name");
		expect(res.body.data.filters).toMatchObject({ city: "Pune" });
	});

	test("404 when a non-owner tries to update", async () => {
		const { agent: ownerAgent } = await registerStudent({ email: uniqueEmail("update-owner") });
		const createRes = await createSearch(ownerAgent);

		const { agent: attackerAgent } = await registerStudent({ email: uniqueEmail("update-attacker") });

		const res = await attackerAgent
			.patch(`/api/v1/saved-searches/${createRes.body.data.searchId}`)
			.send({ name: "Hijacked" });

		expect(res.status).toBe(404);
	});

	test("404 for a non-existent search", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("update-404") });

		const res = await agent
			.patch(`/api/v1/saved-searches/00000000-0000-0000-0000-000000000000`)
			.send({ name: "Ghost" });

		expect(res.status).toBe(404);
	});

	test("rejects an update with neither name nor filters (schema requires at least one key)", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("update-empty") });
		const createRes = await createSearch(agent);

		// Both fields are .optional() at the Zod layer with no cross-field
		// refine forcing at least one — an empty body still reaches the
		// service, whose own `if (!setClauses.length) throw 400` guard is the
		// actual enforcement point here.
		const res = await agent.patch(`/api/v1/saved-searches/${createRes.body.data.searchId}`).send({});

		expect(res.status).toBe(400);
	});

	test("rejects invalid filters on update the same way as create", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("update-badfilters") });
		const createRes = await createSearch(agent);

		const res = await agent
			.patch(`/api/v1/saved-searches/${createRes.body.data.searchId}`)
			.send({ filters: basicFilters({ minRent: 9000, maxRent: 1000 }) });

		expect(res.status).toBe(400);
	});

	test("requires authentication", async () => {
		const res = await request(app)
			.patch(`/api/v1/saved-searches/00000000-0000-0000-0000-000000000000`)
			.send({ name: "x" });
		expect(res.status).toBe(401);
	});
});

describe("DELETE /saved-searches/:searchId", () => {
	test("soft-deletes the caller's own search", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("delete-ok") });
		const createRes = await createSearch(agent);

		const res = await agent.delete(`/api/v1/saved-searches/${createRes.body.data.searchId}`);

		expect(res.status).toBe(200);
		expect(res.body.data.deleted).toBe(true);
		expect(res.body.data.searchId).toBe(createRes.body.data.searchId);

		const { rows } = await pool.query(`SELECT deleted_at FROM saved_searches WHERE search_id = $1`, [
			createRes.body.data.searchId,
		]);
		expect(rows[0].deleted_at).not.toBeNull();
	});

	test("404 when a non-owner tries to delete", async () => {
		const { agent: ownerAgent } = await registerStudent({ email: uniqueEmail("delete-owner") });
		const createRes = await createSearch(ownerAgent);

		const { agent: attackerAgent } = await registerStudent({ email: uniqueEmail("delete-attacker") });

		const res = await attackerAgent.delete(`/api/v1/saved-searches/${createRes.body.data.searchId}`);

		expect(res.status).toBe(404);
	});

	test("404 for a non-existent search", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("delete-404") });

		const res = await agent.delete(`/api/v1/saved-searches/00000000-0000-0000-0000-000000000000`);

		expect(res.status).toBe(404);
	});

	test("404 when deleting an already-deleted search (not idempotent — deleted_at IS NULL guard)", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("delete-double") });
		const createRes = await createSearch(agent);

		const first = await agent.delete(`/api/v1/saved-searches/${createRes.body.data.searchId}`);
		expect(first.status).toBe(200);

		const second = await agent.delete(`/api/v1/saved-searches/${createRes.body.data.searchId}`);
		expect(second.status).toBe(404);
	});

	test("rejects a malformed search id", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("delete-badid") });

		const res = await agent.delete(`/api/v1/saved-searches/not-a-uuid`);

		expect(res.status).toBe(400);
	});

	test("requires authentication", async () => {
		const res = await request(app).delete(`/api/v1/saved-searches/00000000-0000-0000-0000-000000000000`);
		expect(res.status).toBe(401);
	});
});
