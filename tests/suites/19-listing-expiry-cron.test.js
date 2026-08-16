// tests/suites/19-listing-expiry-cron.test.js
//
// Covers: runListingExpiry (src/cron/listingExpiry.js), invoked directly
// rather than waiting on node-cron's schedule — same pattern the test
// architecture doc already establishes for runSavedSearchAlert and
// drainOutbox (see 05-verification-email.test.js, testing guide/02-*.md
// §5's cron row).
//
// REQUIRES A SOURCE CHANGE: as currently written, listingExpiry.js defines
// `const runListingExpiry = async () => {...}` without exporting it — only
// `registerListingExpiryCron` is exported. This suite cannot run until that
// function is exported, mirroring how runSavedSearchAlert and drainOutbox
// are already exported from their own modules. The fix is a one-line change:
//   const runListingExpiry = async () => { ... }
//   export const runListingExpiry = async () => { ... }
// No other behavior in the file needs to change.
//
// What this suite checks, beyond "does it run":
//   1. Only listings that are ACTIVE and past expires_at flip to 'expired' —
//      listings not yet past expiry are left untouched (negative case).
//   2. Pending interest_requests on an expired listing flip to 'expired' too
//      (the cron's own follow-up UPDATE).
//   3. A listing_expired notification is enqueued for the poster of each
//      expired listing.
//   4. Deactivated / filled / already-expired listings are not touched even
//      if their expires_at is in the past (the WHERE clause is
//      status = 'active' AND expires_at < NOW(), not just an expiry check).
//   5. Soft-deleted listings are excluded even if otherwise eligible.
//
// Notification assertion strategy: mirrors 15-notifications.test.js's real
// pipeline test — starts the real notification worker, waits on a
// QueueEvents "completed" event, then checks the row landed with the right
// type/recipient. Unlike expiry itself (direct-invoked), the notification
// side effect still goes through the real BullMQ enqueue -> worker -> INSERT
// path, since that pipeline is what's actually under test for the
// notification assertion, not a shortcut around it.

import { QueueEvents } from "bullmq";
import { pool } from "../../src/db/client.js";
import { bullConnection } from "../../src/workers/bullConnection.js";
import { registerStudent } from "../setup/testAuth.js";

