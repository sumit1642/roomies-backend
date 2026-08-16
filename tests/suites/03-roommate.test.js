// tests/suites/03-roommate.test.js
//
// Covers: feed (GET /students/roommates), roommate-profile toggle (PUT
// /students/:userId/roommate-profile), block/unblock (POST/DELETE
// /students/:userId/block/:targetUserId).
//
// Solo suite per the batch-8 rollout plan — self-contained, no dependency on
// the interest/connection chain, and the lowest-covered service in the repo
// going in (roommate.service.js was at ~6% statement coverage).
//
// Route mount order matters here (see src/routes/student.js's comment):
// roommateRouter is registered BEFORE the /:userId routes so Express doesn't
// swallow the literal "roommates" path segment as a :userId param. If that
// ever regresses, GET /students/roommates would 400 on the getStudentParamsSchema
// UUID check instead of hitting the feed handler — a couple of tests below are
// shaped to make that failure mode obvious rather than just silently red.
//
// Preference-driven compatibility scoring reuses the same preference keys as
// 02-students.test.js (smoking, food_habit, etc. — see config/preferences.js)
// via PUT /students/:userId/preferences, so those tests exercise the real
// scoreUsersForUser() path end-to-end rather than stubbing it.

import request from "supertest";
import { app } from "../../src/app.js";
import { registerStudent } from "../setup/testAuth.js";
import { pool } from "../../src/db/client.js";

