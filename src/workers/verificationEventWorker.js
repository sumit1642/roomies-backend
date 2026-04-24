// CDC (Change Data Capture) outbox drainer for verification events.
//
// The Postgres trigger trg_verification_status_changed (created in migration
// 002) writes a row to verification_event_outbox whenever
// verification_requests.status changes — regardless of whether that change
// came from the Roomies API, a migration script, or a raw psql session.
//
// This worker polls that outbox table, processes each pending event, and marks
// it consumed. Processing means:
//   1. Ensuring pg_owner_profiles.verification_status is consistent with the
//      event (guards against partial admin SQL scripts that updated only one
//      of the two tables).
//   2. Enqueuing an in-app notification via the existing BullMQ infrastructure.
//   3. Enqueuing a transactional email via the existing email queue.
//
// This is the key concurrency primitive. When the worker claims a batch of
// outbox rows, it locks them with FOR UPDATE. SKIP LOCKED tells Postgres:
// "don't wait for rows that another transaction has already locked — just skip
// them and give me the next available ones." This means two worker instances
// (e.g. during a rolling deploy) will never process the same event twice.
// They cooperate automatically without any application-level coordination.
//
// If processEvent() throws (e.g. a transient DB error), the worker increments
// the event's `attempts` counter and records the error message, then continues
// to the next event. The failed event will be retried on the next poll cycle.
// After MAX_ATTEMPTS failures, the event is permanently skipped (marked with
// a terminal error message) so a broken event cannot block the queue forever.
//
// This implementation uses setInterval polling (every POLL_INTERVAL_MS = 5s).
// For verification events, this is perfectly fine — verification decisions are
// low-frequency admin actions, not high-volume user events. The 5-second delay
// between a SQL change and the notification/email is imperceptible in practice.
//
// If you ever need sub-second latency, the upgrade path is to add
// pg_notify('verification_events', NEW.event_id::text) to the trigger function
// and replace setInterval with a LISTEN client. The outbox table stays as-is
// for durability — NOTIFY provides speed, the table provides reliability.

import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { enqueueNotification } from "./notificationQueue.js";
import { enqueueEmail } from "./emailQueue.js";

// How often the worker wakes up and checks for pending events.
// 5 seconds is a good balance between responsiveness and DB query overhead
// at Roomies' scale. Lower this (e.g. 1000ms) if you need faster reactions.
const POLL_INTERVAL_MS = 5_000;

// How many events to claim and process in a single poll cycle.
// Keeping this small (10) ensures the worker does not hold a long-running
// transaction that blocks other DB operations.
const BATCH_SIZE = 10;

// After this many failed attempts, the event is permanently abandoned.
// The error_message column records why, for manual operator inspection.
const MAX_ATTEMPTS = 5;

