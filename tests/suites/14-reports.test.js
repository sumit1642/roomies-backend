// tests/suites/14-reports.test.js
//
// Covers: submit (POST /ratings/:ratingId/report — lives on the ratings
// router since reports are always scoped to a rating), queue (admin), resolve
// (admin, both resolved_removed and resolved_kept paths).
//
// Fixture chain: a report needs a rating, a rating needs a confirmed
// connection — reuses the same create-listing -> interest -> accept ->
// confirm-both-sides flow established in 12-connections.test.js /
// 13-ratings.test.js, then submits a rating before reporting it.
//
// Admin bootstrap mirrors the pattern already used in
// 05-verification-email.test.js: promote a registered user to admin
// directly via SQL (no public admin-signup endpoint exists).
//
// resolveReport has a documented idempotency edge case
// (ratingWasAlreadySoftDeleted in report.service.js) for when the target
// rating was already hidden by an earlier resolved_removed report on a
// different report row for the same rating — covered explicitly below.

import request from "supertest";
import { app } from "../../src/app.js";
import { pool } from "../../src/db/client.js";
import { registerStudent } from "../setup/testAuth.js";

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

const makeAdmin = async (userId) => {
	await pool.query(`INSERT INTO user_roles (user_id, role_name) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`, [
		userId,
	]);
	await pool.query(`UPDATE users SET is_email_verified = TRUE WHERE user_id = $1`, [userId]);
};

// Drives poster+sender to a confirmed connection, then has the sender rate
// the poster, returning everything a report test might need.
const createRatedConnection = async (labelPrefix, listingOverrides = {}) => {
	const { agent: posterAgent, user: poster } = await registerStudent({
		email: uniqueEmail(`${labelPrefix}-poster`),
	});
	const createListingRes = await posterAgent.post("/api/v1/listings").send(studentRoomBody(listingOverrides));
	const listingId = createListingRes.body.data.listing_id;

	const { agent: senderAgent, user: sender } = await registerStudent({
		email: uniqueEmail(`${labelPrefix}-sender`),
	});
	const interestRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
	const acceptRes = await posterAgent
		.patch(`/api/v1/interests/${interestRes.body.data.interestRequestId}/status`)
		.send({ status: "accepted" });
	const connectionId = acceptRes.body.data.connectionId;

	await senderAgent.post(`/api/v1/connections/${connectionId}/confirm`);
	await posterAgent.post(`/api/v1/connections/${connectionId}/confirm`);

	const ratingRes = await senderAgent.post("/api/v1/ratings").send({
		connectionId,
		revieweeType: "user",
		revieweeId: poster.userId,
		overallScore: 1,
		comment: "Reported for testing purposes.",
	});
	const ratingId = ratingRes.body.data.ratingId;

	return { posterAgent, poster, senderAgent, sender, connectionId, ratingId };
};

describe("POST /ratings/:ratingId/report", () => {
	test("a party to the connection reports the rating", async () => {
		const { posterAgent, ratingId } = await createRatedConnection("submit-ok");

		const res = await posterAgent.post(`/api/v1/ratings/${ratingId}/report`).send({
			reason: "abusive",
			explanation: "Contains inappropriate language.",
		});

		expect(res.status).toBe(201);
		expect(res.body.data.reportId).toEqual(expect.any(String));
		expect(res.body.data.status).toBe("open");
		expect(res.body.data.reason).toBe("abusive");
	});

	test("works without an explanation (optional)", async () => {
		const { posterAgent, ratingId } = await createRatedConnection("submit-noexplain");

		const res = await posterAgent.post(`/api/v1/ratings/${ratingId}/report`).send({ reason: "fake" });

		expect(res.status).toBe(201);
	});

	test("404 when the reporter is not a party to the connection", async () => {
		const { ratingId } = await createRatedConnection("submit-notparty");
		const { agent: strangerAgent } = await registerStudent({ email: uniqueEmail("submit-notparty-stranger") });

		const res = await strangerAgent.post(`/api/v1/ratings/${ratingId}/report`).send({ reason: "other" });

		expect(res.status).toBe(404);
	});

	test("404 for a non-existent rating", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("submit-404") });

		const res = await agent
			.post(`/api/v1/ratings/00000000-0000-0000-0000-000000000000/report`)
			.send({ reason: "other" });

		expect(res.status).toBe(404);
	});

	test("rejects an invalid reason enum value", async () => {
		const { posterAgent, ratingId } = await createRatedConnection("submit-badreason");

		const res = await posterAgent.post(`/api/v1/ratings/${ratingId}/report`).send({ reason: "spam" });

		expect(res.status).toBe(400);
	});

	test("requires authentication", async () => {
		const { ratingId } = await createRatedConnection("submit-noauth");

		const res = await request(app).post(`/api/v1/ratings/${ratingId}/report`).send({ reason: "other" });

		expect(res.status).toBe(401);
	});
});

