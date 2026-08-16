// tests/suites/18-media-worker.test.js
//
// Covers the real media processing pipeline: enqueuePhotoUpload() creates a
// provisional `listing_photos` row + BullMQ job -> startMediaWorker() picks
// it up -> sharp compresses to webp -> storageService.upload() writes the
// real file (LocalDiskAdapter in test env, per .env.test STORAGE_ADAPTER=local)
// -> listing_photos.photo_url is updated to the real URL -> first photo is
// auto-marked as cover -> the staging file is deleted.
//
// 09-listings-photos.test.js deliberately never starts this worker (its own
// header comment says so), so every "processing:" row in that suite stays
// provisional forever. This suite is the first to actually start
// startMediaWorker() and prove the pipeline it drives — same pattern as
// 01-auth-otp-integration.test.js (real email worker) and
// 05-verification-email.test.js (real outbox drain + email worker): start
// the real worker, wait on a real BullMQ QueueEvents "completed"/"failed"
// event, then assert against real DB/filesystem state.
//
// Failure-path tests force a REAL sharp failure (a corrupt/non-image staging
// file) rather than mocking sharp — sharp(...).toBuffer() genuinely rejects
// on non-image bytes, which exercises the real worker.on("failed", ...)
// cleanup branches without faking internals.

import fs from "fs/promises";
import path from "path";
import os from "os";
import { QueueEvents } from "bullmq";
import { registerStudent } from "../setup/testAuth.js";
import { pool } from "../../src/db/client.js";
import { bullConnection } from "../../src/workers/bullConnection.js";
import { tinyJpegBuffer } from "../setup/testImage.js";

