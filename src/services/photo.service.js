// src/services/photo.service.js
//
// Handles all database operations for listing photos.
//
// THE SPLIT BETWEEN THIS FILE AND THE WORKER:
// This service is responsible for everything that must happen synchronously
// within the HTTP request/response cycle: validating ownership, writing the
// provisional DB row, enqueueing the BullMQ job, and returning 202 Accepted.
// The worker (src/workers/mediaProcessor.js) is responsible for everything
// that happens asynchronously after the response is sent: Sharp processing,
// final storage write, URL update, staging file cleanup, and cover election.
//
// Neither half does the other's job. This split is the reason the user sees
// a response in ~50ms regardless of how long Sharp takes.

import path from "path";
import crypto from "crypto";
import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";
import { storageService } from "../storage/index.js";
import { MEDIA_QUEUE_NAME } from "../workers/mediaProcessor.js";
import { getQueue } from "../workers/queue.js";

// ─── Upload photo (synchronous half) ─────────────────────────────────────────

// Called by the controller immediately after Multer has written the staged file.
// Does four things and returns:
//   1. Verifies the listing exists and belongs to posterId
//   2. Allocates display_order server-side — always, ignoring any client hint
//   3. Inserts a provisional listing_photos row (photo_url = placeholder)
//   4. Enqueues a BullMQ job carrying the photoId and staging path
//
// Returns { photoId, status: 'processing' } — the client polls GET photos
// to observe when the real URL replaces the placeholder.
//
// ─── WHY display_order IS ALWAYS COMPUTED SERVER-SIDE ────────────────────────
//
// display_order is allocated by reading MAX(display_order) + 1 from
// listing_photos while holding a row-level lock on the parent listing row.
// The client-supplied displayOrder hint is intentionally ignored: accepting
// it would bypass the allocation query and allow two concurrent uploads for
// the same listing to insert with the same display_order value (a duplicate
// that cannot be caught without a UNIQUE index on the column). The server-side
// allocation under the listing lock is the only correct approach.
//
// ─── WHY WE LOCK THE PARENT LISTING ROW ──────────────────────────────────────
//
// Without serialisation, two concurrent uploads for the same listing can both
// read the same MAX and both insert with the same order value. The correct
// serialisation point is the parent listing row, not the photo rows themselves.
// Locking the listing row (SELECT … FOR UPDATE) makes all concurrent uploads
// for that listing queue behind each other. The first upload reads MAX,
// inserts, and commits; only then does the next upload proceed and read the
// updated MAX. This gives atomic, gap-free, monotonically increasing order
// values without any application-level retry logic.
//
// We use the parent listing row rather than locking the photo rows because:
//   a) On the very first upload there are no photo rows to lock — a FOR UPDATE
//      on an empty result set acquires no lock and closes the race window
//      entirely, which is the opposite of what we want.
//   b) The listing row is a stable, always-present target that exists from the
//      moment the listing is created through its entire lifetime.
export const enqueuePhotoUpload = async (posterId, listingId, stagingPath) => {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		// Step 1 + lock: verify ownership and lock the listing row in one query.
		// FOR UPDATE acquires a row-level lock on the listing, serialising all
		// concurrent uploads for this listing through a single queue behind it.
		// A non-owner or non-existent listing produces zero rows → 404.
		const { rows: listingRows } = await client.query(
			`SELECT listing_id
       FROM listings
       WHERE listing_id = $1
         AND posted_by  = $2
         AND deleted_at IS NULL
       FOR UPDATE`,
			[listingId, posterId],
		);
		if (!listingRows.length) {
			await client.query("ROLLBACK");
			throw new AppError("Listing not found", 404);
		}

		// Step 2: allocate display_order server-side.
		// Now that we hold the listing lock, no other transaction can insert a new
		// photo row for this listing until we commit. MAX() is therefore stable and
		// gap-free. COALESCE handles the first-photo case (MAX returns NULL → start at 0).
		// The client-supplied displayOrder hint is deliberately not used here —
		// accepting it would allow duplicate order values from concurrent uploads.
		const { rows: orderRows } = await client.query(
			`SELECT COALESCE(MAX(display_order), -1) + 1 AS next_order
         FROM listing_photos
         WHERE listing_id = $1
           AND deleted_at IS NULL`,
			[listingId],
		);
		const order = orderRows[0].next_order;

		// Step 3: insert the provisional photo row while holding the lock.
		// The placeholder URL sentinel prevents the photo from being served before
		// the worker replaces it with the real WebP URL.
		const photoId = crypto.randomUUID();
		const placeholderUrl = `processing:${photoId}`;

		await client.query(
			`INSERT INTO listing_photos
         (photo_id, listing_id, photo_url, is_cover, display_order)
       VALUES ($1, $2, $3, FALSE, $4)`,
			[photoId, listingId, placeholderUrl, order],
		);

		await client.query("COMMIT");

		// Step 4: enqueue the BullMQ processing job after committing.
		// The job is enqueued outside the transaction because BullMQ writes to
		// Redis, not Postgres. Enqueueing inside the transaction would tie the
		// Redis write to the Postgres commit boundary, and a Redis failure would
		// cause an unnecessary Postgres rollback. Doing it after commit means the
		// photo row exists before the worker can possibly run — no orphaned jobs.
		const queue = getQueue(MEDIA_QUEUE_NAME);
		await queue.add(
			"process-photo",
			{ listingId, photoId, stagingPath, posterId },
			{
				attempts: 3,
				backoff: { type: "exponential", delay: 2000 },
				removeOnComplete: 100,
				removeOnFail: 200,
			},
		);

		logger.info({ posterId, listingId, photoId, stagingPath, displayOrder: order }, "Photo upload enqueued");

		return { photoId, status: "processing" };
	} catch (err) {
		// Roll back if anything fails between BEGIN and COMMIT. If ROLLBACK
		// itself fails (e.g. the connection is broken), we log and still
		// re-throw the original error so the HTTP response is a 5xx, not a hang.
		try {
			await client.query("ROLLBACK");
		} catch (rollbackErr) {
			logger.error({ rollbackErr, err }, "enqueuePhotoUpload: rollback failed");
		}
		throw err;
	} finally {
		client.release();
	}
};

