// src/workers/notificationWorker.js
//
// BullMQ worker for reliable async notification delivery.
//
// ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// Before this branch, notification INSERTs were fire-and-forget pool.query calls
// made directly in the service layer after a transaction committed. That pattern
// is fast but unreliable: if the process crashed between the commit and the
// query, the notification was silently lost with no retry and no recovery path.
//
// This worker gives notifications the same reliability guarantee as photo
// processing: the job is written to Redis atomically at enqueue time. Even a
// process crash after enqueue leaves the job intact. BullMQ retries on failure
// with exponential backoff, and exhausted jobs land in the failed set for
// manual inspection and replay.
//
// ─── CONCURRENCY = 10 ────────────────────────────────────────────────────────
//
// Each notification job is a single SQL INSERT — pure I/O with no CPU cost.
// Running 10 concurrent jobs keeps the queue draining quickly during bursts
// without risking connection pool exhaustion (10 concurrent inserts against a
// pool of 20 leaves comfortable headroom for HTTP handlers).
//
// ─── ON CONFLICT (idempotency_key) DO NOTHING ────────────────────────────────
//
// Protects against the retry-after-crash duplicate scenario: if the worker
// crashed after the INSERT succeeded but before BullMQ received the completion
// acknowledgement, the retry would re-run with the same job.id. The UNIQUE
// index on idempotency_key turns that retry into a silent no-op.
//
// Fix: the worker now checks res.rowCount before logging. A rowCount of 0 means
// the ON CONFLICT clause fired (idempotent replay) and is logged at debug level
// as a skip rather than an insertion. This distinguishes genuine new
// notifications from harmless worker retries in monitoring dashboards.

import { Worker } from "bullmq";
import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { config } from "../config/env.js";

export const NOTIFICATION_QUEUE_NAME = "notification-delivery";

const redisConnection = new URL(config.REDIS_URL);
const bullConnection = {
	host: redisConnection.hostname,
	port: parseInt(redisConnection.port || "6379", 10),
	password: redisConnection.password || undefined,
	tls: redisConnection.protocol === "rediss:" ? {} : undefined,
};

// Human-readable messages keyed by notification type. Stored here (co-located
// with the only writer) so a missing type is visible in monitoring and produces
// a NULL message rather than crashing the worker.
const NOTIFICATION_MESSAGES = {
	interest_request_received: "Someone expressed interest in your listing",
	interest_request_accepted: "Your interest request was accepted",
	interest_request_declined: "Your interest request was declined",
	interest_request_withdrawn: "An interest request was withdrawn",
	connection_confirmed: "Your connection has been confirmed by both parties",
	connection_requested: "You have a new connection request",
	rating_received: "You received a new rating",
	listing_expiring: "One of your listings is expiring soon",
	listing_filled: "A listing has been marked as filled",
	verification_approved: "Your verification request was approved",
	verification_rejected: "Your verification request was rejected",
	new_message: "You have a new message",
};

export const startNotificationWorker = () => {
	const worker = new Worker(
		NOTIFICATION_QUEUE_NAME,
		async (job) => {
			const { recipientId, type, entityType, entityId } = job.data;

			logger.debug(
				{ recipientId, type, entityType, entityId, attempt: job.attemptsMade + 1 },
				"Notification worker: processing job",
			);

			const message = NOTIFICATION_MESSAGES[type] ?? null;

			if (!message) {
				logger.warn(
					{ type, jobId: job.id },
					"Notification worker: no message template for this type — inserting with NULL message",
				);
			}

			// Capture the query result so we can distinguish a genuine INSERT from
			// an idempotent replay (ON CONFLICT DO NOTHING → rowCount 0).
			const res = await pool.query(
				`INSERT INTO notifications
           (recipient_id, notification_type, entity_type, entity_id, message, idempotency_key)
         VALUES ($1, $2::notification_type_enum, $3, $4, $5, $6)
         ON CONFLICT (idempotency_key) DO NOTHING`,
				[recipientId, type, entityType ?? null, entityId ?? null, message, job.id],
			);

			if (res.rowCount === 1) {
				logger.debug({ recipientId, type, entityId }, "Notification worker: notification inserted");
			} else {
				// rowCount is 0 when the UNIQUE constraint on idempotency_key fired.
				// This is expected during BullMQ retries where the job succeeded on a
				// previous attempt but the completion acknowledgement was lost.
				logger.debug(
					{ recipientId, type, entityId, jobId: job.id },
					"Notification worker: notification skipped (idempotent replay)",
				);
			}
		},
		{
			concurrency: 10,
			connection: bullConnection,
		},
	);

	worker.on("completed", (job) => {
		logger.debug(
			{ jobId: job.id, type: job.data.type, recipientId: job.data.recipientId },
			"Notification worker: job completed",
		);
	});

	worker.on("failed", (job, err) => {
		logger.error(
			{ jobId: job?.id, type: job?.data?.type, recipientId: job?.data?.recipientId, err },
			"Notification worker: job failed after all retry attempts",
		);
	});

	worker.on("error", (err) => {
		logger.error({ err }, "Notification worker: worker-level error");
	});

	logger.info("Notification delivery worker started");
	return worker;
};
