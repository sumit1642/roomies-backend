// src/services/email.service.js

import nodemailer from "nodemailer";
import { config } from "../config/env.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";

// Masks an email for safe logging — "priya@iitb.ac.in" → "p****@iitb.ac.in".
// Keeps the first character and full domain so log correlation is still possible
// without exposing the full address in log aggregators or audit trails.
const maskEmail = (email) => {
	const [local, domain] = email.split("@");
	if (!domain) return "****";
	return `${local[0]}****@${domain}`;
};

// Transport created once at module level — not on every send call.
// In development this points to Ethereal Mail (fake SMTP).
// The preview URL logged after each send is how you see the OTP in dev.
const transport = nodemailer.createTransport({
	host: config.SMTP_HOST,
	port: config.SMTP_PORT,
	// Ethereal uses STARTTLS on 587 — secure:false with STARTTLS upgrade
	secure: config.SMTP_PORT === 465,
	auth: {
		user: config.SMTP_USER,
		pass: config.SMTP_PASS,
	},
});

export const sendOtpEmail = async (to, otp) => {
	// Input validation — the service layer already validates before calling this,
	// but guard here so this function is safe to call from any future context.
	if (!to || typeof to !== "string" || !to.includes("@")) {
		throw new AppError("Invalid recipient email address", 400);
	}
	if (!otp || typeof otp !== "string") {
		throw new AppError("OTP is required", 400);
	}

	const maskedTo = maskEmail(to);

	try {
		const info = await transport.sendMail({
			from: config.SMTP_FROM,
			to,
			subject: "Your Roomies verification code",
			text: `Your OTP is: ${otp}\n\nThis code expires in 10 minutes. Do not share it with anyone.`,
			html: `
        <p>Your Roomies verification code is:</p>
        <h2 style="letter-spacing:4px">${otp}</h2>
        <p>This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>
		`,
		});

		// Ethereal Mail returns a preview URL — only populated in dev/test.
		// Log masked email only — never the raw address.
		if (info.messageId) {
			const previewUrl = nodemailer.getTestMessageUrl(info);
			if (previewUrl) {
				logger.info({ to: maskedTo, previewUrl }, "OTP email sent — preview URL");
			} else {
				logger.info({ to: maskedTo, messageId: info.messageId }, "OTP email sent");
			}
		}

		return info.messageId;
	} catch (err) {
		logger.error({ err, to: maskedTo }, "Failed to send OTP email");
		throw new AppError("Failed to send OTP email — try again shortly", 502);
	}
};
