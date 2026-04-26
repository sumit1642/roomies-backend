import fs from "fs/promises";
import sharp from "sharp";
import { Worker } from "bullmq";
import { pool } from "../db/client.js";
import { storageService } from "../storage/index.js";
import { logger } from "../logger/index.js";
import { bullConnection } from "./bullConnection.js";

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
				} catch (_) {}
				return;
			}

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
			connection: bullConnection,
		},
	);

	worker.on("completed", (job) => {
		logger.info({ jobId: job.id, photoId: job.data.photoId }, "Media worker: job completed");
	});

	worker.on("failed", async (job, err) => {
		logger.error({ jobId: job?.id, photoId: job?.data?.photoId, err }, "Media worker: job failed");

		if (job && job.attemptsMade >= job.opts.attempts) {
			const { photoId, listingId } = job.data ?? {};
			if (!photoId || !listingId) {
				logger.error({ jobId: job.id }, "Media worker: missing photoId or listingId in job data");
				return;
			}
			try {
				await pool.query(
					`UPDATE listing_photos
           SET deleted_at = NOW()
           WHERE photo_id  = $1
             AND listing_id = $2
             AND deleted_at IS NULL
             AND photo_url LIKE 'processing:%'`,
					[photoId, listingId],
				);
				logger.warn(
					{ photoId, listingId },
					"Media worker: provisional photo row soft-deleted after permanent job failure",
				);
			} catch (cleanupErr) {
				logger.error(
					{ cleanupErr, photoId, listingId },
					"Media worker: failed to clean provisional row after permanent failure",
				);
			}
		}
	});

	worker.on("error", (err) => {
		logger.error({ err }, "Media worker: worker error");
	});

	logger.info("Media processing worker started");
	return worker;
};
