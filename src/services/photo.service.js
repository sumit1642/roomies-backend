














import path from "path";
import crypto from "crypto";
import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";
import { storageService } from "../storage/index.js";
import { MEDIA_QUEUE_NAME } from "../workers/mediaProcessor.js";
import { getQueue } from "../workers/queue.js";
import { EXPIRED_LISTING_MESSAGE, UNAVAILABLE_LISTING_MESSAGE } from "./listingLifecycle.js";








































export const enqueuePhotoUpload = async (posterId, listingId, stagingPath) => {
	const client = await pool.connect();
	let photoId = null;
	let transactionOpen = false;
	try {
		await client.query("BEGIN");
		transactionOpen = true;

		
		
		
		
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

		
		
		
		
		
		
		const { rows: orderRows } = await client.query(
			`SELECT COALESCE(MAX(display_order), -1) + 1 AS next_order
         FROM listing_photos
         WHERE listing_id = $1
           AND deleted_at IS NULL`,
			[listingId],
		);
		const order = orderRows[0].next_order;

		
		
		
		photoId = crypto.randomUUID();
		const placeholderUrl = `processing:${photoId}`;

		await client.query(
			`INSERT INTO listing_photos
         (photo_id, listing_id, photo_url, is_cover, display_order)
       VALUES ($1, $2, $3, FALSE, $4)`,
			[photoId, listingId, placeholderUrl, order],
		);

		await client.query("COMMIT");
		transactionOpen = false;

		
		
		
		
		
		
		const queue = getQueue(MEDIA_QUEUE_NAME);
		try {
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
		} catch (queueErr) {
			const cleanupResult = await pool.query(
				`UPDATE listing_photos
         SET deleted_at = NOW()
         WHERE photo_id = $1
           AND listing_id = $2
           AND deleted_at IS NULL
           AND photo_url LIKE 'processing:%'`,
				[photoId, listingId],
			);

			logger.error(
				{ queueErr, photoId, listingId, cleanupRowCount: cleanupResult.rowCount },
				"Photo queue enqueue failed; provisional row soft-deleted",
			);

			throw new AppError("Photo processing queue is temporarily unavailable. Please retry.", 503);
		}

		logger.info({ posterId, listingId, photoId, stagingPath, displayOrder: order }, "Photo upload enqueued");

		return { photoId, status: "processing" };
	} catch (err) {
		
		
		
		if (transactionOpen) {
			try {
				await client.query("ROLLBACK");
			} catch (rollbackErr) {
				logger.error({ rollbackErr, err }, "enqueuePhotoUpload: rollback failed");
			}
		}
		throw err;
	} finally {
		client.release();
	}
};