// ─── Get photos for a listing ─────────────────────────────────────────────────

// Returns all non-deleted, non-placeholder photos for a listing, ordered by
// display_order ASC. Placeholder rows (photo_url starting with 'processing:')
// are excluded from this response — the client only sees completed photos.
// This means a photo that is still being processed is invisible until ready.
export const getListingPhotos = async (listingId) => {
	const { rows } = await pool.query(
		`SELECT
       photo_id       AS "photoId",
       photo_url      AS "photoUrl",
       is_cover       AS "isCover",
       display_order  AS "displayOrder",
       uploaded_at     AS "createdAt"
     FROM listing_photos
     WHERE listing_id = $1
       AND deleted_at IS NULL
       AND photo_url NOT LIKE 'processing:%'
     ORDER BY display_order ASC`,
		[listingId],
	);
	return rows;
};

// ─── Delete photo ─────────────────────────────────────────────────────────────

// Soft-deletes the photo row and deletes the file from storage. If the deleted
// photo was the cover, elects the next photo as cover.
//
// The operation order is deliberate:
//   1. Soft-delete the DB row first (inside a transaction with cover election)
//   2. Call storageService.delete() AFTER committing the transaction
//
// This order ensures that if the storage delete fails, the DB row is already
// soft-deleted — the photo won't be served to users, and the orphaned file
// will be cleaned up by a maintenance cron. The reverse order (delete file
// first, then DB row) risks serving a broken URL if the DB write fails after
// the file is already gone.
export const deletePhoto = async (posterId, listingId, photoId) => {
	// Fetch the photo row to verify ownership (via the listing) and get the URL
	// for the storage delete call.
	const { rows } = await pool.query(
		`SELECT lp.photo_url, lp.is_cover
     FROM listing_photos lp
     JOIN listings l ON l.listing_id = lp.listing_id
     WHERE lp.photo_id   = $1
       AND lp.listing_id = $2
       AND l.posted_by   = $3
       AND lp.deleted_at IS NULL`,
		[photoId, listingId, posterId],
	);

	if (!rows.length) throw new AppError("Photo not found", 404);
	const { photo_url: photoUrl, is_cover: wasCover } = rows[0];

	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		// Soft-delete the photo row
		await client.query(`UPDATE listing_photos SET deleted_at = NOW() WHERE photo_id = $1`, [photoId]);

		// If this was the cover photo, elect the next one.
		// Fix: PostgreSQL does not support UPDATE ... ORDER BY ... LIMIT; use a subquery instead.
		if (wasCover) {
			await client.query(
				`UPDATE listing_photos
         SET is_cover = TRUE
         WHERE photo_id = (
           SELECT photo_id FROM listing_photos
           WHERE listing_id = $1
             AND deleted_at IS NULL
             AND photo_url  NOT LIKE 'processing:%'
           ORDER BY display_order ASC
           LIMIT 1
         )`,
				[listingId],
			);
		}

		await client.query("COMMIT");
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}

	// Storage delete happens after the transaction commits. If this throws, the
	// DB row is already soft-deleted (photo not served) and the file becomes an
	// orphan for the maintenance cron to clean up. We log the error but do not
	// re-throw — from the poster's perspective the photo is deleted.
	if (!photoUrl.startsWith("processing:")) {
		try {
			await storageService.delete(photoUrl);
		} catch (storageErr) {
			logger.error(
				{ photoId, photoUrl, err: storageErr },
				"Storage delete failed after DB soft-delete — orphaned file will be cleaned by cron",
			);
		}
	}

	logger.info({ posterId, listingId, photoId }, "Photo deleted");
	return { photoId, deleted: true };
};

