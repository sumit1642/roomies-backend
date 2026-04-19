// src/workers/emailWorker.js
//
// BullMQ worker for reliable async email delivery.
//
// ─── ARCHITECTURE ─────────────────────────────────────────────────────────────
//
// This worker is the ONLY place that calls into email.service.js for actual
// delivery. auth.service.js calls enqueueEmail() → Redis job → this worker
// → email.service.js → Brevo SMTP.
//
// ─── ADDING A NEW EMAIL TYPE ─────────────────────────────────────────────────
//
// 1. Add the type string to EMAIL_HANDLERS below with an async handler function.
// 2. Call enqueueEmail({ type: 'your_type', to, data: { ... } }) from the
//    relevant service (or worker, like verificationEventWorker.js).
// 3. Add the corresponding sendXxxEmail() function to email.service.js.
// 4. Update the lifecycle annotation (ACTIVE / PLANNED) in the handler map.
//
// ─── CONCURRENCY = 3 ─────────────────────────────────────────────────────────
//
// Email delivery is I/O-bound (SMTP round-trip to Brevo). Three concurrent jobs
// provides enough throughput to drain bursts without approaching Brevo's rate
// limits on the free tier (300 emails/day).

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

// ─── Template handler map ──────────────────────────────────────────────────────
//
// Each handler receives the job's { to, data } and calls the appropriate
// email.service.js function. Throwing from a handler causes BullMQ to retry
// the job according to EMAIL_JOB_OPTIONS (3 attempts, exponential backoff).
//
// Lifecycle annotations:
//   ACTIVE  — enqueue call exists in the codebase today.
//   PLANNED — type defined, no enqueue call yet.
const EMAIL_HANDLERS = {
	// ACTIVE: enqueued by auth.service.js → sendOtp()
	otp: async ({ to, data }) => {
		await sendOtpEmail(to, data.otp);
	},

	// ACTIVE: enqueued by verificationEventWorker.js (CDC pipeline)
	// Fired when an admin approves a PG owner's verification request,
	// regardless of whether the approval came from the API or raw SQL.
	verification_approved: async ({ to, data }) => {
		await sendVerificationApprovedEmail(to, data.ownerName, data.businessName);
	},

	// ACTIVE: enqueued by verificationEventWorker.js (CDC pipeline)
	// Fired when an admin rejects a PG owner's verification request.
	verification_rejected: async ({ to, data }) => {
		await sendVerificationRejectedEmail(to, data.ownerName, data.rejectionReason);
	},

	// ACTIVE: enqueued by verificationEventWorker.js (CDC pipeline)
	// Fired immediately after a PG owner submits a document and status
	// transitions to 'pending'. Sends an acknowledgement: "we got your docs."
	verification_pending: async ({ to, data }) => {
		await sendVerificationPendingEmail(to, data.ownerName, data.businessName);
	},
};

// ─── Worker ────────────────────────────────────────────────────────────────────

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
				// Unknown type — log and complete without sending rather than
				// retrying forever with no handler registered.
				// This is a programming error, not a transient failure.
				logger.warn(
					{ type, jobId: job.id },
					"Email worker: no handler registered for this email type — job completed without sending. " +
						"Add a handler to EMAIL_HANDLERS in emailWorker.js.",
				);
				return;
			}

			// Delegate to the handler. Any throw triggers BullMQ retry.
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
		// Fires only after all retry attempts are exhausted.
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

// ─── Logging helper ───────────────────────────────────────────────────────────

// Masks email addresses in log output to protect PII in log aggregators.
// "priya@iitb.ac.in" becomes "p****@iitb.ac.in".
const maskEmailForLog = (email) => {
	if (!email || typeof email !== "string") return "unknown";
	const [local, domain] = email.split("@");
	if (!domain) return "****";
	return `${local?.[0] ?? "*"}****@${domain}`;
};