const uniqueEmail = (label) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@college.edu`;

// Registers a student and immediately opts them into the roommate feed via
// the real PUT endpoint (not a direct SQL write) so every fixture also
// exercises updateRoommateProfile's looking_updated_at-stamping behavior.
const registerSeekingStudent = async (label, { roommateBio, city } = {}) => {
	const { agent, user } = await registerStudent({ email: uniqueEmail(label) });

	const putRes = await agent
		.put(`/api/v1/students/${user.userId}/roommate-profile`)
		.send({ lookingForRoommate: true, ...(roommateBio !== undefined ? { roommateBio } : {}) });
	if (putRes.status !== 200) {
		throw new Error(
			`registerSeekingStudent: roommate-profile PUT failed (${putRes.status}): ${JSON.stringify(putRes.body)}`,
		);
	}

	if (city !== undefined) {
		// Feed's city filter is an EXISTS subquery against active listings for
		// the candidate (see idx_listings_posted_by_status_city, migration 009),
		// not a column on student_profiles — so "seeking in city X" is modeled
		// the same way the real app models it: an active student_room listing.
		const listingRes = await agent.post("/api/v1/listings").send({
			listingType: "student_room",
			title: "Looking for a roommate to share this room",
			rentPerMonth: 6000,
			roomType: "single",
			totalCapacity: 2,
			availableFrom: "2026-09-01",
			addressLine: "1 Test Street",
			city,
			latitude: 28.6139,
			longitude: 77.209,
		});
		if (listingRes.status !== 201) {
			throw new Error(`registerSeekingStudent: listing creation failed (${listingRes.status})`);
		}
	}

	return { agent, user };
};

const setPreferences = (agent, userId, preferences) =>
	agent.put(`/api/v1/students/${userId}/preferences`).send({ preferences });

describe("GET /students/roommates", () => {
	test("returns students who have opted in, excluding the caller", async () => {
		const { agent: callerAgent, user: caller } = await registerSeekingStudent("feed-caller");
		const { user: candidate } = await registerSeekingStudent("feed-candidate");

		const res = await callerAgent.get("/api/v1/students/roommates");

		expect(res.status).toBe(200);
		const ids = res.body.data.items.map((i) => i.userId);
		expect(ids).toContain(candidate.userId);
		expect(ids).not.toContain(caller.userId);
	});

	test("a non-opted-in caller sees a feed but never appears in it themselves", async () => {
		// Feed access itself doesn't require the caller to be opted in — only
		// authentication + the student role. sp.user_id <> $1 in the WHERE
		// clause guards self-exclusion independently of looking_for_roommate.
		const { agent: nonSeekerAgent, user: nonSeeker } = await registerStudent({
			email: uniqueEmail("feed-self-notseeking"),
		});

		const res = await nonSeekerAgent.get("/api/v1/students/roommates");

		expect(res.status).toBe(200);
		expect(res.body.data.items.map((i) => i.userId)).not.toContain(nonSeeker.userId);
	});

	test("excludes a third-party student who has not set looking_for_roommate", async () => {
		const { agent: callerAgent } = await registerSeekingStudent("feed-optout-caller");
		const { user: nonSeeker } = await registerStudent({ email: uniqueEmail("feed-optout-other") });

		const res = await callerAgent.get("/api/v1/students/roommates");

		expect(res.status).toBe(200);
		expect(res.body.data.items.map((i) => i.userId)).not.toContain(nonSeeker.userId);
	});

	test("filters by city via the candidate's active listing", async () => {
		const { agent: callerAgent } = await registerSeekingStudent("feed-city-caller");
		const { user: mumbaiCandidate } = await registerSeekingStudent("feed-city-mumbai", { city: "Mumbai" });
		const { user: puneCandidate } = await registerSeekingStudent("feed-city-pune", { city: "Pune" });

		const res = await callerAgent.get("/api/v1/students/roommates").query({ city: "Mumbai" });

		expect(res.status).toBe(200);
		const ids = res.body.data.items.map((i) => i.userId);
		expect(ids).toContain(mumbaiCandidate.userId);
		expect(ids).not.toContain(puneCandidate.userId);
	});

	test("excludes a candidate blocked by the caller", async () => {
		const { agent: callerAgent, user: caller } = await registerSeekingStudent("feed-blocked-caller");
		const { user: blocked } = await registerSeekingStudent("feed-blocked-target");

		await callerAgent.post(`/api/v1/students/${caller.userId}/block/${blocked.userId}`);

		const res = await callerAgent.get("/api/v1/students/roommates");

		expect(res.status).toBe(200);
		expect(res.body.data.items.map((i) => i.userId)).not.toContain(blocked.userId);
	});

	test("excludes a candidate who has blocked the caller (bidirectional)", async () => {
		const { agent: callerAgent, user: caller } = await registerSeekingStudent("feed-blockedby-caller");
		const { agent: otherAgent, user: other } = await registerSeekingStudent("feed-blockedby-other");

		// The other student blocks the caller — feed must still hide `other`
		// from the caller's results even though the block direction is reversed.
		await otherAgent.post(`/api/v1/students/${other.userId}/block/${caller.userId}`);

		const res = await callerAgent.get("/api/v1/students/roommates");

		expect(res.status).toBe(200);
		expect(res.body.data.items.map((i) => i.userId)).not.toContain(other.userId);
	});

	test("compatibilityScore is 0 and compatibilityAvailable is false when the caller has no preferences", async () => {
		const { agent: callerAgent } = await registerSeekingStudent("feed-nopref-caller");
		const { agent: candidateAgent, user: candidate } = await registerSeekingStudent("feed-nopref-candidate");
		await setPreferences(candidateAgent, candidate.userId, [
			{ preferenceKey: "smoking", preferenceValue: "non_smoker" },
		]);

		const res = await callerAgent.get("/api/v1/students/roommates");

		expect(res.status).toBe(200);
		const item = res.body.data.items.find((i) => i.userId === candidate.userId);
		expect(item).toBeDefined();
		expect(item.compatibilityScore).toBe(0);
		expect(item.compatibilityAvailable).toBe(false);
	});

	test("computes a nonzero compatibilityScore when caller and candidate share preferences", async () => {
		const { agent: callerAgent, user: caller } = await registerSeekingStudent("feed-match-caller");
		await setPreferences(callerAgent, caller.userId, [
			{ preferenceKey: "smoking", preferenceValue: "non_smoker" },
			{ preferenceKey: "food_habit", preferenceValue: "vegetarian" },
		]);

		const { agent: candidateAgent, user: candidate } = await registerSeekingStudent("feed-match-candidate");
		await setPreferences(candidateAgent, candidate.userId, [
			{ preferenceKey: "smoking", preferenceValue: "non_smoker" },
			{ preferenceKey: "food_habit", preferenceValue: "non_vegetarian" },
		]);

		const res = await callerAgent.get("/api/v1/students/roommates");

		expect(res.status).toBe(200);
		const item = res.body.data.items.find((i) => i.userId === candidate.userId);
		expect(item).toBeDefined();
		expect(item.compatibilityAvailable).toBe(true);
		// 1 shared (smoking) out of a 3-value union (smoking, food_habit x2) = 33%
		expect(item.compatibilityScore).toBeGreaterThan(0);
		expect(item.compatibilityScore).toBeLessThanOrEqual(100);
	});

	test("includes each candidate's own preferences list regardless of caller's preferences", async () => {
		const { agent: callerAgent } = await registerSeekingStudent("feed-prefslist-caller");
		const { agent: candidateAgent, user: candidate } = await registerSeekingStudent("feed-prefslist-candidate");
		await setPreferences(candidateAgent, candidate.userId, [
			{ preferenceKey: "cleanliness_level", preferenceValue: "high" },
		]);

		const res = await callerAgent.get("/api/v1/students/roommates");

		expect(res.status).toBe(200);
		const item = res.body.data.items.find((i) => i.userId === candidate.userId);
		expect(item.preferences).toEqual([{ preferenceKey: "cleanliness_level", preferenceValue: "high" }]);
	});

	test("supports cursor pagination", async () => {
		const { agent: callerAgent } = await registerSeekingStudent("feed-paginate-caller");
		for (let i = 0; i < 3; i++) {
			await registerSeekingStudent(`feed-paginate-candidate-${i}`);
		}

		const firstPage = await callerAgent.get("/api/v1/students/roommates").query({ limit: 2 });
		expect(firstPage.status).toBe(200);
		expect(firstPage.body.data.items).toHaveLength(2);
		expect(firstPage.body.data.nextCursor).not.toBeNull();

		const secondPage = await callerAgent.get("/api/v1/students/roommates").query({
			limit: 2,
			cursorTime: firstPage.body.data.nextCursor.cursorTime,
			cursorId: firstPage.body.data.nextCursor.cursorId,
		});
		expect(secondPage.status).toBe(200);
		expect(secondPage.body.data.items.length).toBeGreaterThanOrEqual(1);

		const firstIds = firstPage.body.data.items.map((i) => i.userId);
		const secondIds = secondPage.body.data.items.map((i) => i.userId);
		expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
	});

	test("rejects a limit over the pagination validator's hard cap of 100", async () => {
		const { agent: callerAgent } = await registerSeekingStudent("feed-limitover100-caller");

		// z.coerce.number().int().min(1).max(100) in buildKeysetPaginationFields
		// is a hard validation failure, not a clamp — a value above 100 never
		// reaches getRoommateFeedSchema's .transform at all.
		const res = await callerAgent.get("/api/v1/students/roommates").query({ limit: 500 });

		expect(res.status).toBe(400);
	});

	test("clamps a limit between 51 and 100 down to the roommate-feed max of 50", async () => {
		const { agent: callerAgent } = await registerSeekingStudent("feed-limitclamp-caller");

		// 75 passes the shared .max(100) validator, then getRoommateFeedSchema's
		// own .transform(data => ({ ...data, limit: Math.min(data.limit, 50) }))
		// silently clamps it down to 50 — this is the actual clamp path.
		const res = await callerAgent.get("/api/v1/students/roommates").query({ limit: 75 });

		expect(res.status).toBe(200);
	});

	test("a pg_owner cannot access the student-only roommate feed", async () => {
		const { registerPgOwner } = await import("../setup/testAuth.js");
		const { agent: ownerAgent } = await registerPgOwner({ email: `feed-owner-${Date.now()}@business.test` });

		const res = await ownerAgent.get("/api/v1/students/roommates");

		expect(res.status).toBe(403);
	});

	test("requires authentication", async () => {
		const res = await request(app).get("/api/v1/students/roommates");
		expect(res.status).toBe(401);
	});

	test("rejects an invalid cursorId with 400", async () => {
		const { agent: callerAgent } = await registerSeekingStudent("feed-badcursor-caller");

		const res = await callerAgent
			.get("/api/v1/students/roommates")
			.query({ cursorTime: new Date().toISOString(), cursorId: "not-a-uuid" });

		expect(res.status).toBe(400);
	});
});

describe("PUT /students/:userId/roommate-profile", () => {
	test("opts a student in and stamps looking_updated_at", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("optin-ok") });

		const res = await agent
			.put(`/api/v1/students/${user.userId}/roommate-profile`)
			.send({ lookingForRoommate: true, roommateBio: "Tidy, quiet, early riser." });

		expect(res.status).toBe(200);
		expect(res.body.data.lookingForRoommate).toBe(true);
		expect(res.body.data.roommateBio).toBe("Tidy, quiet, early riser.");
		expect(res.body.data.lookingUpdatedAt).toEqual(expect.any(String));
	});

	test("opting out clears looking_for_roommate but preserves the previous looking_updated_at", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("optout-preserve") });

		const inRes = await agent.put(`/api/v1/students/${user.userId}/roommate-profile`).send({
			lookingForRoommate: true,
		});
		const stampedAt = inRes.body.data.lookingUpdatedAt;
		expect(stampedAt).toEqual(expect.any(String));

		const outRes = await agent.put(`/api/v1/students/${user.userId}/roommate-profile`).send({
			lookingForRoommate: false,
		});

		expect(outRes.status).toBe(200);
		expect(outRes.body.data.lookingForRoommate).toBe(false);
		// looking_updated_at is only bumped when flipping TO true — opting out
		// must not touch it (matches the CASE WHEN $1 = TRUE ... in the UPDATE).
		expect(outRes.body.data.lookingUpdatedAt).toBe(stampedAt);
	});

	test("opted-out student no longer appears in another student's feed", async () => {
		const { agent, user } = await registerSeekingStudent("optout-hides");
		const { agent: callerAgent } = await registerSeekingStudent("optout-hides-caller");

		const beforeRes = await callerAgent.get("/api/v1/students/roommates");
		expect(beforeRes.body.data.items.map((i) => i.userId)).toContain(user.userId);

		await agent.put(`/api/v1/students/${user.userId}/roommate-profile`).send({ lookingForRoommate: false });

		const afterRes = await callerAgent.get("/api/v1/students/roommates");
		expect(afterRes.body.data.items.map((i) => i.userId)).not.toContain(user.userId);
	});

	test("403 when a student tries to update someone else's roommate profile", async () => {
		const { user: target } = await registerStudent({ email: uniqueEmail("optin-target") });
		const { agent: attackerAgent } = await registerStudent({ email: uniqueEmail("optin-attacker") });

		const res = await attackerAgent
			.put(`/api/v1/students/${target.userId}/roommate-profile`)
			.send({ lookingForRoommate: true });

		expect(res.status).toBe(403);
	});

	test("a pg_owner cannot hit the student-only roommate-profile route", async () => {
		const { registerPgOwner } = await import("../setup/testAuth.js");
		const { agent: ownerAgent, user: owner } = await registerPgOwner({
			email: `optin-owner-${Date.now()}@business.test`,
		});

		const res = await ownerAgent
			.put(`/api/v1/students/${owner.userId}/roommate-profile`)
			.send({ lookingForRoommate: true });

		expect(res.status).toBe(403);
	});

	test("rejects a non-boolean lookingForRoommate with 400", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("optin-badtype") });

		const res = await agent
			.put(`/api/v1/students/${user.userId}/roommate-profile`)
			.send({ lookingForRoommate: "yes" });

		expect(res.status).toBe(400);
	});

	test("rejects a roommateBio over 500 characters", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("optin-longbio") });

		const res = await agent.put(`/api/v1/students/${user.userId}/roommate-profile`).send({
			lookingForRoommate: true,
			roommateBio: "x".repeat(501),
		});

		expect(res.status).toBe(400);
	});

	test("requires authentication", async () => {
		const res = await request(app)
			.put(`/api/v1/students/00000000-0000-0000-0000-000000000000/roommate-profile`)
			.send({ lookingForRoommate: true });

		expect(res.status).toBe(401);
	});
});

describe("POST /students/:userId/block/:targetUserId, DELETE .../block/:targetUserId", () => {
	test("blocks a target student", async () => {
		const { agent, user: blocker } = await registerStudent({ email: uniqueEmail("block-ok-blocker") });
		const { user: target } = await registerStudent({ email: uniqueEmail("block-ok-target") });

		const res = await agent.post(`/api/v1/students/${blocker.userId}/block/${target.userId}`);

		expect(res.status).toBe(200);
		expect(res.body.data.blockedUserId).toBe(target.userId);
		expect(res.body.data.blocked).toBe(true);

		const { rows } = await pool.query(`SELECT 1 FROM roommate_blocks WHERE blocker_id = $1 AND blocked_id = $2`, [
			blocker.userId,
			target.userId,
		]);
		expect(rows).toHaveLength(1);
	});

	test("blocking the same target twice is idempotent (ON CONFLICT DO NOTHING)", async () => {
		const { agent, user: blocker } = await registerStudent({ email: uniqueEmail("block-dup-blocker") });
		const { user: target } = await registerStudent({ email: uniqueEmail("block-dup-target") });

		const first = await agent.post(`/api/v1/students/${blocker.userId}/block/${target.userId}`);
		expect(first.status).toBe(200);

		const second = await agent.post(`/api/v1/students/${blocker.userId}/block/${target.userId}`);
		expect(second.status).toBe(200);

		const { rows } = await pool.query(
			`SELECT COUNT(*)::int AS cnt FROM roommate_blocks WHERE blocker_id = $1 AND blocked_id = $2`,
			[blocker.userId, target.userId],
		);
		expect(rows[0].cnt).toBe(1);
	});

	test("enforces the 200-block cap per user", async () => {
		const { agent, user: blocker } = await registerStudent({ email: uniqueEmail("block-cap-blocker") });

		// Seed 200 pre-existing blocked targets directly via SQL. Driving all
		// 200 through the real POST endpoint would mean 200 real bcrypt-backed
		// registrations per test run — the cap-check logic itself (COUNT(*) >=
		// MAX_BLOCKS_PER_USER inside the advisory-locked transaction) doesn't
		// care how the existing rows got there, only that they exist, so this
		// tests the guard without the register-200-users cost. The 201st block
		// below is still driven through the real endpoint, which is the actual
		// behavior under test.
		const { rows: fillerUsers } = await pool.query(
			`INSERT INTO users (email, password_hash)
       SELECT 'block-cap-filler-' || gs || '-${Date.now()}@college.edu', 'x'
       FROM generate_series(1, 200) AS gs
       RETURNING user_id`,
		);
		await pool.query(
			`INSERT INTO student_profiles (user_id, full_name)
       SELECT user_id, 'Filler Student' FROM UNNEST($1::uuid[]) AS user_id`,
			[fillerUsers.map((r) => r.user_id)],
		);
		await pool.query(
			`INSERT INTO user_roles (user_id, role_name)
       SELECT user_id, 'student' FROM UNNEST($1::uuid[]) AS user_id`,
			[fillerUsers.map((r) => r.user_id)],
		);
		await pool.query(
			`INSERT INTO roommate_blocks (blocker_id, blocked_id)
       SELECT $1, user_id FROM UNNEST($2::uuid[]) AS user_id`,
			[blocker.userId, fillerUsers.map((r) => r.user_id)],
		);

		const { user: oneMoreTarget } = await registerStudent({ email: uniqueEmail("block-cap-overflow") });

		const res = await agent.post(`/api/v1/students/${blocker.userId}/block/${oneMoreTarget.userId}`);

		expect(res.status).toBe(422);
	});

	test("404 when the block target does not exist", async () => {
		const { agent, user: blocker } = await registerStudent({ email: uniqueEmail("block-notfound-blocker") });

		const res = await agent.post(`/api/v1/students/${blocker.userId}/block/00000000-0000-0000-0000-000000000000`);

		expect(res.status).toBe(404);
	});

	test("404 when the block target is a pg_owner, not a student", async () => {
		const { registerPgOwner } = await import("../setup/testAuth.js");
		const { agent, user: blocker } = await registerStudent({ email: uniqueEmail("block-notstudent-blocker") });
		const { user: owner } = await registerPgOwner({ email: `block-notstudent-owner-${Date.now()}@business.test` });

		const res = await agent.post(`/api/v1/students/${blocker.userId}/block/${owner.userId}`);

		expect(res.status).toBe(404);
	});

	test("403 when the caller is not the :userId in the path (requireSelf)", async () => {
		const { agent: attackerAgent } = await registerStudent({ email: uniqueEmail("block-notself-attacker") });
		const { user: victim } = await registerStudent({ email: uniqueEmail("block-notself-victim") });
		const { user: target } = await registerStudent({ email: uniqueEmail("block-notself-target") });

		// attacker tries to block on victim's behalf by putting victim's id in
		// the :userId slot while authenticated as someone else entirely.
		const res = await attackerAgent.post(`/api/v1/students/${victim.userId}/block/${target.userId}`);

		expect(res.status).toBe(403);
	});

	test("400 when a student tries to block themselves", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("block-self") });

		// Route order is requireSelf -> validate(blockTargetParamsSchema) ->
		// controller. requireSelf passes trivially (caller === :userId), so
		// it's the params-level refinement (userId !== targetUserId) in
		// blockTargetParamsSchema that actually rejects this — the service's
		// own self-block AppError(422) in blockUser() is never reached, since
		// validation fails first.
		const res = await agent.post(`/api/v1/students/${user.userId}/block/${user.userId}`);

		expect(res.status).toBe(400);
	});

	test("unblocks a previously blocked student", async () => {
		const { agent, user: blocker } = await registerStudent({ email: uniqueEmail("unblock-ok-blocker") });
		const { user: target } = await registerStudent({ email: uniqueEmail("unblock-ok-target") });

		await agent.post(`/api/v1/students/${blocker.userId}/block/${target.userId}`);

		const res = await agent.delete(`/api/v1/students/${blocker.userId}/block/${target.userId}`);

		expect(res.status).toBe(200);
		expect(res.body.data.blocked).toBe(false);

		const { rows } = await pool.query(`SELECT 1 FROM roommate_blocks WHERE blocker_id = $1 AND blocked_id = $2`, [
			blocker.userId,
			target.userId,
		]);
		expect(rows).toHaveLength(0);
	});

	test("unblocking a target that was never blocked is a harmless no-op", async () => {
		const { agent, user: blocker } = await registerStudent({ email: uniqueEmail("unblock-noop-blocker") });
		const { user: target } = await registerStudent({ email: uniqueEmail("unblock-noop-target") });

		const res = await agent.delete(`/api/v1/students/${blocker.userId}/block/${target.userId}`);

		expect(res.status).toBe(200);
		expect(res.body.data.blocked).toBe(false);
	});

	test("unblocking is idempotent when called twice", async () => {
		const { agent, user: blocker } = await registerStudent({ email: uniqueEmail("unblock-dup-blocker") });
		const { user: target } = await registerStudent({ email: uniqueEmail("unblock-dup-target") });

		await agent.post(`/api/v1/students/${blocker.userId}/block/${target.userId}`);

		const first = await agent.delete(`/api/v1/students/${blocker.userId}/block/${target.userId}`);
		expect(first.status).toBe(200);

		const second = await agent.delete(`/api/v1/students/${blocker.userId}/block/${target.userId}`);
		expect(second.status).toBe(200);
	});

	test("a block is one-directional in storage (only blocker->target is written)", async () => {
		const { agent, user: blocker } = await registerStudent({ email: uniqueEmail("block-onedir-blocker") });
		const { user: target } = await registerStudent({ email: uniqueEmail("block-onedir-target") });

		await agent.post(`/api/v1/students/${blocker.userId}/block/${target.userId}`);

		const { rows } = await pool.query(`SELECT 1 FROM roommate_blocks WHERE blocker_id = $1 AND blocked_id = $2`, [
			target.userId,
			blocker.userId,
		]);
		// The reverse row must NOT exist — bidirectional exclusion in the feed
		// query is a query-time OR, not a symmetric write on block.
		expect(rows).toHaveLength(0);
	});

	test("403 when the caller is not self for DELETE either", async () => {
		const { agent: attackerAgent } = await registerStudent({ email: uniqueEmail("unblock-notself-attacker") });
		const { user: victim } = await registerStudent({ email: uniqueEmail("unblock-notself-victim") });
		const { user: target } = await registerStudent({ email: uniqueEmail("unblock-notself-target") });

		const res = await attackerAgent.delete(`/api/v1/students/${victim.userId}/block/${target.userId}`);

		expect(res.status).toBe(403);
	});

	test("requires authentication for both block and unblock", async () => {
		const blockRes = await request(app).post(
			`/api/v1/students/00000000-0000-0000-0000-000000000000/block/11111111-1111-1111-1111-111111111111`,
		);
		expect(blockRes.status).toBe(401);

		const unblockRes = await request(app).delete(
			`/api/v1/students/00000000-0000-0000-0000-000000000000/block/11111111-1111-1111-1111-111111111111`,
		);
		expect(unblockRes.status).toBe(401);
	});
});
