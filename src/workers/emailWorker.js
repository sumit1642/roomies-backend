























import { Worker } from "bullmq";
import { logger } from "../logger/index.js";
import { bullConnection } from "./bullConnection.js";
import { EMAIL_QUEUE_NAME } from "./emailQueue.js";
import {
	sendOtpEmail,
	sendVerificationApprovedEmail,
	sendVerificationRejectedEmail,
	sendVerificationPendingEmail,
} from "../services/email.service.js";










const EMAIL_HANDLERS = {
	
	otp: async ({ to, data }) => {
		await sendOtpEmail(to, data.otp);
	},

	
	
	
	verification_approved: async ({ to, data }) => {
		await sendVerificationApprovedEmail(to, data.ownerName, data.businessName);
	},

	
	
	verification_rejected: async ({ to, data }) => {
		await sendVerificationRejectedEmail(to, data.ownerName, data.rejectionReason);
	},

	
	
	
	verification_pending: async ({ to, data }) => {
		await sendVerificationPendingEmail(to, data.ownerName, data.businessName);
	},
};



export const startEmailWorker = () => {
	const worker = new Worker(
		EMAIL_QUEUE_NAME,
		async (job) => {
			const { type, to, data } = job.data;

			logger.info(
				{ type, to: maskEmailForLog(to), attempt: job.attemptsMade + 1, jobId: job.id },
				"Email worker: processing job",
			);

			const handler = EMAIL_HANDLERS[type];

			if (!handler) {
				
				
				
				logger.warn(
					{ type, jobId: job.id },
					"Email worker: no handler registered for this email type — job completed without sending. " +
						"Add a handler to EMAIL_HANDLERS in emailWorker.js.",
				);
				return;
			}

			
			await handler({ to, data: data ?? {} });

			logger.info({ type, to: maskEmailForLog(to), jobId: job.id }, "Email worker: email sent successfully");
		},
		{
			concurrency: 3,
			connection: bullConnection,
		},
	);

	worker.on("completed", (job) => {
		logger.info({ jobId: job.id, type: job.data.type }, "Email worker: job completed");
	});

	worker.on("failed", (job, err) => {
		
		logger.error(
			{ jobId: job?.id, type: job?.data?.type, to: maskEmailForLog(job?.data?.to), err },
			"Email worker: job failed after all retry attempts — email was not delivered",
		);
	});

	worker.on("error", (err) => {
		logger.error({ err }, "Email worker: worker-level error");
	});

	logger.info("Email delivery worker started");
	return worker;
};





const maskEmailForLog = (email) => {
	if (!email || typeof email !== "string") return "unknown";
	const [local, domain] = email.split("@");
	if (!domain) return "****";
	return `${local?.[0] ?? "*"}****@${domain}`;
};