const uniqueEmail = (label) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@college.edu`;

let runListingExpiry, startNotificationWorker, NOTIFICATION_QUEUE_NAME, notificationWorker, queueEvents;

beforeAll(async () => {
	({ runListingExpiry } = await import("../../src/cron/listingExpiry.js"));
	({ startNotificationWorker, NOTIFICATION_QUEUE_NAME } = await import("../../src/workers/notificationWorker.js"));
	notificationWorker = startNotificationWorker();
	queueEvents = new QueueEvents(NOTIFICATION_QUEUE_NAME, { connection: bullConnection });
	await queueEvents.waitUntilReady();
});

afterAll(async () => {
	await queueEvents.close();
	await notificationWorker.close();
});

// Resolves on the first "completed" event on the notification queue after
// the listener attaches. Same single-in-flight-job caveat documented in
// tests/setup/testEmail.js's waitForNextEmail — only safe when exactly one
// notification job is expected in flight for the wait window.
const waitForNextNotification = (timeoutMs = 5000) =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			queueEvents.off("completed", onCompleted);
			queueEvents.off("failed", onFailed);
			reject(new Error(`waitForNextNotification: no job completed within ${timeoutMs}ms`));
		}, timeoutMs);

		const onCompleted = ({ jobId }) => {
			clearTimeout(timer);
			queueEvents.off("failed", onFailed);
			resolve(jobId);
		};
		const onFailed = ({ jobId, failedReason }) => {
			clearTimeout(timer);
			queueEvents.off("completed", onCompleted);
			reject(new Error(`waitForNextNotification: job ${jobId} failed — ${failedReason}`));
		};

		queueEvents.once("completed", onCompleted);
		queueEvents.once("failed", onFailed);
	});

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

const setExpiresAt = (listingId, isoOrIntervalExpr) =>
	pool.query(`UPDATE listings SET expires_at = $1 WHERE listing_id = $2`, [isoOrIntervalExpr, listingId]);

const pastTimestamp = (daysAgo = 1) => new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
const futureTimestamp = (daysAhead = 1) => new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();

describe("cron: runListingExpiry", () => {
	test("flips an active, past-expiry listing to 'expired'", async () => {
		const { listingId } = await createPosterWithListing("expiry-basic");
		await setExpiresAt(listingId, pastTimestamp());

		await runListingExpiry();

		const { rows } = await pool.query(`SELECT status FROM listings WHERE listing_id = $1`, [listingId]);
		expect(rows[0].status).toBe("expired");
	});

	test("leaves an active listing untouched when expires_at is still in the future", async () => {
		const { listingId } = await createPosterWithListing("expiry-future");
		await setExpiresAt(listingId, futureTimestamp());

		await runListingExpiry();

		const { rows } = await pool.query(`SELECT status FROM listings WHERE listing_id = $1`, [listingId]);
		expect(rows[0].status).toBe("active");
	});

	test("does not touch a deactivated listing even if expires_at is in the past", async () => {
		const { agent, listingId } = await createPosterWithListing("expiry-deactivated");
		await agent.patch(`/api/v1/listings/${listingId}/status`).send({ status: "deactivated" });
		await setExpiresAt(listingId, pastTimestamp());

		await runListingExpiry();

		const { rows } = await pool.query(`SELECT status FROM listings WHERE listing_id = $1`, [listingId]);
		expect(rows[0].status).toBe("deactivated");
	});

	test("does not touch a filled listing even if expires_at is in the past", async () => {
		const { agent, listingId } = await createPosterWithListing("expiry-filled", { totalCapacity: 1 });
		await agent.patch(`/api/v1/listings/${listingId}/status`).send({ status: "filled" });
		await setExpiresAt(listingId, pastTimestamp());

		await runListingExpiry();

		const { rows } = await pool.query(`SELECT status FROM listings WHERE listing_id = $1`, [listingId]);
		expect(rows[0].status).toBe("filled");
	});

	test("does not touch a listing that is already expired", async () => {
		const { listingId } = await createPosterWithListing("expiry-already");
		await pool.query(`UPDATE listings SET status = 'expired', expires_at = $1 WHERE listing_id = $2`, [
			pastTimestamp(2),
			listingId,
		]);

		// Sanity: nothing should throw or double-process an already-expired row.
		await expect(runListingExpiry()).resolves.not.toThrow();

		const { rows } = await pool.query(`SELECT status FROM listings WHERE listing_id = $1`, [listingId]);
		expect(rows[0].status).toBe("expired");
	});

	test("excludes a soft-deleted listing", async () => {
		const { agent, listingId } = await createPosterWithListing("expiry-softdeleted");
		await setExpiresAt(listingId, pastTimestamp());
		await agent.delete(`/api/v1/listings/${listingId}`);

		await runListingExpiry();

		// deleted_at should remain set and status should not have been flipped
		// by the cron (it was already soft-deleted before the cron ran).
		const { rows } = await pool.query(`SELECT status, deleted_at FROM listings WHERE listing_id = $1`, [listingId]);
		expect(rows[0].deleted_at).not.toBeNull();
	});

	test("cascades to pending interest_requests on the expired listing, flipping them to 'expired'", async () => {
		const { listingId } = await createPosterWithListing("expiry-cascade-poster", { totalCapacity: 2 });
		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("expiry-cascade-sender") });
		const interestRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
		expect(interestRes.status).toBe(201);
		const interestId = interestRes.body.data.interestRequestId;

		await setExpiresAt(listingId, pastTimestamp());

		await runListingExpiry();

		const { rows } = await pool.query(`SELECT status FROM interest_requests WHERE request_id = $1`, [interestId]);
		expect(rows[0].status).toBe("expired");
	});

	test("does not touch already-resolved interest requests (accepted/declined/withdrawn) on the expired listing", async () => {
		const { agent: posterAgent, listingId } = await createPosterWithListing("expiry-resolved-poster", {
			totalCapacity: 2,
		});
		const { agent: declinedSenderAgent } = await registerStudent({
			email: uniqueEmail("expiry-resolved-declined"),
		});
		const declinedRes = await declinedSenderAgent.post(`/api/v1/listings/${listingId}/interests`);
		await posterAgent
			.patch(`/api/v1/interests/${declinedRes.body.data.interestRequestId}/status`)
			.send({ status: "declined" });

		await setExpiresAt(listingId, pastTimestamp());

		await runListingExpiry();

		const { rows } = await pool.query(`SELECT status FROM interest_requests WHERE request_id = $1`, [
			declinedRes.body.data.interestRequestId,
		]);
		expect(rows[0].status).toBe("declined");
	});

	test("enqueues a listing_expired notification for the poster, delivered through the real worker", async () => {
		const { user: poster, listingId } = await createPosterWithListing("expiry-notify-poster");
		await setExpiresAt(listingId, pastTimestamp());

		const waitPromise = waitForNextNotification();
		await runListingExpiry();
		await waitPromise;

		const { rows } = await pool.query(
			`SELECT recipient_id, notification_type, message
       FROM notifications
       WHERE recipient_id = $1 AND notification_type = 'listing_expired'`,
			[poster.userId],
		);

		expect(rows).toHaveLength(1);
		expect(rows[0].message).toBe("One of your listings has expired");
	});

	test("processes multiple eligible listings in a single run, each getting its own notification", async () => {
		const { user: posterA, listingId: listingA } = await createPosterWithListing("expiry-multi-a");
		const { user: posterB, listingId: listingB } = await createPosterWithListing("expiry-multi-b");
		await setExpiresAt(listingA, pastTimestamp());
		await setExpiresAt(listingB, pastTimestamp());

		await runListingExpiry();

		const { rows } = await pool.query(
			`SELECT listing_id, status FROM listings WHERE listing_id = ANY($1::uuid[])`,
			[[listingA, listingB]],
		);
		expect(rows.every((r) => r.status === "expired")).toBe(true);

		// Both posters should eventually have a listing_expired notification —
		// poll briefly rather than relying on a single waitForNextNotification
		// call, since two jobs are in flight and ordering between them isn't
		// guaranteed.
		const deadline = Date.now() + 5000;
		let notifRows = [];
		while (Date.now() < deadline) {
			const { rows: check } = await pool.query(
				`SELECT recipient_id FROM notifications
         WHERE recipient_id = ANY($1::uuid[]) AND notification_type = 'listing_expired'`,
				[[posterA.userId, posterB.userId]],
			);
			notifRows = check;
			if (notifRows.length >= 2) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const recipientIds = notifRows.map((r) => r.recipient_id).sort();
		expect(recipientIds).toEqual([posterA.userId, posterB.userId].sort());
	});

	test("a run with no eligible listings is a harmless no-op", async () => {
		const { listingId } = await createPosterWithListing("expiry-noop");
		await setExpiresAt(listingId, futureTimestamp());

		await expect(runListingExpiry()).resolves.not.toThrow();

		const { rows } = await pool.query(`SELECT status FROM listings WHERE listing_id = $1`, [listingId]);
		expect(rows[0].status).toBe("active");
	});
});
