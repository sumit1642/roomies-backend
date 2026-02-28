// src/services/email.service.js
import nodemailer from "nodemailer";
import { config } from "../config/env.js";
import { logger } from "../logger/index.js";

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
	try {
		const info = await transport.sendMail({
			from: config.SMTP_FROM,
			to,
			subject: "Your Roomies verification code",
			text: `Your OTP is: ${otp}\n\nThis code expires in 10 minutes. Do not share it with anyone.`,
			html: `
					<p>Your Roomies verification code is:</p>
					<p>This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>


				`,
		});

		if (info.messageId) {
			const previewUrl = nodemailer.getTestMessageUrl(info);
			if (previewUrl) {
				logger.info({ to, previewUrl }, "OTP email sent - preview URL");
			} else {
				logger.info({ to, messageId: info.messageId }, "OTP email sent");
			}
		}
	} catch (err) {
		logger.error({ err, to }, "Failed to send OTP email");
		throw new AppError("Failed to send OTP email — try again shortly", 502);
	}
};