const uniqueEmail = (label) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@college.edu`;

let startMediaWorker, MEDIA_QUEUE_NAME, enqueuePhotoUpload, mediaWorker, queueEvents;

beforeAll(async () => {
	({ startMediaWorker, MEDIA_QUEUE_NAME } = await import("../../src/workers/mediaProcessor.js"));
	({ enqueuePhotoUpload } = await import("../../src/services/photo.service.js"));
	mediaWorker = startMediaWorker();
	queueEvents = new QueueEvents(MEDIA_QUEUE_NAME, { connection: bullConnection });
	await queueEvents.waitUntilReady();
});

afterAll(async () => {
	await queueEvents.close();
	await mediaWorker.close();
});

// Resolves on the first "completed"/"failed" event on the media queue after
// the listener attaches — same single-in-flight-job caveat documented in
// tests/setup/testEmail.js's waitForNextEmail: only safe with exactly one
// media job in flight for the wait window, which every test below respects.
const waitForNextMediaJob = (timeoutMs = 10000) =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			queueEvents.off("completed", onCompleted);
			queueEvents.off("failed", onFailed);
			reject(new Error(`waitForNextMediaJob: no job settled within ${timeoutMs}ms`));
		}, timeoutMs);

		const onCompleted = ({ jobId }) => {
			clearTimeout(timer);
			queueEvents.off("failed", onFailed);
			resolve({ outcome: "completed", jobId });
		};
		const onFailed = ({ jobId, failedReason }) => {
			clearTimeout(timer);
			queueEvents.off("completed", onCompleted);
			resolve({ outcome: "failed", jobId, failedReason });
		};

		queueEvents.once("completed", onCompleted);
		queueEvents.once("failed", onFailed);
	});

const studentRoomBody = (overrides = {}) => ({
	listingType: "student_room",
	title: "Room for media worker tests",
	rentPerMonth: 6000,
	roomType: "single",
	totalCapacity: 1,
	availableFrom: "2026-09-01",
	addressLine: "1 Test Street",
	city: "Delhi",
	latitude: 28.6139,
	longitude: 77.209,
	...overrides,
});

// Writes a real file to a temp staging path — the worker reads stagingPath
// off disk (via sharp(stagingPath)), so this has to be a real file, not a
// buffer in memory. Returns the absolute path.
const writeStagingFile = async (buffer, ext = ".jpg") => {
	const filePath = path.join(
		os.tmpdir(),
		`media-worker-test-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`,
	);
	await fs.writeFile(filePath, buffer);
	return filePath;
};

const createListingWithPoster = async (label) => {
	const { agent, user } = await registerStudent({ email: uniqueEmail(label) });
	const createRes = await agent.post("/api/v1/listings").send(studentRoomBody());
	if (createRes.status !== 201) {
		throw new Error(`createListingWithPoster failed (${createRes.status}): ${JSON.stringify(createRes.body)}`);
	}
	return { agent, user, listingId: createRes.body.data.listing_id };
};

describe("Media worker — real pipeline (enqueue -> sharp -> storage -> DB)", () => {
	test("processes a valid staged image into a real webp and updates the photo row", async () => {
		const { user, listingId } = await createListingWithPoster("media-ok");
		const stagingPath = await writeStagingFile(tinyJpegBuffer());

		const waitPromise = waitForNextMediaJob();
		const { photoId } = await enqueuePhotoUpload(user.userId, listingId, stagingPath, undefined);

		const { outcome } = await waitPromise;
		expect(outcome).toBe("completed");

		const { rows } = await pool.query(
			`SELECT photo_url, is_cover, deleted_at FROM listing_photos WHERE photo_id = $1`,
			[photoId],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].photo_url).not.toMatch(/^processing:/);
		expect(rows[0].photo_url).toMatch(/\.webp$/);
		expect(rows[0].photo_url).toContain(listingId);
		expect(rows[0].deleted_at).toBeNull();

		// LocalDiskAdapter in test env — assert the real file landed on disk.
		const onDiskPath = rows[0].photo_url.startsWith("/") ? rows[0].photo_url.slice(1) : rows[0].photo_url;
		const stat = await fs.stat(onDiskPath);
		expect(stat.size).toBeGreaterThan(0);

		await fs.unlink(onDiskPath).catch(() => {});
	});

	test("the first successfully processed photo is auto-marked as cover", async () => {
		const { user, listingId } = await createListingWithPoster("media-cover");
		const stagingPath = await writeStagingFile(tinyJpegBuffer());

		const waitPromise = waitForNextMediaJob();
		const { photoId } = await enqueuePhotoUpload(user.userId, listingId, stagingPath, undefined);
		await waitPromise;

		const { rows } = await pool.query(`SELECT is_cover FROM listing_photos WHERE photo_id = $1`, [photoId]);
		expect(rows[0].is_cover).toBe(true);
	});

	test("a second processed photo does not steal cover from the first", async () => {
		const { user, listingId } = await createListingWithPoster("media-cover-second");

		const firstStagingPath = await writeStagingFile(tinyJpegBuffer());
		const firstWait = waitForNextMediaJob();
		const { photoId: firstPhotoId } = await enqueuePhotoUpload(user.userId, listingId, firstStagingPath, 0);
		await firstWait;

		const secondStagingPath = await writeStagingFile(tinyJpegBuffer());
		const secondWait = waitForNextMediaJob();
		const { photoId: secondPhotoId } = await enqueuePhotoUpload(user.userId, listingId, secondStagingPath, 1);
		await secondWait;

		const { rows } = await pool.query(
			`SELECT photo_id, is_cover FROM listing_photos WHERE photo_id = ANY($1::uuid[]) ORDER BY display_order ASC`,
			[[firstPhotoId, secondPhotoId]],
		);
		expect(rows.find((r) => r.photo_id === firstPhotoId).is_cover).toBe(true);
		expect(rows.find((r) => r.photo_id === secondPhotoId).is_cover).toBe(false);
	});

	test("deletes the staging file after successful processing", async () => {
		const { user, listingId } = await createListingWithPoster("media-cleanup");
		const stagingPath = await writeStagingFile(tinyJpegBuffer());

		const waitPromise = waitForNextMediaJob();
		await enqueuePhotoUpload(user.userId, listingId, stagingPath, undefined);
		await waitPromise;

		await expect(fs.stat(stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("real photo appears via GET /listings/:id/photos once processed", async () => {
		const { agent, user, listingId } = await createListingWithPoster("media-visible");
		const stagingPath = await writeStagingFile(tinyJpegBuffer());

		const waitPromise = waitForNextMediaJob();
		await enqueuePhotoUpload(user.userId, listingId, stagingPath, undefined);
		await waitPromise;

		const res = await agent.get(`/api/v1/listings/${listingId}/photos`);

		expect(res.status).toBe(200);
		expect(res.body.data).toHaveLength(1);
		expect(res.body.data[0].photoUrl).toMatch(/\.webp$/);
	});
});

describe("Media worker — permanent failure cleanup (real sharp rejection)", () => {
	// enqueuePhotoUpload's own fileFilter/multer layer normally blocks non-image
	// uploads before they ever reach the worker (see upload.js). To exercise the
	// worker's OWN failure-cleanup branches — not multer's — we bypass the HTTP
	// layer and call enqueuePhotoUpload directly with a staging file that is
	// syntactically image-like enough to pass through to the worker but is not
	// real image data, so sharp(...).toBuffer() genuinely rejects inside the job.
	//
	// This job retries 3 times with exponential backoff (photo.service.js's
	// job options) before BullMQ marks it permanently failed. Chaining
	// QueueEvents "failed" listeners across each retry is racy — the terminal
	// event can fire in the gap between one listener's promise resolving and
	// the next once() being registered, which is exactly what happened the
	// first time this test was run (it hung the full 15s on the second wait,
	// even though the logs showed cleanup had already completed). Polling the
	// DB directly for the actual end state we care about — the row
	// soft-deleted — sidesteps that race entirely and is what the assertion
	// needs anyway.
	test("permanently-failed job soft-deletes the provisional row and cleans the staging file", async () => {
		const { user, listingId } = await createListingWithPoster("media-fail-cleanup");
		const stagingPath = await writeStagingFile(Buffer.from("not a real image, just garbage bytes"), ".jpg");

		const { photoId } = await enqueuePhotoUpload(user.userId, listingId, stagingPath, undefined);

		const deadline = Date.now() + 25000;
		let deletedAt = null;
		while (Date.now() < deadline) {
			const { rows } = await pool.query(`SELECT deleted_at FROM listing_photos WHERE photo_id = $1`, [photoId]);
			deletedAt = rows[0]?.deleted_at ?? null;
			if (deletedAt) break;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}

		expect(deletedAt).not.toBeNull();

		await expect(fs.stat(stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
	}, 30000);
});
