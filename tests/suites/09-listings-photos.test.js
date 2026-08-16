// tests/suites/09-listings-photos.test.js
//
// Covers: upload (202 processing), get (owner sees processing rows via
// skipValidation-equivalent ownerId check; guests don't), delete, set-cover,
// reorder, cap-of-5.
//
// IMPORTANT: since src/server.js never runs in tests, startMediaWorker()
// never starts. Every uploaded photo stays permanently in the provisional
// `processing:<photoId>` state — enqueuePhotoUpload() only INSERTs the
// provisional row and pushes a BullMQ job; nothing ever consumes it. This
// suite therefore tests the enqueue CONTRACT (202, row exists with
// photo_url starting with 'processing:', cap counts these rows, non-owner
// GET excludes them) — never a final photoUrl, since the worker that would
// produce one never runs.
//
// Because getListingPhotos() filters `photo_url NOT LIKE 'processing:%'`
// unconditionally, and setCoverPhoto/reorderPhotos also filter processing
// rows out of their own queries, most "processing-state" assertions have to
// go through direct SQL against listing_photos rather than the read
// endpoints — the endpoints are deliberately blind to in-flight uploads.

import { pool } from "../../src/db/client.js";
import { registerStudent } from "../setup/testAuth.js";
import { tinyJpegBuffer } from "../setup/testImage.js";

