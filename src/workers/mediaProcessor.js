// src/workers/mediaProcessor.js
//
// BullMQ worker for asynchronous photo processing.
//
// This worker is the asynchronous half of the photo upload flow. By the time
// a job reaches this file, the HTTP response has already been sent (202 Accepted)
// and the poster has their photoId. The worker's job is to take the raw staged
// file, compress and resize it with Sharp, write the final WebP file to permanent
// storage, update the listing_photos row with the real URL, elect it as cover
// if it is the listing's first photo, and delete the staging file.
//
// WHY concurrency: 1?
// Sharp calls into libvips, a native C++ image processing library. Libvips is
// highly optimised and uses all available CPU cores internally for a single
// operation. Running two Sharp jobs simultaneously on the same Node.js process
// means two libvips operations competing for the same CPU cores — neither
// finishes faster, and combined memory usage doubles (each operation buffers
// the full image). Serialising at concurrency: 1 gives each job the full
// CPU budget and predictable memory usage. Horizontal scaling (multiple
// Node.js instances) is the correct way to increase throughput.
//
// GRACEFUL SHUTDOWN:
// worker.close() waits for the currently-running job to finish before
// returning. server.js awaits this call during SIGTERM handling, before
// closing Redis. The order matters — the running job may need both the
// PostgreSQL pool and Redis (for BullMQ job state updates), so both must
// remain open until the worker has fully closed.

import fs from "fs/promises";
import sharp from "sharp";
import { Worker } from "bullmq";
import { pool } from "../db/client.js";
import { storageService } from "../storage/index.js";
import { logger } from "../logger/index.js";

// Exported as a constant so the photo service imports it when enqueueing jobs.
// This is the single source of truth for the queue name — it appears in exactly
// two places: here (worker subscribes to it) and in getQueue() calls (service
// publishes to it). If it were a plain string in both files, a typo in one
// would cause jobs to be published to one queue and consumed from another,
// silently. The import makes the mismatch a module resolution error instead.
export const MEDIA_QUEUE_NAME = "media-processing";

// Sharp processing constants.
// These represent a deliberate quality/size trade-off for PG listing photos:
// - Max dimension 1200px: large enough to look good on a laptop or tablet
//   photo gallery, small enough that even a 4G mobile user can load the page
//   without significant wait. A full-resolution DSLR photo at 6000x4000px
//   is genuinely unnecessary for a PG room thumbnail.
// - WebP at quality 80: WebP at 80 is visually indistinguishable from JPEG
//   at 90+ for most photographic content, while typically being 30–40% smaller.
// - withMetadata(false): strips EXIF data including GPS coordinates. A user
//   uploading a photo taken on their phone may not realise the image embeds
//   their precise location. Stripping metadata is a privacy baseline.
const MAX_DIMENSION_PX = 1200;
const WEBP_QUALITY = 80;

// Factory function — returns a started Worker instance.
// The caller (server.js) stores this instance and calls worker.close() on shutdown.
// Using a factory function rather than a module-level side effect means the
// worker only starts when server.js explicitly calls startMediaWorker() — not
// at module import time, which would cause it to spin up during tests or
// other non-server entry points that import from this module.
export const startMediaWorker = () => {
	const worker = new Worker(
		MEDIA_QUEUE_NAME,
		async (job) => {
			const { listingId, photoId, stagingPath, posterId } = job.data;

			logger.info(
				{ listingId, photoId, stagingPath, attempt: job.attemptsMade + 1 },
				"Media worker: processing job",
			);

			// ── Step 1: Compress and resize with Sharp ─────────────────────────
			// sharp() accepts a file path and returns a processing pipeline.
			// .resize() with fit: 'inside' preserves the aspect ratio while
			// ensuring neither dimension exceeds MAX_DIMENSION_PX. A portrait
			// photo is not stretched or cropped — it is simply downscaled until
			// it fits within the bounding box.
			// .webp() converts to WebP format with the specified quality.
			// .withMetadata(false) strips all EXIF/IPTC/XMP metadata.
			// .toBuffer() executes the pipeline and returns a Buffer — we use
			// the Buffer rather than writing to a file path so that the
			// StorageAdapter decides where the final file goes (disk vs blob).
			const outputBuffer = await sharp(stagingPath)
				.resize(MAX_DIMENSION_PX, MAX_DIMENSION_PX, { fit: "inside", withoutEnlargement: true })
				.webp({ quality: WEBP_QUALITY })
				.withMetadata(false)
				.toBuffer();

			// ── Step 2: Write compressed file to permanent storage ─────────────
			// The filename is the photoId with a .webp extension. Using the
			// photoId as the filename guarantees uniqueness within the listing's
			// directory and makes it trivial to correlate a file on disk with
			// its database row.
			const filename = `${photoId}.webp`;
			const finalUrl = await storageService.upload(outputBuffer, listingId, filename);

			// ── Step 3: Update the listing_photos row with the real URL ────────
			// The provisional row was inserted with photo_url = 'processing:{photoId}'.
			// We now replace that sentinel with the real URL. At this moment the
			// photo becomes visible in GET /listings/:listingId/photos responses
			// (the service filters out 'processing:%' rows).
			await pool.query(`UPDATE listing_photos SET photo_url = $1 WHERE photo_id = $2`, [finalUrl, photoId]);

			// ── Step 4: Cover photo election (atomic) ─────────────────────────
			// The UPDATE only sets is_cover = TRUE if no cover currently exists.
			// The NOT EXISTS subquery and the UPDATE are evaluated atomically by
			// PostgreSQL — there is no gap between the existence check and the
			// write during which a concurrent job could also elect itself as cover.
			// rowCount === 0 means a cover already existed; this photo stays as
			// a non-cover photo (is_cover = FALSE, which is the default).
			await pool.query(
				`UPDATE listing_photos
         SET is_cover = TRUE
         WHERE photo_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM listing_photos
             WHERE listing_id = $2
               AND is_cover   = TRUE
               AND deleted_at IS NULL
           )`,
				[photoId, listingId],
			);

			// ── Step 5: Delete the staging file ───────────────────────────────
			// The staging file has served its purpose — the compressed output is
			// now in permanent storage. Deleting it immediately keeps the staging
			// directory clean. If this unlink fails, the file becomes an orphan
			// for the maintenance cron to sweep — not a correctness problem since
			// the photo is already fully processed and visible. We catch the error
			// and log it rather than throwing, so a cleanup failure does not cause
			// the job to be marked as failed and retried (retrying would re-run
			// Sharp and try to upload again, which is wasteful and incorrect).
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

	// Attach event listeners for observability. These go to the Pino logger
	// (structured JSON in production) so they can be queried in Azure Monitor
	// or any log aggregation tool that ingests the stdout stream.
	worker.on("completed", (job) => {
		logger.info({ jobId: job.id, photoId: job.data.photoId }, "Media worker: job completed");
	});

	worker.on("failed", (job, err) => {
		logger.error({ jobId: job?.id, photoId: job?.data?.photoId, err }, "Media worker: job failed");
	});

	worker.on("error", (err) => {
		// Worker-level errors (e.g. Redis disconnection) rather than job-level errors
		logger.error({ err }, "Media worker: worker error");
	});

	logger.info("Media processing worker started");
	return worker;
};
