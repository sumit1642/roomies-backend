// src/workers/emailQueue.js
//
// Shared BullMQ queue helper for the email delivery pipeline.
//
// This module is the single enqueue point for all outbound email jobs. It
// mirrors notificationQueue.js in design — a fire-and-forget wrapper around
// getQueue() that catches Redis errors and never throws, so a Redis hiccup
// cannot block an auth flow or admin action that triggers an email.
//
// ─── WHY A QUEUE INSTEAD OF DIRECT sendMail() CALLS ─────────────────────────
//
// The previous pattern called sendOtpEmail() synchronously inside auth.service.js.
// That approach has two failure modes:
//
//   1. Slow Brevo SMTP relay makes the entire HTTP request hang — a user waiting
//      for "OTP sent" feedback can sit there for 5+ seconds on a slow connection.
//
//   2. Process crash between Redis.setEx() and sendMail() means the OTP is stored
//      but the email is never sent — the user has no code to enter and no idea why.
//
// Enqueueing durably to Redis means the job survives a process crash. BullMQ
// retries on failure with exponential backoff. The HTTP request returns in ~1ms
// (just the Redis LPUSH) instead of waiting for the SMTP round-trip.
//
// ─── ACCEPTABLE FAILURE MODE ─────────────────────────────────────────────────
//
// One failure mode remains: Redis goes down between storing the OTP hash and
// enqueueing the email job. In that scenario the OTP is in Redis but no email
// job exists. The user sees "OTP sent" but receives nothing. The mitigation
// is the frontend "resend OTP" button — the user can retry, which creates a
// fresh job. This is the same trade-off made in notificationQueue.js and is
// acceptable at this scale.
//
// ─── PAYLOAD CONTRACT ────────────────────────────────────────────────────────
//
// Every email job carries a typed payload so the worker knows which template
// to render without any switch logic leaking into the enqueue site:
//
//   { type: "otp", to: "user@example.com", data: { otp: "123456" } }
//
// Current types:
//   "otp"                   — ACTIVE: OTP verification email
//   "verification_approved" — PLANNED: PG owner verification approved (Phase 5 admin)
//   "verification_rejected" — PLANNED: PG owner verification rejected (Phase 5 admin)
//
// The worker validates the type at processing time and falls back to a null
// template render with a warn log if an unknown type arrives — same pattern
// as notificationWorker.js.

import { getQueue } from "./queue.js";
import { logger } from "../logger/index.js";

export const EMAIL_QUEUE_NAME = "email-delivery";

// Job options mirror the notification worker: 3 attempts is intentionally fewer
// than the notification worker's 5. OTPs expire in 10 minutes, so beyond 3
// retries (at ~5s, ~10s, ~20s — all within the valid window) further attempts
// are unlikely to succeed if Brevo is genuinely down. Exhausted jobs land in
// the BullMQ failed set for manual inspection via the BullMQ dashboard or logs.
const EMAIL_JOB_OPTIONS = {
	attempts: 3,
	backoff: { type: "exponential", delay: 5_000 },
	removeOnComplete: 100,
	removeOnFail: 200,
};

// enqueueEmail is fire-and-forget. It never throws — a Redis failure is logged
// at error level but does not propagate upward. The caller (auth service, admin
// verification service) should handle the case where the user did not receive
// the email via the resend / retry mechanism in the frontend.
//
// payload shape: { type: string, to: string, data: Record<string, unknown> }
export const enqueueEmail = (payload) => {
	// Validate the minimum shape before hitting Redis so malformed calls produce
	// a clear log entry rather than a cryptic BullMQ serialisation error.
	if (!payload?.type || !payload?.to) {
		logger.error({ payload }, "enqueueEmail: missing required fields (type, to) — email job not enqueued");
		return;
	}

	try {
		getQueue(EMAIL_QUEUE_NAME)
			.add("send-email", payload, EMAIL_JOB_OPTIONS)
			.catch((err) => {
				// .add() returns a Promise; catch async errors from the Redis write.
				logger.error({ err, type: payload.type, to: payload.to }, "enqueueEmail: failed to enqueue email job");
			});
	} catch (err) {
		// Catch synchronous errors from getQueue() itself (e.g. queue registry issue).
		logger.error(
			{ err, type: payload.type, to: payload.to },
			"enqueueEmail: synchronous error during email enqueue",
		);
	}
};