// ─── Set cover photo ──────────────────────────────────────────────────────────

// Explicitly sets a specific photo as the cover. Clears the existing cover in
// the same transaction so the partial unique index (WHERE is_cover = TRUE AND
// deleted_at IS NULL) is never violated.
//
// Both operations run inside one transaction. PostgreSQL defers unique index
// checks to the end of the statement by default for most index types, but
// explicitly clearing first is clearer and avoids any ambiguity.
export const setCoverPhoto = async (posterId, listingId, photoId) => {
	// Verify ownership and that the photo exists, is processed (not placeholder),
	// and is not already the cover (minor optimisation — not a correctness issue).
	const { rows } = await pool.query(
		`SELECT lp.is_cover
     FROM listing_photos lp
     JOIN listings l ON l.listing_id = lp.listing_id
     WHERE lp.photo_id   = $1
       AND lp.listing_id = $2
       AND l.posted_by   = $3
       AND lp.deleted_at IS NULL
       AND lp.photo_url  NOT LIKE 'processing:%'`,
		[photoId, listingId, posterId],
	);

	if (!rows.length) {
		throw new AppError("Photo not found or still processing", 404);
	}
	if (rows[0].is_cover) {
		// Already the cover — idempotent, return success without a DB write
		return { photoId, isCover: true };
	}

	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		// Clear the existing cover (if any) first
		await client.query(
			`UPDATE listing_photos
       SET is_cover = FALSE
       WHERE listing_id = $1 AND is_cover = TRUE AND deleted_at IS NULL`,
			[listingId],
		);

		// Set the new cover
		await client.query(`UPDATE listing_photos SET is_cover = TRUE WHERE photo_id = $1`, [photoId]);

		await client.query("COMMIT");
		logger.info({ posterId, listingId, photoId }, "Cover photo updated");
		return { photoId, isCover: true };
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
};

// ─── Reorder photos ───────────────────────────────────────────────────────────

// Accepts an array of { photoId, displayOrder } and updates each row in a
// single transaction. Uses individual UPDATE statements rather than a bulk
// UPDATE ... FROM ... VALUES pattern for simplicity — the array is bounded
// by the number of photos per listing (typically ≤ 10), so N individual
// updates inside one transaction is completely acceptable.
export const reorderPhotos = async (posterId, listingId, photos) => {
	// Verify ownership once before touching any rows
	const { rows: ownerCheck } = await pool.query(
		`SELECT 1 FROM listings
     WHERE listing_id = $1 AND posted_by = $2 AND deleted_at IS NULL`,
		[listingId, posterId],
	);
	if (!ownerCheck.length) throw new AppError("Listing not found", 404);

	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		for (const { photoId, displayOrder } of photos) {
			// The WHERE clause includes listing_id so a client cannot reorder photos
			// from a different listing by supplying foreign photoIds. Mismatched IDs
			// simply produce rowCount = 0 for that entry and are silently ignored —
			// the valid entries still update correctly.
			await client.query(
				`UPDATE listing_photos
         SET display_order = $1
         WHERE photo_id   = $2
           AND listing_id = $3
           AND deleted_at IS NULL`,
				[displayOrder, photoId, listingId],
			);
		}

		await client.query("COMMIT");
		logger.info({ posterId, listingId, photoCount: photos.length }, "Photos reordered");
		return await getListingPhotos(listingId);
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
};