export const getListingPhotos = async (listingId, options = {}) => {
	const { skipValidation = false } = options;

	const { rows: listingRows } = await pool.query(
		`SELECT status, expires_at, (expires_at <= NOW()) AS is_expired
     FROM listings
     WHERE listing_id = $1
       AND deleted_at IS NULL`,
		[listingId],
	);

	if (!listingRows.length) {
		throw new AppError("Listing not found", 404);
	}

	if (!skipValidation && listingRows[0].is_expired) {
		throw new AppError(EXPIRED_LISTING_MESSAGE, 422);
	}

	if (!skipValidation && listingRows[0].status !== "active") {
		throw new AppError(UNAVAILABLE_LISTING_MESSAGE, 422);
	}

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
     ORDER BY display_order ASC, photo_id ASC`,
		[listingId],
	);
	return rows;
};















export const deletePhoto = async (posterId, listingId, photoId) => {
	
	
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

		
		await client.query(`UPDATE listing_photos SET deleted_at = NOW() WHERE photo_id = $1`, [photoId]);

		
		
		if (wasCover) {
			await client.query(
				`UPDATE listing_photos
         SET is_cover = TRUE
         WHERE photo_id = (
           SELECT photo_id FROM listing_photos
           WHERE listing_id = $1
             AND deleted_at IS NULL
             AND photo_url  NOT LIKE 'processing:%'
	           ORDER BY display_order ASC, photo_id ASC
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










export const setCoverPhoto = async (posterId, listingId, photoId) => {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		
		const { rows } = await client.query(
			`SELECT lp.is_cover
       FROM listing_photos lp
       JOIN listings l ON l.listing_id = lp.listing_id
       WHERE lp.photo_id   = $1
         AND lp.listing_id = $2
         AND l.posted_by   = $3
         AND lp.deleted_at IS NULL
         AND lp.photo_url  NOT LIKE 'processing:%'
       FOR UPDATE`,
			[photoId, listingId, posterId],
		);

		if (!rows.length) {
			throw new AppError("Photo not found or still processing", 404);
		}
		if (rows[0].is_cover) {
			await client.query("ROLLBACK");
			return { photoId, isCover: true };
		}

		
		await client.query(
			`UPDATE listing_photos
       SET is_cover = FALSE
       WHERE listing_id = $1 AND is_cover = TRUE AND deleted_at IS NULL`,
			[listingId],
		);

		
		const { rowCount } = await client.query(
			`UPDATE listing_photos
       SET is_cover = TRUE
       WHERE photo_id = $1
         AND listing_id = $2
         AND deleted_at IS NULL
         AND photo_url NOT LIKE 'processing:%'`,
			[photoId, listingId],
		);
		if (rowCount !== 1) {
			throw new AppError("Cover photo update conflicted with a concurrent change. Please retry.", 409);
		}

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








export const reorderPhotos = async (posterId, listingId, photos) => {
	
	const { rows: ownerCheck } = await pool.query(
		`SELECT 1 FROM listings
     WHERE listing_id = $1 AND posted_by = $2 AND deleted_at IS NULL`,
		[listingId, posterId],
	);
	if (!ownerCheck.length) throw new AppError("Listing not found", 404);

	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		const submittedDisplayOrders = photos.map(({ displayOrder }) => displayOrder);
		const submittedPhotoIds = photos.map(({ photoId }) => photoId);

		const photoIdFrequency = new Map();
		for (const photoId of submittedPhotoIds) {
			photoIdFrequency.set(photoId, (photoIdFrequency.get(photoId) ?? 0) + 1);
		}
		const duplicatePhotoIds = [...photoIdFrequency.entries()]
			.filter(([, count]) => count > 1)
			.map(([photoId]) => photoId)
			.sort();
		if (duplicatePhotoIds.length) {
			throw new AppError(`Duplicate photo IDs in reorder payload: ${duplicatePhotoIds.join(", ")}`, 422);
		}

		const displayOrderFrequency = new Map();
		for (const displayOrder of submittedDisplayOrders) {
			displayOrderFrequency.set(displayOrder, (displayOrderFrequency.get(displayOrder) ?? 0) + 1);
		}
		const duplicateDisplayOrders = [...displayOrderFrequency.entries()]
			.filter(([, count]) => count > 1)
			.map(([displayOrder]) => displayOrder)
			.sort((a, b) => a - b);
		if (duplicateDisplayOrders.length) {
			throw new AppError(
				`Duplicate displayOrder values in reorder payload: ${duplicateDisplayOrders.join(", ")}`,
				422,
			);
		}

		const uniqueSubmittedPhotoIds = [...new Set(submittedPhotoIds)];

		const { rows: existingPhotoRows } = await client.query(
			`SELECT photo_id
       FROM listing_photos
       WHERE listing_id = $1
         AND deleted_at IS NULL
         AND photo_id = ANY($2::uuid[])`,
			[listingId, uniqueSubmittedPhotoIds],
		);

		const existingPhotoIds = new Set(existingPhotoRows.map(({ photo_id: photoId }) => photoId));
		const invalidPhotoIds = uniqueSubmittedPhotoIds.filter((photoId) => !existingPhotoIds.has(photoId));
		if (invalidPhotoIds.length) {
			throw new AppError(`Invalid photo IDs for this listing: ${invalidPhotoIds.join(", ")}`, 422);
		}

		
		
		const { rows: countRows } = await client.query(
			`SELECT COUNT(*)::int AS total_count
       FROM listing_photos
       WHERE listing_id = $1
         AND deleted_at IS NULL`,
			[listingId],
		);
		const currentPhotoCount = countRows[0].total_count;
		if (uniqueSubmittedPhotoIds.length !== currentPhotoCount) {
			throw new AppError(
				`Reorder payload must include all photos. Submitted ${uniqueSubmittedPhotoIds.length}, expected ${currentPhotoCount}.`,
				422,
			);
		}

		for (const { photoId, displayOrder } of photos) {
			
			
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
		return await getListingPhotos(listingId, { skipValidation: true });
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
};
