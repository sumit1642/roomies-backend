// src/email/senders/brevoApiSender.js
//
// Brevo HTTP API sender — used for tier0 deployment where the host doesn't
// provide SMTP on the free tier (see config/env.js's EMAIL_PROVIDER comment).
// No nodemailer transport involved; this hits Brevo's REST endpoint directly
// via fetch, same request shape the original sendViaBrevoAPI() used.
//
// Implements the EmailSender contract: async send({ to, subject, html, text })
// -> messageId.

import { config } from "../../config/env.js";
import { logger } from "../../logger/index.js";
import { AppError } from "../../middleware/errorHandler.js";

const maskEmail = (email) => {
	const [local, domain] = email.split("@");
	if (!domain) return "****";
	const prefix = local?.length > 0 ? local[0] : "*";
	return `${prefix}****@${domain}`;
};

export class BrevoApiSender {
	constructor() {
		logger.info({ provider: "brevo-api" }, "BrevoApiSender initialised");
	}

	async send({ to, subject, html, text }) {
		const maskedTo = maskEmail(to);
		logger.info({ to: maskedTo, provider: "brevo-api" }, "BrevoApiSender: sending via Brevo REST API");

		let response;
		try {
			response = await fetch("https://api.brevo.com/v3/smtp/email", {
				method: "POST",
				signal: AbortSignal.timeout(15_000),
				headers: {
					"Content-Type": "application/json",
					"api-key": config.BREVO_API_KEY,
				},
				body: JSON.stringify({
					sender: { name: "Roomies", email: config.BREVO_SMTP_FROM },
					to: [{ email: to }],
					subject,
					htmlContent: html,
					textContent: text,
				}),
			});
		} catch (err) {
			if (err.name === "TimeoutError" || err.name === "AbortError") {
				logger.error({ to: maskedTo }, "BrevoApiSender: request timed out after 15s");
				throw new AppError("Email delivery timed out — try again shortly", 504);
			}
			throw new AppError("Failed to send email via Brevo API — try again shortly", 502);
		}

		if (!response.ok) {
			const errorBody = await response.json().catch(() => ({}));
			logger.error({ to: maskedTo, status: response.status, error: errorBody }, "BrevoApiSender: send failed");
			throw new AppError("Failed to send email via Brevo API — try again shortly", 502);
		}

		const result = await response.json();
		logger.info({ to: maskedTo, messageId: result.messageId }, "BrevoApiSender: email sent successfully");
		return result.messageId;
	}
}