const uniqueEmail = (label) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@college.edu`;

const createListing = async (agent, overrides = {}) => {
	const res = await agent.post("/api/v1/listings").send({
		listingType: "student_room",
		title: "Room for photo tests",
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
	return res.body.data.listing_id;
};

const attachPhoto = (agent, listingId, filename = "photo.jpg") =>
	agent
		.post(`/api/v1/listings/${listingId}/photos`)
		.attach("photo", tinyJpegBuffer(), { filename, contentType: "image/jpeg" });

describe("POST /listings/:listingId/photos", () => {
	test("enqueues an upload and returns 202 processing", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("upload-ok") });
		const listingId = await createListing(agent);

		const res = await attachPhoto(agent, listingId);

		expect(res.status).toBe(202);
		expect(res.body.data.status).toBe("processing");
		expect(res.body.data.photoId).toEqual(expect.any(String));

		const { rows } = await pool.query(`SELECT photo_url FROM listing_photos WHERE photo_id = $1`, [
			res.body.data.photoId,
		]);
		expect(rows[0].photo_url).toBe(`processing:${res.body.data.photoId}`);
	});

	test("rejects upload with no file with 400", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("upload-nofile") });
		const listingId = await createListing(agent);

		const res = await agent.post(`/api/v1/listings/${listingId}/photos`);

		expect(res.status).toBe(400);
	});

	test("rejects upload of an unsupported file type", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("upload-badtype") });
		const listingId = await createListing(agent);

		const res = await agent
			.post(`/api/v1/listings/${listingId}/photos`)
			.attach("photo", Buffer.from("not an image"), { filename: "notes.txt", contentType: "text/plain" });

		expect(res.status).toBe(400);
	});

	test("enforces the cap of 5 photos per listing", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("upload-cap") });
		const listingId = await createListing(agent);

		for (let i = 0; i < 5; i++) {
			const res = await attachPhoto(agent, listingId, `photo${i}.jpg`);
			expect(res.status).toBe(202);
		}

		const sixthRes = await attachPhoto(agent, listingId, "photo6.jpg");

		expect(sixthRes.status).toBe(422);
	});

	test("404 when uploading to a listing that does not belong to the poster", async () => {
		const { agent: ownerAgent } = await registerStudent({ email: uniqueEmail("upload-owner") });
		const listingId = await createListing(ownerAgent);

		const { agent: attackerAgent } = await registerStudent({ email: uniqueEmail("upload-attacker") });

		const res = await attachPhoto(attackerAgent, listingId);

		expect(res.status).toBe(404);
	});
});

describe("GET /listings/:listingId/photos", () => {
	test("returns an empty array when no processed photos exist yet", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("get-empty") });
		const listingId = await createListing(agent);

		await attachPhoto(agent, listingId);

		// The uploaded photo is still `processing:<id>` since the media worker
		// never runs in tests — getListingPhotos() filters those out
		// unconditionally, so the owner sees an empty list too, not just guests.
		const res = await agent.get(`/api/v1/listings/${listingId}/photos`);

		expect(res.status).toBe(200);
		expect(res.body.data).toEqual([]);
	});

	test("404 for a non-existent listing", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("get-404") });

		const res = await agent.get(`/api/v1/listings/00000000-0000-0000-0000-000000000000/photos`);

		expect(res.status).toBe(404);
	});
});

describe("DELETE /listings/:listingId/photos/:photoId", () => {
	test("soft-deletes a photo owned by the poster, even while still processing", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("delete-ok") });
		const listingId = await createListing(agent);
		const uploadRes = await attachPhoto(agent, listingId);
		const photoId = uploadRes.body.data.photoId;

		const res = await agent.delete(`/api/v1/listings/${listingId}/photos/${photoId}`);

		expect(res.status).toBe(200);
		expect(res.body.data.deleted).toBe(true);

		const { rows } = await pool.query(`SELECT deleted_at FROM listing_photos WHERE photo_id = $1`, [photoId]);
		expect(rows[0].deleted_at).not.toBeNull();
	});

	test("404 for a non-existent photo", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("delete-404") });
		const listingId = await createListing(agent);

		const res = await agent.delete(`/api/v1/listings/${listingId}/photos/00000000-0000-0000-0000-000000000000`);

		expect(res.status).toBe(404);
	});

	test("404 when a non-owner tries to delete a photo", async () => {
		const { agent: ownerAgent } = await registerStudent({ email: uniqueEmail("delete-owner") });
		const listingId = await createListing(ownerAgent);
		const uploadRes = await attachPhoto(ownerAgent, listingId);
		const photoId = uploadRes.body.data.photoId;

		const { agent: attackerAgent } = await registerStudent({ email: uniqueEmail("delete-attacker") });

		const res = await attackerAgent.delete(`/api/v1/listings/${listingId}/photos/${photoId}`);

		expect(res.status).toBe(404);
	});
});

describe("PATCH /listings/:listingId/photos/:photoId/cover", () => {
	// setCoverPhoto's query filters `photo_url NOT LIKE 'processing:%'`, so a
	// still-processing photo (the only kind this test env can produce) is
	// invisible to it and reports 404 "not found or still processing" — this
	// is the correct, current contract to assert against, not a limitation of
	// the test.
	test("404 when the target photo is still processing", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("cover-processing") });
		const listingId = await createListing(agent);
		const uploadRes = await attachPhoto(agent, listingId);
		const photoId = uploadRes.body.data.photoId;

		const res = await agent.patch(`/api/v1/listings/${listingId}/photos/${photoId}/cover`);

		expect(res.status).toBe(404);
	});

	test("sets cover once the photo is manually marked processed", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("cover-ok") });
		const listingId = await createListing(agent);
		const uploadRes = await attachPhoto(agent, listingId);
		const photoId = uploadRes.body.data.photoId;

		// Simulate what the media worker would have done — swap the
		// placeholder URL for a real one — since the worker never runs here.
		await pool.query(`UPDATE listing_photos SET photo_url = $1 WHERE photo_id = $2`, [
			`/uploads/listings/${listingId}/${photoId}.webp`,
			photoId,
		]);

		const res = await agent.patch(`/api/v1/listings/${listingId}/photos/${photoId}/cover`);

		expect(res.status).toBe(200);
		expect(res.body.data.isCover).toBe(true);
	});
});

describe("PUT /listings/:listingId/photos/reorder", () => {
	test("reorders processed photos", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("reorder-ok") });
		const listingId = await createListing(agent);

		const upload1 = await attachPhoto(agent, listingId, "one.jpg");
		const upload2 = await attachPhoto(agent, listingId, "two.jpg");
		const photoId1 = upload1.body.data.photoId;
		const photoId2 = upload2.body.data.photoId;

		// Promote both out of processing state so reorderPhotos' queries can see them.
		await pool.query(
			`UPDATE listing_photos SET photo_url = 'https://example.com/' || photo_id || '.webp'
       WHERE photo_id = ANY($1::uuid[])`,
			[[photoId1, photoId2]],
		);

		const res = await agent.put(`/api/v1/listings/${listingId}/photos/reorder`).send({
			photos: [
				{ photoId: photoId2, displayOrder: 0 },
				{ photoId: photoId1, displayOrder: 1 },
			],
		});

		expect(res.status).toBe(200);
		expect(res.body.data[0].photoId).toBe(photoId2);
		expect(res.body.data[1].photoId).toBe(photoId1);
	});

	test("rejects a reorder payload with duplicate photoIds", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("reorder-dup") });
		const listingId = await createListing(agent);
		const upload1 = await attachPhoto(agent, listingId, "one.jpg");
		const photoId1 = upload1.body.data.photoId;

		await pool.query(`UPDATE listing_photos SET photo_url = 'https://example.com/x.webp' WHERE photo_id = $1`, [
			photoId1,
		]);

		const res = await agent.put(`/api/v1/listings/${listingId}/photos/reorder`).send({
			photos: [
				{ photoId: photoId1, displayOrder: 0 },
				{ photoId: photoId1, displayOrder: 1 },
			],
		});

		expect(res.status).toBe(400);
	});

	test("rejects a reorder payload missing a currently-processed photo", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("reorder-incomplete") });
		const listingId = await createListing(agent);
		const upload1 = await attachPhoto(agent, listingId, "one.jpg");
		const upload2 = await attachPhoto(agent, listingId, "two.jpg");
		const photoId1 = upload1.body.data.photoId;
		const photoId2 = upload2.body.data.photoId;

		await pool.query(
			`UPDATE listing_photos SET photo_url = 'https://example.com/' || photo_id || '.webp'
       WHERE photo_id = ANY($1::uuid[])`,
			[[photoId1, photoId2]],
		);

		const res = await agent.put(`/api/v1/listings/${listingId}/photos/reorder`).send({
			photos: [{ photoId: photoId1, displayOrder: 0 }],
		});

		expect(res.status).toBe(422);
	});
});
