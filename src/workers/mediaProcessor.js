// src/workers/mediaProcessor.js
// BullMQ worker for async photo processing: compress with Sharp, write to storage,
// update DB, elect cover photo, and clean up the staging file.

import fs from "fs/promises";
import sharp from "sharp";
import { Worker } from "bullmq";
import { pool } from "../db/client.js";
import { storageService } from "../storage/index.js";
import { logger } from "../logger/index.js";

export const MEDIA_QUEUE_NAME = "media-processing";

const MAX_DIMENSION_PX = 1200;
const WEBP_QUALITY = 80;

export const startMediaWorker = () => {
	const worker = new Worker(
		MEDIA_QUEUE_NAME,
		async (job) => {
			const { listingId, photoId, stagingPath, posterId } = job.data;

			logger.info(
				{ listingId, photoId, stagingPath, attempt: job.attemptsMade + 1 },
				"Media worker: processing job",
			);

			// Resize to fit within 1200×1200, convert to WebP, strip EXIF metadata
			// (EXIF can contain GPS coordinates — always strip for user privacy).
			const outputBuffer = await sharp(stagingPath)
				.resize(MAX_DIMENSION_PX, MAX_DIMENSION_PX, { fit: "inside", withoutEnlargement: true })
				.webp({ quality: WEBP_QUALITY })
				.withMetadata(false)
				.toBuffer();

			const filename = `${photoId}.webp`;
			const finalUrl = await storageService.upload(outputBuffer, listingId, filename);

			const { rowCount: urlUpdateCount } = await pool.query(
				`UPDATE listing_photos
         SET photo_url = $1
         WHERE photo_id   = $2
           AND deleted_at IS NULL`,
				[finalUrl, photoId],
			);

			if (urlUpdateCount === 0) {
				logger.warn(
					{ photoId, listingId },
					"Media worker: photo row deleted before processing completed — cleaning up uploaded file",
				);

				// The permanent file was already written to storage before the DB row disappeared.
				// Delete it best-effort to prevent orphaned storage objects.
				try {
					await storageService.delete(finalUrl);
				} catch (deleteErr) {
					logger.error(
						{ finalUrl, err: deleteErr },
						"Media worker: failed to delete orphaned permanent file — manual cleanup required",
					);
				}

				try {
					await fs.unlink(stagingPath);
				} catch (_) {
					/* best-effort, cron handles orphans */
				}
				return;
			}

			// Atomically elect cover only if the listing has none — NOT EXISTS + UPDATE
			// in a single statement closes the TOCTOU race window entirely.
			await pool.query(
				`UPDATE listing_photos
         SET is_cover = TRUE
         WHERE photo_id   = $1
           AND deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM listing_photos
             WHERE listing_id = $2
               AND is_cover   = TRUE
               AND deleted_at IS NULL
           )`,
				[photoId, listingId],
			);

			try {
				await fs.unlink(stagingPath);
			} catch (cleanupErr) {
				logger.warn(
					{ stagingPath, err: cleanupErr },
					"Media worker: failed to delete staging file — will be cleaned by cron",
				);
			}

			logger.info({ listingId, photoId, finalUrl, posterId }, "Media worker: photo processed successfully");
		},
		{
			concurrency: 1,
			connection: {
				host: process.env.REDIS_HOST ?? "localhost",
				port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
				password: process.env.REDIS_PASSWORD ?? undefined,
			},
		},
	);

	worker.on("completed", (job) => {
		logger.info({ jobId: job.id, photoId: job.data.photoId }, "Media worker: job completed");
	});

	worker.on("failed", (job, err) => {
		logger.error({ jobId: job?.id, photoId: job?.data?.photoId, err }, "Media worker: job failed");
	});

	worker.on("error", (err) => {
		logger.error({ err }, "Media worker: worker error");
	});

	logger.info("Media processing worker started");
	return worker;
};