// Handles a single outbox event. Called inside the drain transaction, so any
// DB writes here (the profile consistency update) participate in the same
// transaction as the processed_at acknowledgement.
//
// The enqueueNotification() and enqueueEmail() calls are fire-and-forget (they
// write to Redis/BullMQ, not Postgres). They are intentionally called outside
// the transaction boundary because:
//   a) A Redis write failure should not roll back the profile consistency update.
//   b) If the transaction commits but the Redis enqueue fails, the event is still
//      marked processed — the user won't get an in-app notification. This is an
//      acceptable trade-off at this scale. A more robust solution would enqueue
//      to a second outbox table, but that adds complexity not yet warranted.
const processEvent = async (event, client) => {
	const { event_id, event_type, user_id, request_id, rejection_reason } = event;

	// Fetch the freshest user profile data at processing time.
	// We do NOT store email/name in the outbox because it can change between
	// the trigger firing and the worker processing (e.g. user updates their name).
	// Fresh fetch = correct data in the notification and email.
	const { rows: userRows } = await client.query(
		`SELECT
             u.email,
             pop.owner_full_name,
             pop.business_name,
             pop.verification_status
         FROM users u
         JOIN pg_owner_profiles pop
             ON pop.user_id    = u.user_id
             AND pop.deleted_at IS NULL
         WHERE u.user_id    = $1
           AND u.deleted_at  IS NULL`,
		[user_id],
	);

	// User or profile was deleted between trigger fire and worker processing.
	// There is nothing to notify — skip silently with an info log.
	if (!userRows.length) {
		logger.info(
			{ event_id, user_id, event_type },
			"verificationEventWorker: user/profile not found — event skipped (user may have been deleted)",
		);
		return;
	}

	const { email, owner_full_name, business_name, verification_status } = userRows[0];

	if (event_type === "verification_approved") {
		// If the admin ran SQL that only updated verification_requests but forgot
		// to also update pg_owner_profiles (easy mistake), this ensures the profile
		// reflects the correct state before any notification goes out.
		// The WHERE clause makes this idempotent — if the profile is already
		// 'verified', the UPDATE is a no-op (0 rows affected, no error).
		if (verification_status !== "verified") {
			await client.query(
				`UPDATE pg_owner_profiles
                 SET verification_status = 'verified',
                     verified_at         = NOW()
                 WHERE user_id    = $1
                   AND deleted_at IS NULL`,
				[user_id],
			);
			logger.info(
				{ user_id, event_id },
				"verificationEventWorker: pg_owner_profiles.verification_status corrected to verified",
			);
		}

		enqueueNotification({
			recipientId: user_id,
			type: "verification_approved",
			entityType: "verification_request",
			entityId: request_id,
		});

		enqueueEmail({
			type: "verification_approved",
			to: email,
			data: { ownerName: owner_full_name, businessName: business_name },
		});

		logger.info(
			{ user_id, request_id, event_id },
			"verificationEventWorker: approval event processed — notification + email enqueued",
		);
	} else if (event_type === "verification_rejected") {
		if (verification_status !== "rejected") {
			await client.query(
				`UPDATE pg_owner_profiles
                 SET verification_status = 'rejected',
                     rejection_reason    = $2
                 WHERE user_id    = $1
                   AND deleted_at IS NULL`,
				[user_id, rejection_reason],
			);
			logger.info(
				{ user_id, event_id },
				"verificationEventWorker: pg_owner_profiles.verification_status corrected to rejected",
			);
		}

		enqueueNotification({
			recipientId: user_id,
			type: "verification_rejected",
			entityType: "verification_request",
			entityId: request_id,
		});

		enqueueEmail({
			type: "verification_rejected",
			to: email,
			data: {
				ownerName: owner_full_name,
				rejectionReason: rejection_reason ?? "Please review the requirements and resubmit.",
			},
		});

		logger.info(
			{ user_id, request_id, event_id },
			"verificationEventWorker: rejection event processed — notification + email enqueued",
		);
	} else if (event_type === "verification_pending") {
		// Acknowledgement email only — no in-app notification needed for this state.
		enqueueEmail({
			type: "verification_pending",
			to: email,
			data: { ownerName: owner_full_name, businessName: business_name },
		});

		logger.info(
			{ user_id, request_id, event_id },
			"verificationEventWorker: pending acknowledgement email enqueued",
		);
	} else {
		// Unknown event_type — the CHECK constraint on the table prevents this
		// from the DB side, but guard here defensively anyway.
		logger.warn({ event_id, event_type }, "verificationEventWorker: unknown event_type — skipping without retry");
	}
};

