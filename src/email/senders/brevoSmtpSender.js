// src/email/senders/brevoSmtpSender.js
//
// Brevo SMTP relay sender — real email delivery via smtp-relay.brevo.com.
// Host/port are hardcoded to Brevo's documented values (587, STARTTLS) so
// they can never be accidentally overridden by an env file, matching the
// original email.service.js comment on this exact point.
//
// Implements the EmailSender contract: async send({ to, subject, html, text })
// -> messageId.

import nodemailer from "nodemailer";
import { config } from "../../config/env.js";
import { logger } from "../../logger/index.js";
import { AppError } from "../../middleware/errorHandler.js";
import { maskEmail } from "../utils.js";

export class BrevoSmtpSender {
	constructor() {
		this.transport = nodemailer.createTransport({
			host: "smtp-relay.brevo.com",
			port: 587,
			secure: false,
			requireTLS: true,
			auth: {
				user: config.BREVO_SMTP_LOGIN,
				pass: config.BREVO_SMTP_KEY,
			},
		});

		logger.info(
			{
				provider: "brevo",
				host: "smtp-relay.brevo.com",
				port: 587,
				login: maskEmail(config.BREVO_SMTP_LOGIN),
				from: maskEmail(config.BREVO_SMTP_FROM),
			},
			"BrevoSmtpSender initialised",
		);
	}

	async send({ to, subject, html, text }) {
		const fromAddress = `"Roomies" <${config.BREVO_SMTP_FROM}>`;
		const maskedTo = maskEmail(to);

		try {
			const info = await this.transport.sendMail({ from: fromAddress, to, subject, text, html });
			logger.info({ to: maskedTo, messageId: info.messageId, provider: "brevo" }, "BrevoSmtpSender: email sent");
			return info.messageId;
		} catch (err) {
			logger.error(
				{ to: maskedTo, provider: "brevo", errCode: err.code, errMessage: err.message },
				"BrevoSmtpSender: send failed",
			);
			throw new AppError("Failed to send email — try again shortly", 502);
		}
	}
}
