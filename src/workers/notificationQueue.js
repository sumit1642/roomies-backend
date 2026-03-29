// src/workers/notificationQueue.js
//
// Single shared BullMQ Queue instance for the notification delivery queue.
// Previously, connection.service.js, interest.service.js, and rating.service.js
// each created their own `new Queue(NOTIFICATION_QUEUE_NAME, ...)` instance,
// which opened three separate Redis connections for the same logical queue.
// This module replaces all three by routing through the getQueue() singleton
// registry already used by the media processing queue.
//
// Usage in service files:
//   import { enqueueNotification } from "../workers/notificationQueue.js";
//   enqueueNotification({ recipientId, type, entityType, entityId });
//
// The helper is fire-and-forget: it catches Redis errors, logs them, and
// never throws — a missed notification is a UX inconvenience, not a data
// integrity problem. The worker retries up to 5 times with exponential backoff
// for any job that fails after being dequeued.

import { getQueue } from "./queue.js";
import { logger } from "../logger/index.js";
import { NOTIFICATION_QUEUE_NAME } from "./notificationWorker.js";

// Retry options applied at the job level so they take effect even though the
// getQueue() singleton was created with minimal defaultJobOptions.
const JOB_OPTIONS = {
	attempts: 5,
	backoff: { type: "exponential", delay: 2000 },
	removeOnComplete: 100,
	removeOnFail: 200,
};

export const enqueueNotification = (payload) => {
	getQueue(NOTIFICATION_QUEUE_NAME)
		.add("send-notification", payload, JOB_OPTIONS)
		.catch((err) => {
			logger.error(
				{ err, type: payload?.type, entityType: payload?.entityType, entityId: payload?.entityId },
				"Failed to enqueue notification"
			);
		});
};
