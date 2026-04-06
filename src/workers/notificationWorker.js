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
// ─── NOTIFICATION CONTRACT ────────────────────────────────────────────────────
//
// The NOTIFICATION_MESSAGES map below is the authoritative contract between
// the enum values defined in the DB schema and the messages shown to users.
// Each entry is annotated with its lifecycle status so the surface area is
// always visible in one place:
//
//   ACTIVE   — a real emitter exists in the current codebase; this type is
//              produced and consumed in production today.
//
//   PLANNED  — the DB enum reserves the value, a message template is defined
//              here so the worker never crashes on an unknown type, but no
//              service currently enqueues jobs of this type. When implemented,
//              remove the PLANNED annotation.
//
// This table should be reviewed whenever a new notification type is added to
// the notification_type_enum in the schema. Adding a type to the enum without
// a corresponding entry here causes the worker to insert a NULL message, which
// is permitted but degrades the user experience.

import { Worker } from "bullmq";
import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { bullConnection } from "./bullConnection.js";

export const NOTIFICATION_QUEUE_NAME = "notification-delivery";

// ─── Notification message contract ────────────────────────────────────────────
//
// Maps every notification_type_enum value to its human-readable message.
// Stored at insert time so the feed always shows the message that was current
// when the notification was created — old notifications do not retroactively
// change wording when templates are updated.
//
// Lifecycle annotations:
//   ACTIVE  — emitter exists; type is produced today.
//   PLANNED — enum value reserved; no emitter yet. Implement the emitter and
//             remove this annotation when the feature ships.
const NOTIFICATION_MESSAGES = {
	// ── ACTIVE: fired from interest.service.js ─────────────────────────────────
	interest_request_received: "Someone expressed interest in your listing",
	interest_request_accepted: "Your interest request was accepted",
	interest_request_declined: "Your interest request was declined",
	interest_request_withdrawn: "An interest request was withdrawn",

	// ── ACTIVE: fired from connection.service.js ───────────────────────────────
	connection_confirmed: "Your connection has been confirmed by both parties",

	// ── ACTIVE: fired from rating.service.js ──────────────────────────────────
	rating_received: "You received a new rating",

	// ── ACTIVE: fired from cron/listingExpiry.js and cron/expiryWarning.js ─────
	listing_expiring: "One of your listings is expiring soon",

	// ── ACTIVE: fired from interest.service.js when a listing becomes filled ───
	// Emitted post-commit in _acceptInterestRequest when capacity is exhausted.
	listing_filled: "A listing has been marked as filled",

	// ── PLANNED: wire emitter in verification.service.js (Phase 5 admin work) ──
	// Should fire from approveRequest() after committing the verification decision.
	verification_approved: "Your verification request was approved",

	// ── PLANNED: wire emitter in verification.service.js (Phase 5 admin work) ──
	// Should fire from rejectRequest() after committing the rejection.
	verification_rejected: "Your verification request was rejected",

	// ── PLANNED: wire emitter once in-app messaging is implemented (Phase 6+) ──
	// The 'new_message' type is reserved for the future WebSocket/messaging phase.
	new_message: "You have a new message",

	// ── PLANNED: no emitter yet — connection_requested would be appropriate for ─
	// an admin-created connection or a future "request to connect" feature.
	// Currently all connections are created by the accept flow in interest.service.js
	// which emits interest_request_accepted instead.
	connection_requested: "You have a new connection request",
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
				// An unknown type means either a new enum value was added to the DB
				// schema without a corresponding entry in NOTIFICATION_MESSAGES above,
				// or a bug in the enqueue call. We log at warn level and proceed —
				// inserting with a NULL message is better than crashing the worker and
				// leaving the notification undelivered.
				logger.warn(
					{ type, jobId: job.id },
					"Notification worker: no message template for this type — inserting with NULL message. " +
						"Add an entry to NOTIFICATION_MESSAGES in notificationWorker.js.",
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
