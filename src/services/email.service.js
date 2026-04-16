// src/services/email.service.js
//
// ─── TRANSPORT ARCHITECTURE ───────────────────────────────────────────────────
//
// This service supports two email providers, selected by EMAIL_PROVIDER in the
// environment:
//
//   "ethereal" — Nodemailer pointed at Ethereal's fake SMTP server. Used for
//                all local development. Every email is intercepted — never
//                delivered — and a preview URL is logged so you can read OTPs.
//
//   "brevo"    — Nodemailer pointed at Brevo's SMTP relay
//                (smtp-relay.brevo.com:587). Used for production. Emails are
//                really sent. Brevo provides delivery logs, open tracking, and
//                spam analytics in its dashboard.
//
// Critically, both providers use EXACTLY the same Nodemailer transport API.
// The rest of this file (sendOtpEmail, maskEmail, guards) is 100% identical
// for both providers — the factory just swaps the credentials underneath.
//
// ─── WHY NOT THE @getbrevo/brevo SDK? ────────────────────────────────────────
//
// Brevo publishes an official JS SDK (@getbrevo/brevo) that wraps their REST
// API. For sending a simple OTP email, the SMTP relay via Nodemailer is the
// right choice for three reasons:
//
//   1. Zero new dependencies — Nodemailer is already installed.
//   2. Identical code path — swapping providers is just a config change, not a
//      code change. The SDK API differs from Nodemailer's API significantly.
//   3. Brevo's own documentation recommends Nodemailer for Node.js SMTP relay
//      (https://developers.brevo.com/docs/node-smtp-relay-example).
//
// The SDK would be appropriate if we were doing batch sends, contact management,
// or marketing campaigns — none of which are needed for transactional OTPs.
//
// ─── BREVO SMTP KEY vs API KEY ────────────────────────────────────────────────
//
// Brevo has two different credentials that are easy to confuse:
//   SMTP key  — starts with "xsmtpsib-..." — used as the SMTP password here
//   API key   — starts with "xkeysib-..."  — used by the REST SDK / HTTP API
//
// The cross-field guard in env.js detects the API key being used where the
// SMTP key is expected and exits with a clear error message at startup.

import nodemailer from "nodemailer";
import { config } from "../config/env.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";

// ─── Mask email for safe logging ──────────────────────────────────────────────
//
// "priya@iitb.ac.in" → "p****@iitb.ac.in"
// Keeps the first character and full domain so log correlation is still
// possible without exposing the full address in log aggregators or audit trails.
const maskEmail = (email) => {
	const [local, domain] = email.split("@");
	if (!domain) return "****";
	const prefix = local && local.length > 0 ? local[0] : "*";
	return `${prefix}****@${domain}`;
};

// ─── Transport factory ────────────────────────────────────────────────────────
//
// Creates and returns a Nodemailer transporter based on EMAIL_PROVIDER.
// Called once at module load time (see `transport` below) so the connection
// setup cost is paid at startup, not on the first send call.
//
// All Nodemailer transporter options:
//   host     — the SMTP server hostname
//   port     — 587 for STARTTLS (most providers including Ethereal and Brevo)
//   secure   — false for port 587 (STARTTLS upgrade happens after connect)
//              true for port 465 (SSL from the first byte)
//   auth     — { user, pass } object with the SMTP credentials
//
// Brevo-specific notes:
//   - host is hardcoded to "smtp-relay.brevo.com" — not taken from config —
//     so there is no risk of an env var override pointing production at the
//     wrong server.
//   - port 587 with secure:false is what Brevo's documentation recommends.
//     Port 465 (secure:true) is also supported by Brevo but 587 is preferred.
//   - auth.user is your SMTP Login (e.g. xxxxx@smtp-brevo.com from the
//     dashboard SMTP tab, stored in BREVO_SMTP_LOGIN).
//   - auth.pass is your SMTP Key (the xsmtpsib-... value, stored in
//     BREVO_SMTP_KEY). This is NOT your Brevo account password.
const createEmailTransport = () => {
	if (config.EMAIL_PROVIDER === "brevo") {
		logger.info(
			{ provider: "brevo", host: "smtp-relay.brevo.com", port: 587, login: maskEmail(config.BREVO_SMTP_LOGIN) },
			"Email transport: Brevo SMTP relay initialised",
		);

		return nodemailer.createTransport({
			host: "smtp-relay.brevo.com", // Brevo's documented SMTP relay host — hardcoded intentionally
			port: 587, // Non-encrypted port; Nodemailer upgrades to STARTTLS automatically
			secure: false, // Must be false for port 587 (true is only for port 465/SSL)
			auth: {
				user: config.BREVO_SMTP_LOGIN, // Your Brevo SMTP Login (e.g. xxxxx@smtp-brevo.com)
				pass: config.BREVO_SMTP_KEY, // Your Brevo SMTP Key (xsmtpsib-...), NOT the API key
			},
		});
	}

	// Default: Ethereal fake SMTP for development.
	// config.SMTP_HOST / SMTP_USER / SMTP_PASS come from .env.local.
	// secure is derived from port: port 465 → true (SSL), all others → false.
	logger.info(
		{ provider: "ethereal", host: config.SMTP_HOST, port: config.SMTP_PORT },
		"Email transport: Ethereal fake SMTP initialised (no real emails will be sent)",
	);

	return nodemailer.createTransport({
		host: config.SMTP_HOST,
		port: config.SMTP_PORT,
		secure: config.SMTP_PORT === 465, // true only for SSL port; Ethereal uses 587 with STARTTLS
		auth: {
			user: config.SMTP_USER,
			pass: config.SMTP_PASS,
		},
	});
};

