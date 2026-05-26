import { getQueue } from "./queue.js";
import { logger } from "../logger/index.js";
import { NOTIFICATION_QUEUE_NAME } from "./notificationWorker.js";

const JOB_OPTIONS = {
	attempts: 5,
	backoff: { type: "exponential", delay: 2000 },
	removeOnComplete: 100,
	removeOnFail: 200,
};

export const enqueueNotification = (payload) => {
	try {
		getQueue(NOTIFICATION_QUEUE_NAME)
			.add("send-notification", payload, JOB_OPTIONS)
			.catch((err) => {
				logger.error(
					{ err, type: payload?.type, entityType: payload?.entityType, entityId: payload?.entityId },
					"Failed to enqueue notification",
				);
			});
	} catch (err) {
		logger.error(
			{ err, type: payload?.type, entityType: payload?.entityType, entityId: payload?.entityId },
			"Failed to enqueue notification",
		);
	}
};

export const enqueueNotificationsBulk = async (payloads) => {
	if (!payloads.length) return 0;

	try {
		await getQueue(NOTIFICATION_QUEUE_NAME).addBulk(
			payloads.map((payload) => ({
				name: "send-notification",
				data: payload,
				opts: JOB_OPTIONS,
			})),
		);
		return payloads.length;
	} catch (err) {
		logger.error({ err, count: payloads.length }, "Failed to bulk enqueue notifications");
		throw err;
	}
};
