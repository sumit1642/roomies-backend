// src/services/email.service.js
//
// Thin orchestration layer: validates inputs, builds content via the pure
// template functions in src/email/templates.js, and hands off actual
// delivery to the configured emailSender (src/email/index.js). No provider
// knowledge (nodemailer, fetch, SMTP host/port, Brevo API key) lives here
// anymore — that's fully owned by src/email/senders/*.
//
// Each exported function keeps its original name/signature so callers
// (src/workers/emailWorker.js) require zero changes.

import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";
import { emailSender } from "../email/index.js";
import {
	buildOtpEmail,
	buildAdminLoginOtpEmail,
	buildVerificationApprovedEmail,
	buildVerificationRejectedEmail,
	buildVerificationPendingEmail,
} from "../email/templates.js";

const maskEmail = (email) => {
	const [local, domain] = email.split("@");
	if (!domain) return "****";
	const prefix = local?.length > 0 ? local[0] : "*";
	return `${prefix}****@${domain}`;
};

const assertValidRecipient = (to) => {
	if (!to || typeof to !== "string" || !to.includes("@")) {
		throw new AppError("Invalid recipient email address", 400);
	}
};

const assertValidOtp = (otp) => {
	if (!otp || typeof otp !== "string") {
		throw new AppError("OTP is required", 400);
	}
	if (!/^[0-9]{6}$/.test(otp)) {
		throw new AppError("Invalid OTP format — expected exactly 6 digits", 400);
	}
};

// Shared send + logging wrapper. `label` is used only for log messages so
// each email type's logs stay distinguishable, matching the original
// per-function log messages.
const sendAndLog = async (to, { subject, html, text }, label) => {
	const maskedTo = maskEmail(to);

	try {
		const messageId = await emailSender.send({ to, subject, html, text });
		logger.info({ to: maskedTo, messageId }, `${label} sent`);
		return messageId;
	} catch (err) {
		// emailSender.send() implementations already throw AppError on failure
		// (see EtherealSender/BrevoSmtpSender/BrevoApiSender) — just log and
		// rethrow so this layer's error messages stay attributable to the
		// specific email type being sent.
		logger.error({ to: maskedTo, err: err.message }, `Failed to send ${label.toLowerCase()}`);
		throw err;
	}
};

export const sendOtpEmail = async (to, otp) => {
	assertValidRecipient(to);
	assertValidOtp(otp);

	logger.info({ to: maskEmail(to) }, "Preparing OTP email");
	return sendAndLog(to, buildOtpEmail(otp), "OTP email");
};

export const sendAdminLoginOtpEmail = async (to, otp) => {
	assertValidRecipient(to);
	assertValidOtp(otp);

	logger.info({ to: maskEmail(to) }, "Preparing admin login OTP email");
	return sendAndLog(to, buildAdminLoginOtpEmail(otp), "Admin login OTP email");
};

export const sendVerificationApprovedEmail = async (to, ownerName, businessName) => {
	assertValidRecipient(to);
	if (!ownerName || typeof ownerName !== "string") {
		throw new AppError("ownerName is required for verification approved email", 400);
	}

	logger.info({ to: maskEmail(to) }, "Preparing verification approved email");
	return sendAndLog(to, buildVerificationApprovedEmail(ownerName, businessName), "Verification approved email");
};

export const sendVerificationRejectedEmail = async (to, ownerName, rejectionReason) => {
	assertValidRecipient(to);
	if (!ownerName || typeof ownerName !== "string") {
		throw new AppError("ownerName is required for verification rejected email", 400);
	}

	logger.info({ to: maskEmail(to) }, "Preparing verification rejected email");
	return sendAndLog(to, buildVerificationRejectedEmail(ownerName, rejectionReason), "Verification rejected email");
};

export const sendVerificationPendingEmail = async (to, ownerName, businessName) => {
	assertValidRecipient(to);
	if (!ownerName || typeof ownerName !== "string") {
		throw new AppError("ownerName is required for verification pending email", 400);
	}

	logger.info({ to: maskEmail(to) }, "Preparing verification pending email");
	return sendAndLog(to, buildVerificationPendingEmail(ownerName, businessName), "Verification pending email");
};