describe("GET /reports/queue — admin", () => {
	test("lists open reports with rating, reporter, and reviewee context", async () => {
		const { posterAgent, poster, sender, ratingId } = await createRatedConnection("queue-ok");
		await posterAgent.post(`/api/v1/ratings/${ratingId}/report`).send({ reason: "abusive" });

		const { agent: adminAgent, user: admin } = await registerStudent({ email: uniqueEmail("queue-admin") });
		await makeAdmin(admin.userId);

		const res = await adminAgent.get("/api/v1/reports/queue");

		expect(res.status).toBe(200);
		expect(res.body.data.items).toHaveLength(1);
		expect(res.body.data.items[0].rating.revieweeId).toBe(poster.userId);
		expect(res.body.data.items[0].reporter.fullName).toEqual(expect.any(String));
		expect(res.body.data.items[0].rating.reviewer.fullName).toEqual(expect.any(String));
	});

	test("403 for a non-admin authenticated user", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("queue-forbidden") });

		const res = await agent.get("/api/v1/reports/queue");

		expect(res.status).toBe(403);
	});

	test("403 for an admin whose email is not verified", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("queue-unverified-admin") });
		await pool.query(`INSERT INTO user_roles (user_id, role_name) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`, [
			user.userId,
		]);
		// Deliberately not calling makeAdmin's is_email_verified update.

		const res = await agent.get("/api/v1/reports/queue");

		expect(res.status).toBe(403);
	});

	test("DIAGNOSTIC: instrument exact timestamps to confirm/refute the millisecond-collision theory", async () => {
		const { agent: adminAgent, user: admin } = await registerStudent({ email: uniqueEmail("queue-diag-admin") });
		await makeAdmin(admin.userId);

		const REPORT_COUNT = 3;
		for (let i = 0; i < REPORT_COUNT; i++) {
			const { posterAgent, ratingId } = await createRatedConnection(`queue-diag-${i}`);
			await posterAgent.post(`/api/v1/ratings/${ratingId}/report`).send({ reason: "other" });
		}

		// Raw DB truth: exact microsecond timestamps + ids, in queue order.
		const { rows: dbRows } = await pool.query(
			`SELECT report_id, created_at, created_at::text AS created_at_text
       FROM rating_reports
       WHERE status = 'open'
       ORDER BY created_at ASC, report_id ASC`,
		);
		console.log("DIAGNOSTIC — raw DB rows (exact precision):", JSON.stringify(dbRows, null, 2));
		expect(dbRows).toHaveLength(REPORT_COUNT); // sanity: confirms exactly 3 real rows exist

		const firstPage = await adminAgent.get("/api/v1/reports/queue").query({ limit: 2 });
		console.log(
			"DIAGNOSTIC — firstPage items:",
			JSON.stringify(
				firstPage.body.data.items.map((i) => ({
					reportId: i.reportId,
					submittedAt: i.submittedAt,
				})),
				null,
				2,
			),
		);
		console.log("DIAGNOSTIC — firstPage nextCursor:", JSON.stringify(firstPage.body.data.nextCursor));

		const secondPage = await adminAgent.get("/api/v1/reports/queue").query({
			limit: 2,
			cursorTime: firstPage.body.data.nextCursor.cursorTime,
			cursorId: firstPage.body.data.nextCursor.cursorId,
		});
		console.log(
			"DIAGNOSTIC — secondPage items:",
			JSON.stringify(
				secondPage.body.data.items.map((i) => ({
					reportId: i.reportId,
					submittedAt: i.submittedAt,
				})),
				null,
				2,
			),
		);

		const firstPageIds = firstPage.body.data.items.map((i) => i.reportId);
		const secondPageIds = secondPage.body.data.items.map((i) => i.reportId);
		const overlap = firstPageIds.filter((id) => secondPageIds.includes(id));
		console.log("DIAGNOSTIC — overlapping report IDs across pages:", overlap);

		// This is the actual question: does the boundary row leak across pages?
		expect(overlap).toEqual([]);
	});

	test("DIAGNOSTIC: instrument exact timestamps to confirm/refute the millisecond-collision theory", async () => {
		const { agent: adminAgent, user: admin } = await registerStudent({ email: uniqueEmail("queue-diag-admin") });
		await makeAdmin(admin.userId);

		const REPORT_COUNT = 3;
		for (let i = 0; i < REPORT_COUNT; i++) {
			const { posterAgent, ratingId } = await createRatedConnection(`queue-diag-${i}`);
			await posterAgent.post(`/api/v1/ratings/${ratingId}/report`).send({ reason: "other" });
		}

		// Raw DB truth: exact microsecond timestamps + ids, in queue order.
		const { rows: dbRows } = await pool.query(
			`SELECT report_id, created_at, created_at::text AS created_at_text
       FROM rating_reports
       WHERE status = 'open'
       ORDER BY created_at ASC, report_id ASC`,
		);
		console.log("DIAGNOSTIC — raw DB row count:", dbRows.length);
		console.log("DIAGNOSTIC — raw DB rows (exact precision):", JSON.stringify(dbRows, null, 2));
	});

	test("supports cursor pagination against only the reports this test creates", async () => {
		const { agent: adminAgent, user: admin } = await registerStudent({
			email: uniqueEmail("queue-paginate-admin"),
		});
		await makeAdmin(admin.userId);

		// Hermetic by construction: track exactly which report IDs this test
		// creates, and assert pagination behavior against that known set rather
		// than assuming the queue is otherwise empty. This removes any
		// dependency on cross-test isolation timing — whether or not something
		// else in the suite also has an open report at this moment, this test's
		// own 3 reports must appear exactly once, in total, across all pages.
		const REPORT_COUNT = 3;
		const createdReportIds = new Set();
		for (let i = 0; i < REPORT_COUNT; i++) {
			const { posterAgent, ratingId } = await createRatedConnection(`queue-paginate-${i}`);
			const reportRes = await posterAgent.post(`/api/v1/ratings/${ratingId}/report`).send({ reason: "other" });
			createdReportIds.add(reportRes.body.data.reportId);
		}
		expect(createdReportIds.size).toBe(REPORT_COUNT);

		// Walk every page with a small limit, collecting only report IDs that
		// belong to this test's own fixture set.
		const seenOwnReportIds = [];
		let cursorTime, cursorId;
		let guardIterations = 0;

		while (true) {
			guardIterations++;
			if (guardIterations > 50) {
				throw new Error("supports cursor pagination: exceeded pagination guard — possible infinite loop");
			}

			const query = { limit: 2 };
			if (cursorTime !== undefined) {
				query.cursorTime = cursorTime;
				query.cursorId = cursorId;
			}

			const page = await adminAgent.get("/api/v1/reports/queue").query(query);
			expect(page.status).toBe(200);

			for (const item of page.body.data.items) {
				if (createdReportIds.has(item.reportId)) {
					seenOwnReportIds.push(item.reportId);
				}
			}

			if (!page.body.data.nextCursor) break;
			cursorTime = page.body.data.nextCursor.cursorTime;
			cursorId = page.body.data.nextCursor.cursorId;
		}

		// Each of this test's 3 reports must appear exactly once across the
		// full paginated walk — no duplicates (cursor boundary bug) and no
		// omissions (off-by-one bug), regardless of what else is in the queue.
		expect(seenOwnReportIds.sort()).toEqual([...createdReportIds].sort());
	});
});

