// tests/suites/15-notifications.test.js
//
// Covers: feed (isRead filter, cursor pagination), unread-count, mark-read
// ({ all: true } XOR { notificationIds: [...] }).
//
// Notifications are never written directly by request handlers — every row
// is a side effect of enqueueNotification() pushing a BullMQ job onto the
// "notification-delivery" queue (src/workers/notificationQueue.js), which
// notificationWorker.js consumes asynchronously and inserts with
// idempotency_key = job.id, ON CONFLICT DO NOTHING (src/workers/notificationWorker.js).
// Since src/server.js never runs in tests, that worker never starts unless a
// suite starts it itself — mirrors the pattern already established in
// 01-auth-otp-integration.test.js (real email worker) and
// 05-verification-email.test.js (drainOutbox + real email worker), just
// pointed at the notification queue instead of the email queue.
//
// Strategy: ONE real end-to-end test below drives an actual interest-request
// flow, starts the real notification worker, and waits on a QueueEvents
// "completed" event to prove the full enqueue -> worker -> INSERT pipeline
// works and produces the exact NOTIFICATION_MESSAGES text. Every other test
// in this file (feed filters, pagination, mark-read, unread-count) seeds
// notification rows directly via SQL instead of re-driving the pipeline —
// once the pipeline itself is proven, re-proving it for every read-endpoint
// assertion would only add flake risk and runtime, not coverage. This
// mirrors 09-listings-photos.test.js's stance on the media worker: the real
// pipeline is exercised once, read-endpoint behavior is tested against known
// DB state afterward.

import { QueueEvents } from "bullmq";
import request from "supertest";
import { registerStudent } from "../setup/testAuth.js";
import { pool } from "../../src/db/client.js";
import { bullConnection } from "../../src/workers/bullConnection.js";

