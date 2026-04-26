import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { enqueueNotification } from "./notificationQueue.js";
import { enqueueEmail } from "./emailQueue.js";

const POLL_INTERVAL_MS = 5_000;

const BATCH_SIZE = 10;

const MAX_ATTEMPTS = 5;

const processEvent = async (event, client) => {
	const { event_id, event_type, user_id, request_id, rejection_reason } = event;

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

	if (!userRows.length) {
		logger.info(
			{ event_id, user_id, event_type },
			"verificationEventWorker: user/profile not found — event skipped (user may have been deleted)",
		);
		return [];
	}

	const { email, owner_full_name, business_name, verification_status } = userRows[0];
	const sideEffects = [];

	if (event_type === "verification_approved") {
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

		sideEffects.push(
			() =>
				enqueueNotification({
					recipientId: user_id,
					type: "verification_approved",
					entityType: "verification_request",
					entityId: request_id,
				}),
			() =>
				enqueueEmail({
					type: "verification_approved",
					to: email,
					data: { ownerName: owner_full_name, businessName: business_name },
				}),
		);

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

		sideEffects.push(
			() =>
				enqueueNotification({
					recipientId: user_id,
					type: "verification_rejected",
					entityType: "verification_request",
					entityId: request_id,
				}),
			() =>
				enqueueEmail({
					type: "verification_rejected",
					to: email,
					data: {
						ownerName: owner_full_name,
						rejectionReason: rejection_reason ?? "Please review the requirements and resubmit.",
					},
				}),
		);

		logger.info(
			{ user_id, request_id, event_id },
			"verificationEventWorker: rejection event processed — notification + email enqueued",
		);
	} else if (event_type === "verification_pending") {
		sideEffects.push(() =>
			enqueueEmail({
				type: "verification_pending",
				to: email,
				data: { ownerName: owner_full_name, businessName: business_name },
			}),
		);

		logger.info(
			{ user_id, request_id, event_id },
			"verificationEventWorker: pending acknowledgement email enqueued",
		);
	} else {
		logger.warn({ event_id, event_type }, "verificationEventWorker: unknown event_type — skipping without retry");
	}

	return sideEffects;
};

const drainOutbox = async () => {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");

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

		const pendingSideEffects = [];

		for (const event of events) {
			try {
				const sideEffects = await processEvent(event, client);

				await client.query(
					`UPDATE verification_event_outbox
                     SET processed_at = NOW(),
                         attempts     = attempts + 1
                     WHERE event_id = $1`,
					[event.event_id],
				);

				pendingSideEffects.push(...sideEffects);
			} catch (err) {
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

		for (const fn of pendingSideEffects) {
			fn();
		}
	} catch (err) {
		try {
			await client.query("ROLLBACK");
		} catch (rollbackErr) {
			logger.debug({ rollbackErr }, "verificationEventWorker: rollback also failed");
		}
		logger.error({ err }, "verificationEventWorker: drain cycle transaction failed");
	} finally {
		client.release();
	}
};

export const startVerificationEventWorker = () => {
	logger.info(
		{ pollIntervalMs: POLL_INTERVAL_MS, batchSize: BATCH_SIZE, maxAttempts: MAX_ATTEMPTS },
		"Verification event worker started",
	);

	drainOutbox().catch((err) => {
		logger.error({ err }, "verificationEventWorker: error during initial startup drain");
	});

	let draining = false;
	const interval = setInterval(() => {
		if (draining) return;
		draining = true;
		drainOutbox()
			.catch((err) => {
				logger.error({ err }, "verificationEventWorker: unhandled error in drain cycle");
			})
			.finally(() => {
				draining = false;
			});
	}, POLL_INTERVAL_MS);

	return {
		close: () => {
			clearInterval(interval);
			logger.info("Verification event worker stopped");
		},
	};
};
