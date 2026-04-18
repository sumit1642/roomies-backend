// src/workers/emailWorker.js
//
// BullMQ worker for reliable async email delivery.
//
// ─── ARCHITECTURE ─────────────────────────────────────────────────────────────
//
// This worker is the ONLY place that calls into email.service.js for actual
// delivery. Previously, auth.service.js called sendOtpEmail() directly in the
// HTTP request path. That's now replaced by:
//
//   HTTP request → auth.service.js → enqueueEmail() → Redis job
//                                                          ↓
//                                               emailWorker processes job
//                                                          ↓
//                                               email.service.js → Brevo SMTP
//
// The Nodemailer transport singleton in email.service.js is created once at
// module load time. This worker imports and calls the template functions from
// that module — it does NOT create a new transport. This means the existing
// SMTP connection pool is reused across all email sends, which is correct.
//
// ─── CONCURRENCY = 3 ─────────────────────────────────────────────────────────
//
// Email delivery is I/O-bound (SMTP round-trip to Brevo). Three concurrent jobs
// provides enough throughput to drain bursts (e.g. many users registering at
// once during a college orientation day) without approaching Brevo's rate limits.
// On the free tier (300 emails/day), 3 concurrent workers sending at ~1/second
// is well within limits. Increase to 5–10 if you move to a paid Brevo plan.
//
// ─── TEMPLATE SYSTEM ─────────────────────────────────────────────────────────
//
// Each job payload carries a `type` field that maps to a render function in
// the EMAIL_RENDERERS map below. The render function receives `data` from the
// job payload and returns { to, subject, text, html }. The worker passes this
// to the Nodemailer transport in email.service.js.
//
// Adding a new email type:
//   1. Add the type string to the EMAIL_RENDERERS map with a render function.
//   2. Call enqueueEmail({ type: "your_type", to, data: { ... } }) from the
//      relevant service.
//   3. Add the corresponding sendXxxEmail() function to email.service.js if
//      the rendering is complex enough to warrant a dedicated function.
//
// ─── IDEMPOTENCY ─────────────────────────────────────────────────────────────
//
// Unlike the notification worker, email has no DB idempotency_key guard. The
// reason: notifications are stored in the DB and the UNIQUE constraint prevents
// duplicate rows. Email is fire-and-delete — there's no record to check against.
// If BullMQ retries a job after a crash, the user may receive a duplicate OTP
// email. This is acceptable (they can use either code; the latest OTP replaces
// the previous one in Redis anyway). Adding DB-level email dedup would require
// a new table and is not worth the complexity at this scale.

import { Worker } from "bullmq";
import { logger } from "../logger/index.js";
import { bullConnection } from "./bullConnection.js";
import { EMAIL_QUEUE_NAME } from "./emailQueue.js";
import {
	sendOtpEmail,
	sendVerificationApprovedEmail,
	sendVerificationRejectedEmail,
} from "../services/email.service.js";

// ─── Template renderers map ────────────────────────────────────────────────────
//
// Each renderer receives the job's `data` object and returns nothing — it
// calls the appropriate email.service.js function directly, which handles all
// template rendering and transport internally.
//
// Lifecycle annotations mirror notificationWorker.js:
//   ACTIVE  — emitter exists, this type is produced today.
//   PLANNED — type defined, no emitter yet. Implement the emitter and remove.
const EMAIL_HANDLERS = {
	// ACTIVE: enqueued by auth.service.js sendOtp()
	otp: async ({ to, data }) => {
		await sendOtpEmail(to, data.otp);
	},

	// PLANNED: will be enqueued by verification.service.js approveRequest()
	// once Phase 5 admin wires it up. The handler is defined now so the worker
	// does not crash if a job of this type arrives early.
	verification_approved: async ({ to, data }) => {
		await sendVerificationApprovedEmail(to, data.ownerName, data.businessName);
	},

	// PLANNED: will be enqueued by verification.service.js rejectRequest()
	verification_rejected: async ({ to, data }) => {
		await sendVerificationRejectedEmail(to, data.ownerName, data.rejectionReason);
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
				// Unknown type: log a warning but do NOT throw. Throwing would cause
				// BullMQ to retry the job — which is pointless since no handler exists.
				// We complete the job successfully so it is removed from the queue
				// rather than filling up the failed set with permanently unprocessable jobs.
				// This is the correct pattern when the error is a programming mistake
				// (missing handler) rather than a transient infrastructure failure.
				logger.warn(
					{ type, jobId: job.id },
					"Email worker: no handler registered for this email type — job completed without sending. " +
						"Add a handler to EMAIL_HANDLERS in emailWorker.js.",
				);
				return;
			}

			// Call the handler. If it throws (e.g. Brevo SMTP connection refused),
			// BullMQ catches the error and retries according to EMAIL_JOB_OPTIONS.
			// The error is NOT caught here — we want BullMQ to own the retry logic.
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
		// This fires only after all retry attempts are exhausted. At this point
		// the user has not received the email. Log at error level so it surfaces
		// in Azure Monitor / Pino aggregators. Consider a Slack/PagerDuty alert
		// here once the platform has real users.
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
//
// Masks email addresses in log output to protect PII. "priya@iitb.ac.in"
// becomes "p****@iitb.ac.in". Consistent with the masking in email.service.js.
const maskEmailForLog = (email) => {
	if (!email || typeof email !== "string") return "unknown";
	const [local, domain] = email.split("@");
	if (!domain) return "****";
	return `${local?.[0] ?? "*"}****@${domain}`;
};