const uniqueEmail = (label) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@college.edu`;

let startNotificationWorker, NOTIFICATION_QUEUE_NAME, app, notificationWorker, queueEvents;

beforeAll(async () => {
	({ app } = await import("../../src/app.js"));
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
// the listener attaches — same single-in-flight-job caveat documented in
// tests/setup/testEmail.js's waitForNextEmail applies here: only safe when
// exactly one notification job is expected in flight for the wait window.
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

// Seeds a notification row directly via SQL, bypassing the queue/worker
// entirely — the pipeline itself is proven once in the "real pipeline" describe
// block below; every other test just needs known rows in the notifications
// table with a specific recipient/type/is_read/created_at shape.
const seedNotification = async (recipientId, { type = "new_message", isRead = false, createdAt, message } = {}) => {
	const { rows } = await pool.query(
		`INSERT INTO notifications (recipient_id, notification_type, message, is_read, created_at)
     VALUES ($1, $2::notification_type_enum, $3, $4, COALESCE($5, NOW()))
     RETURNING notification_id, created_at`,
		[recipientId, type, message ?? null, isRead, createdAt ?? null],
	);
	return rows[0];
};

describe("Notification pipeline — real enqueue -> worker -> DB (end to end)", () => {
	test("expressing interest enqueues a real job that the worker inserts with the correct message", async () => {
		const { agent: posterAgent, user: poster } = await registerStudent({
			email: uniqueEmail("pipeline-poster"),
		});
		const createRes = await posterAgent.post("/api/v1/listings").send(studentRoomBody());
		const listingId = createRes.body.data.listing_id;

		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("pipeline-sender") });

		const waitPromise = waitForNextNotification();
		const interestRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
		expect(interestRes.status).toBe(201);

		const jobId = await waitPromise;
		expect(jobId).toEqual(expect.any(String));

		const { rows } = await pool.query(
			`SELECT recipient_id, notification_type, message, is_read, idempotency_key
       FROM notifications
       WHERE recipient_id = $1 AND notification_type = 'interest_request_received'`,
			[poster.userId],
		);

		expect(rows).toHaveLength(1);
		expect(rows[0].message).toBe("Someone expressed interest in your listing");
		expect(rows[0].is_read).toBe(false);
		expect(rows[0].idempotency_key).toEqual(expect.any(String));
	});

	test("the poster sees the real pipeline-produced notification via GET /notifications", async () => {
		const { agent: posterAgent, user: poster } = await registerStudent({
			email: uniqueEmail("pipeline-feed-poster"),
		});
		const createRes = await posterAgent.post("/api/v1/listings").send(studentRoomBody());
		const listingId = createRes.body.data.listing_id;

		const { agent: senderAgent } = await registerStudent({ email: uniqueEmail("pipeline-feed-sender") });

		const waitPromise = waitForNextNotification();
		await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
		await waitPromise;

		const res = await posterAgent.get("/api/v1/notifications");

		expect(res.status).toBe(200);
		const item = res.body.data.items.find((i) => i.type === "interest_request_received");
		expect(item).toBeDefined();
		expect(item.message).toBe("Someone expressed interest in your listing");
	});
});

describe("GET /notifications/unread-count", () => {
	test("counts only unread, non-deleted notifications for the caller", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("unread-count-ok") });
		await seedNotification(user.userId, { isRead: false });
		await seedNotification(user.userId, { isRead: false });
		await seedNotification(user.userId, { isRead: true });

		const res = await agent.get("/api/v1/notifications/unread-count");

		expect(res.status).toBe(200);
		expect(res.body.data.count).toBe(2);
	});

	test("returns 0 when the caller has no notifications", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("unread-count-empty") });

		const res = await agent.get("/api/v1/notifications/unread-count");

		expect(res.status).toBe(200);
		expect(res.body.data.count).toBe(0);
	});

	test("does not count another user's notifications", async () => {
		const { agent: callerAgent } = await registerStudent({ email: uniqueEmail("unread-count-isolation-caller") });
		const { user: other } = await registerStudent({ email: uniqueEmail("unread-count-isolation-other") });
		await seedNotification(other.userId, { isRead: false });

		const res = await callerAgent.get("/api/v1/notifications/unread-count");

		expect(res.status).toBe(200);
		expect(res.body.data.count).toBe(0);
	});

	test("requires authentication", async () => {
		const res = await request(app).get("/api/v1/notifications/unread-count");
		expect(res.status).toBe(401);
	});
});

describe("GET /notifications", () => {
	test("returns the caller's notifications ordered most-recent-first", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("feed-order") });
		const older = await seedNotification(user.userId, {
			createdAt: new Date(Date.now() - 60_000).toISOString(),
		});
		const newer = await seedNotification(user.userId, { createdAt: new Date().toISOString() });

		const res = await agent.get("/api/v1/notifications");

		expect(res.status).toBe(200);
		expect(res.body.data.items[0].notificationId).toBe(newer.notification_id);
		expect(res.body.data.items[1].notificationId).toBe(older.notification_id);
	});

	test("filters by isRead=true", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("feed-filter-read") });
		const readOne = await seedNotification(user.userId, { isRead: true });
		await seedNotification(user.userId, { isRead: false });

		const res = await agent.get("/api/v1/notifications").query({ isRead: "true" });

		expect(res.status).toBe(200);
		expect(res.body.data.items).toHaveLength(1);
		expect(res.body.data.items[0].notificationId).toBe(readOne.notification_id);
		expect(res.body.data.items[0].isRead).toBe(true);
	});

	test("filters by isRead=false", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("feed-filter-unread") });
		await seedNotification(user.userId, { isRead: true });
		const unread = await seedNotification(user.userId, { isRead: false });

		const res = await agent.get("/api/v1/notifications").query({ isRead: "false" });

		expect(res.status).toBe(200);
		expect(res.body.data.items).toHaveLength(1);
		expect(res.body.data.items[0].notificationId).toBe(unread.notification_id);
	});

	test("does not include another user's notifications", async () => {
		const { agent: callerAgent } = await registerStudent({ email: uniqueEmail("feed-isolation-caller") });
		const { user: other } = await registerStudent({ email: uniqueEmail("feed-isolation-other") });
		await seedNotification(other.userId);

		const res = await callerAgent.get("/api/v1/notifications");

		expect(res.status).toBe(200);
		expect(res.body.data.items).toHaveLength(0);
	});

	test("supports cursor pagination", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("feed-paginate") });
		for (let i = 0; i < 3; i++) {
			// Space out createdAt explicitly — seeding all three in the same tick
			// risks a real millisecond collision, which is a separate cursor edge
			// case already covered for reports in 14-reports.test.js and isn't
			// what this test is checking.
			await seedNotification(user.userId, { createdAt: new Date(Date.now() - i * 1000).toISOString() });
		}

		const firstPage = await agent.get("/api/v1/notifications").query({ limit: 2 });
		expect(firstPage.status).toBe(200);
		expect(firstPage.body.data.items).toHaveLength(2);
		expect(firstPage.body.data.nextCursor).not.toBeNull();

		const secondPage = await agent.get("/api/v1/notifications").query({
			limit: 2,
			cursorTime: firstPage.body.data.nextCursor.cursorTime,
			cursorId: firstPage.body.data.nextCursor.cursorId,
		});
		expect(secondPage.status).toBe(200);
		expect(secondPage.body.data.items).toHaveLength(1);

		const firstIds = firstPage.body.data.items.map((i) => i.notificationId);
		const secondIds = secondPage.body.data.items.map((i) => i.notificationId);
		expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
	});

	test("rejects cursorTime without cursorId", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("feed-partialcursor") });

		const res = await agent.get("/api/v1/notifications").query({ cursorTime: new Date().toISOString() });

		expect(res.status).toBe(400);
	});

	test("requires authentication", async () => {
		const res = await request(app).get("/api/v1/notifications");
		expect(res.status).toBe(401);
	});
});

describe("POST /notifications/mark-read", () => {
	test("marks specific notificationIds as read", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("markread-ids") });
		const a = await seedNotification(user.userId, { isRead: false });
		const b = await seedNotification(user.userId, { isRead: false });

		const res = await agent.post("/api/v1/notifications/mark-read").send({
			notificationIds: [a.notification_id],
		});

		expect(res.status).toBe(200);
		expect(res.body.data.updated).toBe(1);

		const { rows } = await pool.query(
			`SELECT notification_id, is_read FROM notifications WHERE notification_id = ANY($1::uuid[])`,
			[[a.notification_id, b.notification_id]],
		);
		const byId = Object.fromEntries(rows.map((r) => [r.notification_id, r.is_read]));
		expect(byId[a.notification_id]).toBe(true);
		expect(byId[b.notification_id]).toBe(false);
	});

	test("marks all unread notifications as read with { all: true }", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("markread-all") });
		await seedNotification(user.userId, { isRead: false });
		await seedNotification(user.userId, { isRead: false });
		await seedNotification(user.userId, { isRead: true }); // already read — not counted in `updated`

		const res = await agent.post("/api/v1/notifications/mark-read").send({ all: true });

		expect(res.status).toBe(200);
		expect(res.body.data.updated).toBe(2);

		const { rows } = await pool.query(
			`SELECT COUNT(*)::int AS cnt FROM notifications WHERE recipient_id = $1 AND is_read = FALSE`,
			[user.userId],
		);
		expect(rows[0].cnt).toBe(0);
	});

	test("does not mark another user's notifications as read", async () => {
		const { agent: callerAgent } = await registerStudent({
			email: uniqueEmail("markread-isolation-caller"),
		});
		const { user: other } = await registerStudent({ email: uniqueEmail("markread-isolation-other") });
		const otherNotif = await seedNotification(other.userId, { isRead: false });

		await callerAgent.post("/api/v1/notifications/mark-read").send({ all: true });

		const { rows } = await pool.query(`SELECT is_read FROM notifications WHERE notification_id = $1`, [
			otherNotif.notification_id,
		]);
		expect(rows[0].is_read).toBe(false);
	});

	test("rejects a body with neither all nor notificationIds", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("markread-empty") });

		const res = await agent.post("/api/v1/notifications/mark-read").send({});

		expect(res.status).toBe(400);
	});

	test("rejects a body with both all and notificationIds (mutually exclusive)", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("markread-both") });
		const a = await seedNotification(user.userId, { isRead: false });

		const res = await agent.post("/api/v1/notifications/mark-read").send({
			all: true,
			notificationIds: [a.notification_id],
		});

		expect(res.status).toBe(400);
	});

	test("rejects an empty notificationIds array", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("markread-emptyids") });

		const res = await agent.post("/api/v1/notifications/mark-read").send({ notificationIds: [] });

		expect(res.status).toBe(400);
	});

	test("rejects a malformed UUID in notificationIds", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("markread-baduuid") });

		const res = await agent.post("/api/v1/notifications/mark-read").send({ notificationIds: ["not-a-uuid"] });

		expect(res.status).toBe(400);
	});

	test("marking an already-read notification again is a harmless no-op (updated: 0)", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("markread-idempotent") });
		const a = await seedNotification(user.userId, { isRead: true });

		const res = await agent.post("/api/v1/notifications/mark-read").send({ notificationIds: [a.notification_id] });

		expect(res.status).toBe(200);
		expect(res.body.data.updated).toBe(0);
	});

	test("requires authentication", async () => {
		const res = await request(app).post("/api/v1/notifications/mark-read").send({ all: true });
		expect(res.status).toBe(401);
	});
});