// ─── Singleton transport ──────────────────────────────────────────────────────
//
// The transport is created once when this module is first imported. Creating it
// per-call would re-open a TCP connection on every OTP send, which is wasteful
// and slow. Nodemailer reuses the underlying SMTP connection for subsequent calls
// when the server keeps it alive (which Brevo and Ethereal both do).
const transport = createEmailTransport();

// ─── Sender address resolver ──────────────────────────────────────────────────
//
// Returns the "From" address appropriate for the active provider.
// For Brevo this must be BREVO_SMTP_FROM — a sender address that has been
// verified / authenticated in your Brevo account. Using an unverified address
// causes Brevo to reject the message with a 550 error.
// For Ethereal, SMTP_FROM (the classic dev var) is used.
const getSenderAddress = () => {
	if (config.EMAIL_PROVIDER === "brevo") {
		return config.BREVO_SMTP_FROM;
	}
	return config.SMTP_FROM;
};

// ─── Send OTP email ───────────────────────────────────────────────────────────
export const sendOtpEmail = async (to, otp) => {
	// Input validation — the service layer already validates before calling this,
	// but guard here so this function is safe to call from any future context.
	if (!to || typeof to !== "string" || !to.includes("@")) {
		throw new AppError("Invalid recipient email address", 400);
	}
	if (!otp || typeof otp !== "string") {
		throw new AppError("OTP is required", 400);
	}
	if (!/^[0-9]{6}$/.test(otp)) {
		throw new AppError("Invalid OTP format", 400);
	}

	const maskedTo = maskEmail(to);
	const fromAddress = getSenderAddress();

	try {
		const info = await transport.sendMail({
			from: `"Roomies" <${fromAddress}>`, // Display name + address in RFC 5322 format
			to,
			subject: "Your Roomies verification code",
			text: `Your OTP is: ${otp}\n\nThis code expires in 10 minutes. Do not share it with anyone.`,
			html: `
				<div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
					<h2 style="color: #333;">Your Roomies verification code</h2>
					<p style="color: #555;">Enter the code below to verify your email address.</p>
					<div style="
						background: #f5f5f5;
						border-radius: 8px;
						padding: 24px;
						text-align: center;
						margin: 24px 0;
					">
						<span style="
							font-size: 36px;
							font-weight: bold;
							letter-spacing: 8px;
							color: #222;
							font-family: monospace;
						">${otp}</span>
					</div>
					<p style="color: #555;">
						This code expires in <strong>10 minutes</strong>.
						Do not share it with anyone.
					</p>
					<p style="color: #999; font-size: 12px;">
						If you did not request this code, you can safely ignore this email.
					</p>
				</div>
			`,
		});

		// Ethereal Mail returns a preview URL — log it so developers can
		// read the OTP during local development without checking a real inbox.
		// nodemailer.getTestMessageUrl() returns null for real SMTP providers
		// like Brevo, so this log line is silently skipped in production.
		const previewUrl = nodemailer.getTestMessageUrl(info);
		if (previewUrl) {
			logger.info(
				{ to: maskedTo, previewUrl, provider: "ethereal" },
				"OTP email sent — open preview URL to read the code",
			);
		} else {
			// Real delivery (Brevo or any live SMTP). Log the Brevo message ID
			// which appears in their transactional logs for debugging delivery issues.
			logger.info({ to: maskedTo, messageId: info.messageId, provider: config.EMAIL_PROVIDER }, "OTP email sent");
		}

		return info.messageId;
	} catch (err) {
		// Redact the full error object — it may contain SMTP credentials or server
		// details that should not appear in log aggregators or error trackers.
		logger.error(
			{
				to: maskedTo,
				provider: config.EMAIL_PROVIDER,
				errCode: err.code, // e.g. "ECONNREFUSED", "EAUTH"
				errMessage: err.message, // e.g. "Invalid login", "Connection timeout"
			},
			"Failed to send OTP email",
		);

		throw new AppError("Failed to send OTP email — try again shortly", 502);
	}
};
