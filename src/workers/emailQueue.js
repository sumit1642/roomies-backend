
















































import { getQueue } from "./queue.js";
import { logger } from "../logger/index.js";

export const EMAIL_QUEUE_NAME = "email-delivery";






const EMAIL_JOB_OPTIONS = {
	attempts: 3,
	backoff: { type: "exponential", delay: 5_000 },
	removeOnComplete: 100,
	removeOnFail: 200,
};







export const enqueueEmail = (payload) => {
	
	
	if (!payload?.type || !payload?.to) {
		logger.error({ payload }, "enqueueEmail: missing required fields (type, to) — email job not enqueued");
		return;
	}

	try {
		getQueue(EMAIL_QUEUE_NAME)
			.add("send-email", payload, EMAIL_JOB_OPTIONS)
			.catch((err) => {
				
				logger.error({ err, type: payload.type, to: payload.to }, "enqueueEmail: failed to enqueue email job");
			});
	} catch (err) {
		
		logger.error(
			{ err, type: payload.type, to: payload.to },
			"enqueueEmail: synchronous error during email enqueue",
		);
	}
};
