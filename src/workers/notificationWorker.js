import { Worker } from "bullmq";
import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { bullConnection } from "./bullConnection.js";

export const NOTIFICATION_QUEUE_NAME = "notification-delivery";

const NOTIFICATION_MESSAGES = {
	interest_request_received: "Someone expressed interest in your listing",
	interest_request_accepted: "Your interest request was accepted",
	interest_request_declined: "Your interest request was declined",
	interest_request_withdrawn: "An interest request was withdrawn",

	connection_confirmed: "Your connection has been confirmed by both parties",

	rating_received: "You received a new rating",

	listing_expiring: "One of your listings is expiring soon",
	listing_expired: "One of your listings has expired",

	listing_filled: "A listing has been marked as filled",

	verification_approved: "Your verification request was approved",

	verification_rejected: "Your verification request was rejected",

	verification_pending: "Your verification documents have been received and are under review",

	new_message: "You have a new message",

	connection_requested: "You have a new connection request",
	
	saved_search_alert: "A new listing matches your saved search",
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
					"Notification worker: no message template for this type — inserting with NULL message. " +
						"Add an entry to NOTIFICATION_MESSAGES in notificationWorker.js.",
				);
			}

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