describe("PATCH /reports/:reportId/resolve — admin", () => {
	test("resolved_kept leaves the rating visible", async () => {
		const { posterAgent, ratingId } = await createRatedConnection("resolve-kept");
		const reportRes = await posterAgent.post(`/api/v1/ratings/${ratingId}/report`).send({ reason: "fake" });
		const reportId = reportRes.body.data.reportId;

		const { agent: adminAgent, user: admin } = await registerStudent({ email: uniqueEmail("resolve-kept-admin") });
		await makeAdmin(admin.userId);

		const res = await adminAgent.patch(`/api/v1/reports/${reportId}/resolve`).send({ resolution: "resolved_kept" });

		expect(res.status).toBe(200);
		expect(res.body.data.resolution).toBe("resolved_kept");

		const { rows } = await pool.query(`SELECT is_visible FROM ratings WHERE rating_id = $1`, [ratingId]);
		expect(rows[0].is_visible).toBe(true);
	});

	test("resolved_removed hides the rating and requires adminNotes", async () => {
		const { posterAgent, ratingId } = await createRatedConnection("resolve-removed");
		const reportRes = await posterAgent.post(`/api/v1/ratings/${ratingId}/report`).send({ reason: "abusive" });
		const reportId = reportRes.body.data.reportId;

		const { agent: adminAgent, user: admin } = await registerStudent({
			email: uniqueEmail("resolve-removed-admin"),
		});
		await makeAdmin(admin.userId);

		const res = await adminAgent
			.patch(`/api/v1/reports/${reportId}/resolve`)
			.send({ resolution: "resolved_removed", adminNotes: "Confirmed abusive language, removing." });

		expect(res.status).toBe(200);
		expect(res.body.data.resolution).toBe("resolved_removed");

		const { rows } = await pool.query(`SELECT is_visible FROM ratings WHERE rating_id = $1`, [ratingId]);
		expect(rows[0].is_visible).toBe(false);
	});

	test("rejects resolved_removed without adminNotes", async () => {
		const { posterAgent, ratingId } = await createRatedConnection("resolve-noreason");
		const reportRes = await posterAgent.post(`/api/v1/ratings/${ratingId}/report`).send({ reason: "abusive" });
		const reportId = reportRes.body.data.reportId;

		const { agent: adminAgent, user: admin } = await registerStudent({
			email: uniqueEmail("resolve-noreason-admin"),
		});
		await makeAdmin(admin.userId);

		const res = await adminAgent
			.patch(`/api/v1/reports/${reportId}/resolve`)
			.send({ resolution: "resolved_removed" });

		expect(res.status).toBe(400);
	});

	test("409 when resolving an already-resolved report", async () => {
		const { posterAgent, ratingId } = await createRatedConnection("resolve-already");
		const reportRes = await posterAgent.post(`/api/v1/ratings/${ratingId}/report`).send({ reason: "other" });
		const reportId = reportRes.body.data.reportId;

		const { agent: adminAgent, user: admin } = await registerStudent({
			email: uniqueEmail("resolve-already-admin"),
		});
		await makeAdmin(admin.userId);

		const firstRes = await adminAgent
			.patch(`/api/v1/reports/${reportId}/resolve`)
			.send({ resolution: "resolved_kept" });
		expect(firstRes.status).toBe(200);

		const secondRes = await adminAgent
			.patch(`/api/v1/reports/${reportId}/resolve`)
			.send({ resolution: "resolved_kept" });

		expect(secondRes.status).toBe(409);
	});

	// Idempotency edge case documented in report.service.js: if the SAME
	// rating was already soft-deleted by resolving an EARLIER open report on
	// it (a rating can have at most one open report at a time per the
	// idx_rating_reports_no_duplicates constraint, but a second reporter can
	// still file a new report after the first is resolved), resolving that
	// second report as resolved_removed should succeed as a no-op on the
	// rating itself rather than throwing, since the desired end state
	// ("rating is hidden") already holds.
	test("resolved_removed on a rating already hidden by a prior resolution succeeds as a no-op", async () => {
		const { posterAgent, ratingId } = await createRatedConnection("resolve-doublehide");

		const firstReportRes = await posterAgent.post(`/api/v1/ratings/${ratingId}/report`).send({ reason: "fake" });
		const firstReportId = firstReportRes.body.data.reportId;

		const { agent: adminAgent, user: admin } = await registerStudent({
			email: uniqueEmail("resolve-doublehide-admin"),
		});
		await makeAdmin(admin.userId);

		const firstResolve = await adminAgent
			.patch(`/api/v1/reports/${firstReportId}/resolve`)
			.send({ resolution: "resolved_removed", adminNotes: "First removal." });
		expect(firstResolve.status).toBe(200);

		// A second report can now be filed on the same (now-hidden) rating by a
		// different party to the connection.
		const { rows: connRows } = await pool.query(
			`SELECT initiator_id, counterpart_id FROM connections WHERE connection_id = (
         SELECT connection_id FROM ratings WHERE rating_id = $1
       )`,
			[ratingId],
		);
		expect(connRows).toHaveLength(1);

		// Insert a second open report directly — the createInterestRequest/rating
		// flow only gives us the two original parties, and the unique-open-report
		// constraint is (reporter_id, rating_id), so a second reporter is required.
		const { agent: secondReporterAgent, user: secondReporter } = await registerStudent({
			email: uniqueEmail("resolve-doublehide-reporter2"),
		});
		await pool.query(
			`INSERT INTO rating_reports (reporter_id, rating_id, reason, status)
       VALUES ($1, $2, 'other', 'open')`,
			[secondReporter.userId, ratingId],
		);
		const { rows: secondReportRows } = await pool.query(
			`SELECT report_id FROM rating_reports WHERE reporter_id = $1 AND rating_id = $2`,
			[secondReporter.userId, ratingId],
		);
		const secondReportId = secondReportRows[0].report_id;

		const secondResolve = await adminAgent
			.patch(`/api/v1/reports/${secondReportId}/resolve`)
			.send({ resolution: "resolved_removed", adminNotes: "Second removal, rating already hidden." });

		expect(secondResolve.status).toBe(200);
		expect(secondResolve.body.data.resolution).toBe("resolved_removed");

		const { rows: ratingRows } = await pool.query(`SELECT is_visible FROM ratings WHERE rating_id = $1`, [
			ratingId,
		]);
		expect(ratingRows[0].is_visible).toBe(false);
	});

	test("404 for a non-existent report", async () => {
		const { agent: adminAgent, user: admin } = await registerStudent({ email: uniqueEmail("resolve-404-admin") });
		await makeAdmin(admin.userId);

		const res = await adminAgent
			.patch(`/api/v1/reports/00000000-0000-0000-0000-000000000000/resolve`)
			.send({ resolution: "resolved_kept" });

		expect(res.status).toBe(409);
	});

	test("403 for a non-admin authenticated user", async () => {
		const { posterAgent, ratingId } = await createRatedConnection("resolve-forbidden");
		const reportRes = await posterAgent.post(`/api/v1/ratings/${ratingId}/report`).send({ reason: "other" });
		const reportId = reportRes.body.data.reportId;

		const { agent: nonAdminAgent } = await registerStudent({ email: uniqueEmail("resolve-forbidden-nonadmin") });

		const res = await nonAdminAgent
			.patch(`/api/v1/reports/${reportId}/resolve`)
			.send({ resolution: "resolved_kept" });

		expect(res.status).toBe(403);
	});

	test("rejects an invalid resolution enum value", async () => {
		const { posterAgent, ratingId } = await createRatedConnection("resolve-badenum");
		const reportRes = await posterAgent.post(`/api/v1/ratings/${ratingId}/report`).send({ reason: "other" });
		const reportId = reportRes.body.data.reportId;

		const { agent: adminAgent, user: admin } = await registerStudent({
			email: uniqueEmail("resolve-badenum-admin"),
		});
		await makeAdmin(admin.userId);

		const res = await adminAgent
			.patch(`/api/v1/reports/${reportId}/resolve`)
			.send({ resolution: "resolved_ignored" });

		expect(res.status).toBe(400);
	});
});
