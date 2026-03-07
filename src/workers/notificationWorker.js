// src/workers/notificationWorker.js
//
// BullMQ worker for reliable async notification delivery.
//
// ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// Before this branch, notification INSERTs were fire-and-forget pool.query calls
// made directly in the service layer after a transaction committed. That pattern
// is fast but unreliable: if PostgreSQL was momentarily slow, the connection
// pool was exhausted, or the Node process crashed between the transaction commit
// and the pool.query call, the notification was silently lost forever with no
// retry, no visibility, and no recovery path.
//
// This worker gives notifications the same reliability guarantee as photo
// processing: the job is written to Redis atomically at enqueue time. Even a
// process crash after enqueue leaves the job intact in Redis. BullMQ retries
// on failure with exponential backoff, and exhausted jobs land in the failed
// set for manual inspection and replay.
//
// ─── CONCURRENCY = 10 ────────────────────────────────────────────────────────
//
// Unlike the media worker (concurrency 1, because Sharp is CPU-bound), each
// notification job is a single SQL INSERT — pure I/O with no CPU cost. Running
// 10 concurrent jobs keeps the queue draining quickly during bursts (e.g. a PG
// owner accepting 20 interest requests in quick succession) without risking
// connection pool exhaustion: 10 concurrent inserts against a pool of 20
// leaves comfortable headroom for the HTTP request handlers.
//
// ─── ON CONFLICT DO NOTHING ──────────────────────────────────────────────────
//
// Protects against the retry-after-crash duplicate scenario: the worker INSERT
// succeeded on attempt 1, but the process crashed before BullMQ received the
// job completion acknowledgement, so BullMQ retried the job. Without this
// guard the retry would insert a duplicate notification row. With it, the retry
// becomes a silent no-op. This is a belt-and-suspenders measure — the
// notifications table has no unique constraint to define "duplicate" precisely,
// so this guard catches the specific retry-duplicate case rather than providing
// strict global deduplication.

import { Worker } from "bullmq";
import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { config } from "../config/env.js";

export const NOTIFICATION_QUEUE_NAME = "notification-delivery";

// Parsed once at module scope — same pattern as mediaProcessor.js.
// Handles Azure Redis (rediss:// with password) and local Redis (redis://)
// from the same config value with no conditional code.
const redisConnection = new URL(config.REDIS_URL);
const bullConnection = {
	host: redisConnection.hostname,
	port: parseInt(redisConnection.port || "6379", 10),
	password: redisConnection.password || undefined,
	tls: redisConnection.protocol === "rediss:" ? {} : undefined,
};

// Human-readable messages assembled from notification type at read time.
// Stored here (in the worker file) rather than in the service file because
// the worker is the only place that writes the message column — keeping the
// template map co-located with its only consumer avoids a shared-state import.
//
// The message column in the DB is nullable, so an unmapped type produces a
// NULL message rather than crashing the worker. The logger.warn below makes
// unmapped types visible in monitoring so they can be added to the map.
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
				// A missing message is not a fatal error — the notification is still
				// inserted (with a NULL message) so the client can render something.
				// But an unmapped type almost certainly means the map needs updating.
				logger.warn(
					{ type, jobId: job.id },
					"Notification worker: no message template for this type — inserting with NULL message",
				);
			}

			// ON CONFLICT DO NOTHING: see module-level comment for the reasoning.
			// The notifications table has no unique constraint, so this guard is
			// specifically for the retry-after-crash scenario rather than global
			// deduplication. It makes retries safe without silently swallowing
			// legitimately distinct notifications of the same type to the same user.
			await pool.query(
				`INSERT INTO notifications
           (recipient_id, notification_type, entity_type, entity_id, message)
         VALUES ($1, $2::notification_type_enum, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
				[recipientId, type, entityType ?? null, entityId ?? null, message],
			);

			logger.debug({ recipientId, type, entityId }, "Notification worker: notification inserted");
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
		// Log at error level — a failed notification job means a user missed an
		// event they should have seen. After 5 attempts, inspect the failed set.
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
