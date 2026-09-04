// src/email/senders/etherealSender.js
//
// Ethereal Mail sender — a fake SMTP server used in local development.
// Every sent email is intercepted by Ethereal's test account and never
// delivered to the real recipient; a preview URL is logged instead so a
// developer can read the OTP/content during local dev.
//
// Implements the EmailSender contract: async send({ to, subject, html, text })
// -> messageId. No caller outside src/email/ should import nodemailer or
// touch SMTP_* config directly — that concern lives entirely here, mirroring
// how storage/adapters/localDisk.js owns all its own filesystem details.

import nodemailer from "nodemailer";
import { config } from "../../config/env.js";
import { logger } from "../../logger/index.js";
import { AppError } from "../../middleware/errorHandler.js";

export class EtherealSender {
	constructor() {
		this.transport = nodemailer.createTransport({
			host: config.SMTP_HOST,
			port: config.SMTP_PORT,
			secure: config.SMTP_PORT === 465,
			auth: {
				user: config.SMTP_USER,
				pass: config.SMTP_PASS,
			},
		});

		logger.info(
			{ provider: "ethereal", host: config.SMTP_HOST, port: config.SMTP_PORT },
			"EtherealSender initialised (no real emails will be sent)",
		);
	}

	async send({ to, subject, html, text }) {
		const fromAddress = `"Roomies" <${config.SMTP_FROM}>`;

		try {
			const info = await this.transport.sendMail({ from: fromAddress, to, subject, text, html });

			const previewUrl =
				typeof nodemailer.getTestMessageUrl === "function" ? nodemailer.getTestMessageUrl(info) : undefined;
			if (previewUrl) {
				logger.info({ previewUrl, provider: "ethereal" }, "EtherealSender: email sent — open preview URL");
			}

			return info.messageId;
		} catch (err) {
			logger.error({ err, provider: "ethereal" }, "EtherealSender: send failed");
			throw new AppError("Failed to send email — try again shortly", 502);
		}
	}
}