// Claims a batch of unprocessed events, processes each one, and marks
// successfully processed events with processed_at = NOW(). Failed events
// have their attempts counter incremented and error recorded for retry.
//
// The entire batch runs inside one transaction. This is correct because:
//   - FOR UPDATE SKIP LOCKED locks all claimed rows for the duration.
//   - Each event's processed_at / attempts update is part of the same transaction.
//   - On COMMIT, all claimed events are either marked processed or have their
//     attempt counter incremented. No partial state is visible to other sessions.
const drainOutbox = async () => {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		// Claim rows with SKIP LOCKED so concurrent worker instances do not
		// process the same events simultaneously.
		const { rows: events } = await client.query(
			`SELECT
                 event_id,
                 event_type,
                 user_id,
                 request_id,
                 rejection_reason,
                 attempts
             FROM verification_event_outbox
             WHERE processed_at IS NULL
               AND attempts      < $1
             ORDER BY created_at ASC
             LIMIT $2
             FOR UPDATE SKIP LOCKED`,
			[MAX_ATTEMPTS, BATCH_SIZE],
		);

		if (!events.length) {
			await client.query("ROLLBACK");
			return;
		}

		logger.debug({ count: events.length }, "verificationEventWorker: claimed batch of pending events");

		for (const event of events) {
			try {
				await processEvent(event, client);

				// Acknowledge: mark as processed. This is the point of no return —
				// once committed, this event will never be processed again.
				await client.query(
					`UPDATE verification_event_outbox
                     SET processed_at = NOW(),
                         attempts     = attempts + 1
                     WHERE event_id = $1`,
					[event.event_id],
				);
			} catch (err) {
				// This event failed. Record the error and increment the attempt
				// counter. The event will be retried on the next poll cycle until
				// it reaches MAX_ATTEMPTS, after which it is permanently skipped.
				logger.error(
					{
						err,
						event_id: event.event_id,
						event_type: event.event_type,
						attempt: event.attempts + 1,
						maxAttempts: MAX_ATTEMPTS,
					},
					"verificationEventWorker: failed to process event — will retry",
				);

				const isFinalAttempt = event.attempts + 1 >= MAX_ATTEMPTS;

				await client.query(
					`UPDATE verification_event_outbox
                     SET attempts      = attempts + 1,
                         error_message = $2,
                         -- On the final attempt, mark processed_at so this event
                         -- is excluded from future polls. It stays in the table
                         -- for operator inspection but will not block the queue.
                         processed_at  = CASE WHEN attempts + 1 >= $3
                                              THEN NOW()
                                              ELSE NULL
                                         END
                     WHERE event_id = $1`,
					[event.event_id, err.message, MAX_ATTEMPTS],
				);

				if (isFinalAttempt) {
					logger.error(
						{ event_id: event.event_id, event_type: event.event_type },
						"verificationEventWorker: event reached MAX_ATTEMPTS — permanently abandoned. " +
							"Inspect verification_event_outbox where event_id = event_id for details.",
					);
				}
			}
		}

		await client.query("COMMIT");
	} catch (err) {
		// Outer catch: transaction-level failure, not a single-event failure.
		try {
			await client.query("ROLLBACK");
		} catch (_) {
			/* ignore rollback errors */
		}
		logger.error({ err }, "verificationEventWorker: drain cycle transaction failed");
	} finally {
		client.release();
	}
};

// Called from server.js after Redis and Postgres are confirmed healthy.
// Returns an object with a close() method so server.js can stop the poll
// loop during graceful shutdown.
export const startVerificationEventWorker = () => {
	logger.info(
		{ pollIntervalMs: POLL_INTERVAL_MS, batchSize: BATCH_SIZE, maxAttempts: MAX_ATTEMPTS },
		"Verification event worker started",
	);

	// Run once immediately on startup to drain any events that accumulated
	// while the server was down (e.g. admin ran SQL during a deployment window).
	drainOutbox().catch((err) => {
		logger.error({ err }, "verificationEventWorker: error during initial startup drain");
	});

	const interval = setInterval(() => {
		drainOutbox().catch((err) => {
			logger.error({ err }, "verificationEventWorker: unhandled error in drain cycle");
		});
	}, POLL_INTERVAL_MS);

	return {
		close: () => {
			clearInterval(interval);
			logger.info("Verification event worker stopped");
		},
	};
};
