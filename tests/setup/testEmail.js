// tests/setup/testEmail.js
//
// Mocks nodemailer at the module level (nodemailer-mock intercepts sendMail
// and records it) and exposes a helper that waits for the real BullMQ email
// worker to actually process an enqueued job, then extracts content from the
// mocked "sent" mail.
//
// IMPORTANT: waitForNextEmail() resolves on the FIRST 'completed' event on
// the email-delivery queue after the listener attaches. This is safe only
// when exactly one email job is in flight for the duration of the wait.
// Today that holds for OTP (one email per send) but NOT for verification
// approval/rejection, which can enqueue a notification AND an email in the
// same outbox-drain cycle, or for flows that fire multiple emails back to
// back. For those, use waitForNextEmail() once per expected email, awaiting
// each fully before triggering the next action — do not fire two actions
// and then await twice, since events can arrive in either order relative to
// which action produced them. If a suite ever needs to disambiguate
// concurrently in-flight emails, filter by jobId (requires enqueueEmail to
// return the Job) or match on the mocked `to`/`subject` instead of trusting
// "the next completed event".

import { jest } from "@jest/globals";
import { QueueEvents } from "bullmq";
import { bullConnection } from "../../src/workers/bullConnection.js";
import { EMAIL_QUEUE_NAME } from "../../src/workers/emailQueue.js";

export const mockNodemailer = () => {
	jest.unstable_mockModule("nodemailer", () => import("nodemailer-mock"));
};

let queueEvents;

const getQueueEvents = () => {
	queueEvents = queueEvents ?? new QueueEvents(EMAIL_QUEUE_NAME, { connection: bullConnection });
	return queueEvents;
};

export const waitForNextEmail = (timeoutMs = 5000) => {
	const events = getQueueEvents();

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			events.off("completed", onCompleted);
			events.off("failed", onFailed);
			reject(new Error(`waitForNextEmail: no email job completed within ${timeoutMs}ms`));
		}, timeoutMs);

		const onCompleted = ({ jobId }) => {
			clearTimeout(timer);
			events.off("failed", onFailed);
			resolve(jobId);
		};
		const onFailed = ({ jobId, failedReason }) => {
			clearTimeout(timer);
			events.off("completed", onCompleted);
			reject(new Error(`waitForNextEmail: job ${jobId} failed — ${failedReason}`));
		};

		events.once("completed", onCompleted);
		events.once("failed", onFailed);
	});
};

export const closeEmailTestListener = async () => {
	if (queueEvents) {
		await queueEvents.close();
		queueEvents = undefined;
	}
};

export const extractOtpFromMock = async (nodemailerMock, toEmail) => {
	const sent = nodemailerMock.mock.getSentMail();
	const mail = [...sent].reverse().find((m) => m.to === toEmail);
	if (!mail) throw new Error(`extractOtpFromMock: no mail found sent to ${toEmail}`);
	const match = mail.text.match(/\b(\d{6})\b/);
	if (!match) throw new Error(`extractOtpFromMock: could not find a 6-digit OTP in mail text`);
	return match[1];
};

// Generic lookup for non-OTP emails (verification approved/rejected/pending)
// where we only need to assert the right email went out, not extract a code.
export const findSentMailTo = (nodemailerMock, toEmail) => {
	const sent = nodemailerMock.mock.getSentMail();
	return [...sent].reverse().find((m) => m.to === toEmail) ?? null;
};
