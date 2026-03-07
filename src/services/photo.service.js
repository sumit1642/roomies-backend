// src/services/photo.service.js
// Fixed: UPDATE ... ORDER BY ... LIMIT replaced with a subquery for cover election in deletePhoto.

import path from "path";
import crypto from "crypto";
import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";
import { storageService } from "../storage/index.js";
import { MEDIA_QUEUE_NAME } from "../workers/mediaProcessor.js";
import { getQueue } from "../workers/queue.js";

export const enqueuePhotoUpload = async (posterId, listingId, stagingPath, displayOrder) => {
	const { rows: listingRows } = await pool.query(
		`SELECT listing_id
     FROM listings
     WHERE listing_id = $1
       AND posted_by  = $2
       AND deleted_at IS NULL`,
		[listingId, posterId],
	);
	if (!listingRows.length) throw new AppError("Listing not found", 404);

	let order = displayOrder;
	if (order === undefined) {
		const { rows: orderRows } = await pool.query(
			`SELECT COALESCE(MAX(display_order), -1) + 1 AS next_order
       FROM listing_photos
       WHERE listing_id = $1
         AND deleted_at IS NULL`,
			[listingId],
		);
		order = orderRows[0].next_order;
	}

	const photoId = crypto.randomUUID();
	const placeholderUrl = `processing:${photoId}`;

	await pool.query(
		`INSERT INTO listing_photos
       (photo_id, listing_id, photo_url, is_cover, display_order)
     VALUES ($1, $2, $3, FALSE, $4)`,
		[photoId, listingId, placeholderUrl, order],
	);

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
};

export const getListingPhotos = async (listingId) => {
	const { rows } = await pool.query(
		`SELECT
       photo_id       AS "photoId",
       photo_url      AS "photoUrl",
       is_cover       AS "isCover",
       display_order  AS "displayOrder",
       created_at     AS "createdAt"
     FROM listing_photos
     WHERE listing_id = $1
       AND deleted_at IS NULL
       AND photo_url NOT LIKE 'processing:%'
     ORDER BY display_order ASC`,
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
		return { photoId, isCover: true };
	}

	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		await client.query(
			`UPDATE listing_photos
       SET is_cover = FALSE
       WHERE listing_id = $1 AND is_cover = TRUE AND deleted_at IS NULL`,
			[listingId],
		);

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
		return await getListingPhotos(listingId);
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
};
