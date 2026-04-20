// src/services/email.service.js
//
// ─── TRANSPORT ARCHITECTURE ───────────────────────────────────────────────────
//
// This service supports two email providers, selected at startup by EMAIL_PROVIDER
// in the environment:
//
//   "ethereal" — Nodemailer pointed at Ethereal's fake SMTP server.
//                Used during local development. Every email is intercepted and
//                never delivered to the real recipient. A preview URL is logged
//                to the console so you can read the OTP without a real inbox.
//                Set EMAIL_PROVIDER=ethereal in .env.local.
//
//   "brevo"    — Nodemailer pointed at Brevo's SMTP relay
//                (smtp-relay.brevo.com:587 with STARTTLS).
//                Used in production / staging. Emails are really delivered.
//                Brevo's dashboard provides delivery logs and open tracking.
//                Set EMAIL_PROVIDER=brevo in your production env file.
//
// Both providers use the same Nodemailer transport API. The rest of this file —
// sendOtpEmail, maskEmail, and the format guards — is identical for both. The
// factory function below just swaps the SMTP credentials underneath.
//
// ─── WHY NOT THE @getbrevo/brevo REST SDK? ───────────────────────────────────
//
// Brevo publishes an official JS SDK that wraps their REST API. For sending a
// simple OTP email, the SMTP relay via Nodemailer is the better choice because:
//   1. Zero new dependencies — Nodemailer is already installed.
//   2. Identical code path — switching providers is a config change, not a
//      code change. The SDK's API differs significantly from Nodemailer's.
//   3. Brevo's own docs recommend Nodemailer for Node.js SMTP relay:
//      https://developers.brevo.com/docs/smtp-integration
//
// ─── BREVO CONNECTION SETTINGS ───────────────────────────────────────────────
//
// Per Brevo's official SMTP relay documentation:
//   Host:       smtp-relay.brevo.com   (hardcoded — never from env vars)
//   Port:       587                     (non-encrypted; STARTTLS upgrades it)
//   secure:     false                   (true is only for port 465 / raw SSL)
//   Login:      your BREVO_SMTP_LOGIN   (e.g. xxxxx@smtp-brevo.com)
//   Password:   your BREVO_SMTP_KEY     (starts with "xsmtpsib-...", NOT the API key)
//
// The host and port are intentionally NOT read from env vars. Brevo has exactly
// one SMTP relay endpoint and one recommended port. Making them configurable
// would only create opportunities for them to be set incorrectly in production.
//
// ─── BREVO SMTP KEY vs API KEY ────────────────────────────────────────────────
//
// Brevo has two different credential types that look similar but serve different
// purposes:
//   SMTP key — starts with "xsmtpsib-..." — used as the SMTP password here.
//   API key  — starts with "xkeysib-..."  — used by the REST SDK / HTTP API.
//
// The cross-field guard in env.js detects the API key being used where the SMTP
// key is expected and exits with a clear error message at startup.
//
// ─── BREVO FROM ADDRESS ──────────────────────────────────────────────────────
//
// BREVO_SMTP_FROM must be an email address that is verified as a sender in your
// Brevo account (Senders & Domains section). Using an unverified address causes
// Brevo to reject the message with a 550 error. This address is what recipients
// see as the "From" field — it can differ from BREVO_SMTP_LOGIN.

import nodemailer from "nodemailer";
import { config } from "../config/env.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";

const activeEmailProvider = config.EMAIL_PROVIDER === "brevo" ? "brevo" : "ethereal";

// ─── Mask email for safe logging ─────────────────────────────────────────────
//
// "priya@iitb.ac.in" → "p****@iitb.ac.in"
//
// Keeps the first character and the full domain so log correlation remains
// possible (you can identify the user) without exposing the full address in
// log aggregators or audit trails. This is especially important because OTP
// send events are high-frequency and will appear in every logging pipeline.
const maskEmail = (email) => {
	const [local, domain] = email.split("@");
	if (!domain) return "****";
	const prefix = local?.length > 0 ? local[0] : "*";
	return `${prefix}****@${domain}`;
};

// ─── Transport factory ────────────────────────────────────────────────────────
//
// Creates and returns a Nodemailer transporter based on EMAIL_PROVIDER. Called
// once at module load time (see the `transport` singleton below) so the TCP
// connection setup cost is paid at startup, not on the first send call.
// Nodemailer reuses the underlying SMTP connection for subsequent calls when
// the server keeps it alive, which both Brevo and Ethereal do.
const createEmailTransport = () => {
	if (config.EMAIL_PROVIDER === "brevo") {
		logger.info(
			{
				provider: "brevo",
				host: "smtp-relay.brevo.com",
				port: 587,
				login: maskEmail(config.BREVO_SMTP_LOGIN),
				from: maskEmail(config.BREVO_SMTP_FROM),
			},
			"Email transport: Brevo SMTP relay initialised",
		);

		return nodemailer.createTransport({
			// Brevo's documented SMTP relay host — hardcoded intentionally.
			// See: https://developers.brevo.com/docs/smtp-integration
			host: "smtp-relay.brevo.com",
			// Port 587 uses STARTTLS: the connection starts unencrypted and
			// Nodemailer upgrades it automatically. secure must be false here.
			// (Port 465 with secure: true is the alternative SSL-from-the-start path.)
			port: 587,
			secure: false,
			auth: {
				// BREVO_SMTP_LOGIN: your Brevo SMTP login (e.g. xxxxx@smtp-brevo.com)
				user: config.BREVO_SMTP_LOGIN,
				// BREVO_SMTP_KEY: your Brevo SMTP key (xsmtpsib-...), NOT the API key
				pass: config.BREVO_SMTP_KEY,
			},
		});
	}

	// Default: Ethereal fake SMTP for local development.
	// config.SMTP_HOST / SMTP_USER / SMTP_PASS come from .env.local.
	// secure is derived from port: port 465 → true (raw SSL), all others → false.
	logger.info(
		{
			provider: "ethereal",
			host: config.SMTP_HOST,
			port: config.SMTP_PORT,
		},
		"Email transport: Ethereal fake SMTP initialised (no real emails will be sent)",
	);

	return nodemailer.createTransport({
		host: config.SMTP_HOST,
		port: config.SMTP_PORT,
		// Ethereal uses port 587 with STARTTLS, so secure is false.
		// Only set true if you explicitly use port 465 for raw SSL.
		secure: config.SMTP_PORT === 465,
		auth: {
			user: config.SMTP_USER,
			pass: config.SMTP_PASS,
		},
	});
};

// ─── Singleton transport ──────────────────────────────────────────────────────
//
// Created once when this module is first imported. Re-creating it per call
// would open a new TCP connection on every OTP send, which is wasteful and slow.
const transport = createEmailTransport();

logger.info({ provider: activeEmailProvider }, `Email provider selected at startup: ${activeEmailProvider}`);

// ─── Sender address resolver ──────────────────────────────────────────────────
//
// Returns the correct "From" address for the active provider. The Nodemailer
// `from` field accepts RFC 5322 format: "Display Name <address@example.com>".
// Using a display name makes the email look professional in the recipient's inbox
// ("Roomies" instead of a raw SMTP address).
const getSenderAddress = () => {
	if (config.EMAIL_PROVIDER === "brevo") {
		// BREVO_SMTP_FROM must be verified in your Brevo account's Senders section.
		// Brevo rejects messages from unverified sender addresses with a 550 error.
		return `"Roomies" <${config.BREVO_SMTP_FROM}>`;
	}
	// Ethereal: SMTP_FROM is any address — Ethereal intercepts everything.
	return `"Roomies" <${config.SMTP_FROM}>`;
};

// ─── Send OTP email ───────────────────────────────────────────────────────────
//
// Sends a 6-digit OTP to the given email address. The email is formatted as a
// professional transactional message with both plain-text and HTML versions.
// Nodemailer uses the HTML version for capable clients and falls back to plain
// text for clients that cannot render HTML.
export const sendOtpEmail = async (to, otp) => {
	// Input validation — the auth service validates before calling this, but
	// guard here so this function is safe to call from any future context.
	if (!to || typeof to !== "string" || !to.includes("@")) {
		throw new AppError("Invalid recipient email address", 400);
	}
	if (!otp || typeof otp !== "string") {
		throw new AppError("OTP is required", 400);
	}
	if (!/^[0-9]{6}$/.test(otp)) {
		throw new AppError("Invalid OTP format — expected exactly 6 digits", 400);
	}

	const maskedTo = maskEmail(to);
	const fromAddress = getSenderAddress();

	logger.info({ to: maskedTo, provider: activeEmailProvider }, "Preparing OTP email with configured provider");
	if (config.EMAIL_PROVIDER === "brevo-api") {
		return sendViaBrevoAPI(
			to,
			"Your Roomies verification code",
			`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head><body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:40px 16px;"><tr><td align="center"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.08);overflow:hidden;"><tr><td style="background-color:#18181b;padding:28px 40px 24px;"><p style="margin:0;font-size:22px;font-weight:700;color:#ffffff;">Roomies</p><p style="margin:6px 0 0;font-size:13px;color:#a1a1aa;">Find your perfect PG or roommate</p></td></tr><tr><td style="padding:36px 40px 32px;"><p style="margin:0 0 8px;font-size:16px;font-weight:600;color:#18181b;">Verify your email address</p><p style="margin:0 0 28px;font-size:14px;line-height:1.6;color:#52525b;">Use the code below to complete your verification. It expires in <strong>10 minutes</strong>.</p><table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="background-color:#f4f4f5;border-radius:10px;padding:28px 16px;"><p style="margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#71717a;">Your verification code</p><p style="margin:0;font-size:40px;font-weight:700;letter-spacing:12px;color:#18181b;font-family:'Courier New',monospace;">${otp}</p></td></tr></table><p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#71717a;">Never share this code with anyone — Roomies will never ask for it.</p></td></tr><tr><td style="background-color:#fafafa;border-top:1px solid #f0f0f0;padding:20px 40px;"><p style="margin:0;font-size:12px;color:#a1a1aa;">This is an automated message from Roomies. Please do not reply.</p></td></tr></table></td></tr></table></body></html>`,
			`Your Roomies verification code is: ${otp}\n\nThis code expires in 10 minutes. Do not share it with anyone.\n\nIf you did not request this code, you can safely ignore this email.`,
		);
	}
	try {
		const info = await transport.sendMail({
			from: fromAddress,
			to,
			subject: "Your Roomies verification code",
			// Plain-text version: used by email clients that cannot render HTML and
			// by screen readers. Always include this — it also improves spam scoring.
			text: `Your Roomies verification code is: ${otp}\n\nThis code expires in 10 minutes. Do not share it with anyone.\n\nIf you did not request this code, you can safely ignore this email.`,
			// HTML version: rendered by virtually all modern email clients.
			// Uses inline styles for maximum compatibility — many email clients
			// (including Gmail) strip <style> tags but preserve inline styles.
			html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your Roomies verification code</title>
</head>
<body style="margin:0; padding:0; background-color:#f4f4f5; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#f4f4f5; padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:480px; background-color:#ffffff; border-radius:12px; box-shadow:0 2px 8px rgba(0,0,0,0.08); overflow:hidden;">

          <!-- Header -->
          <tr>
            <td style="background-color:#18181b; padding:28px 40px 24px;">
              <p style="margin:0; font-size:22px; font-weight:700; color:#ffffff; letter-spacing:-0.3px;">Roomies</p>
              <p style="margin:6px 0 0; font-size:13px; color:#a1a1aa;">Find your perfect PG or roommate</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 40px 32px;">
              <p style="margin:0 0 8px; font-size:16px; font-weight:600; color:#18181b;">Verify your email address</p>
              <p style="margin:0 0 28px; font-size:14px; line-height:1.6; color:#52525b;">
                Use the code below to complete your verification. It expires in <strong>10 minutes</strong>.
              </p>

              <!-- OTP box -->
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td align="center" style="background-color:#f4f4f5; border-radius:10px; padding:28px 16px;">
                    <p style="margin:0 0 6px; font-size:11px; font-weight:600; letter-spacing:1.5px; text-transform:uppercase; color:#71717a;">Your verification code</p>
                    <p style="margin:0; font-size:40px; font-weight:700; letter-spacing:12px; color:#18181b; font-family:'Courier New', Courier, monospace;">${otp}</p>
                  </td>
                </tr>
              </table>

              <p style="margin:24px 0 0; font-size:13px; line-height:1.6; color:#71717a;">
                Never share this code with anyone — Roomies will never ask for it.
                If you did not request this code, you can safely ignore this email.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#fafafa; border-top:1px solid #f0f0f0; padding:20px 40px;">
              <p style="margin:0; font-size:12px; color:#a1a1aa; line-height:1.5;">
                This is an automated message from Roomies. Please do not reply to this email.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
			`,
		});

		// Ethereal Mail returns a preview URL that lets you read the email in a
		// browser without a real inbox. nodemailer.getTestMessageUrl() returns
		// null for real SMTP providers like Brevo, so this log line is silently
		// skipped in production.
		const previewUrl = nodemailer.getTestMessageUrl(info);
		if (previewUrl) {
			logger.info(
				{ to: maskedTo, previewUrl, provider: "ethereal" },
				"OTP email sent — open preview URL to read the code",
			);
		} else {
			// Real delivery (Brevo). Log the message ID, which appears in Brevo's
			// transactional email logs and is useful for debugging delivery issues.
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
				// err.code gives you a machine-readable signal (e.g. "ECONNREFUSED",
				// "EAUTH") without exposing the full SMTP session details.
				errCode: err.code,
				errMessage: err.message,
			},
			"Failed to send OTP email",
		);

		throw new AppError("Failed to send OTP email — try again shortly", 502);
	}
};

// These are PLANNED email types — the email worker has handlers registered
// for them, but the admin verification service does not yet enqueue jobs of
// these types. They are defined now so the worker does not crash if a job
// arrives, and so the service layer can wire them up cleanly in phase 5 admin.

// ─── Verification approved email ─────────────────────────────────────────────
//
// Sent to a PG owner when an admin approves their verification request.
// The owner can now create properties and listings.
export const sendVerificationApprovedEmail = async (to, ownerName, businessName) => {
	if (!to || typeof to !== "string" || !to.includes("@")) {
		throw new AppError("Invalid recipient email address", 400);
	}
	if (!ownerName || typeof ownerName !== "string") {
		throw new AppError("ownerName is required for verification approved email", 400);
	}

	const maskedTo = maskEmail(to);
	const fromAddress = getSenderAddress();
	const displayName = businessName ? `${ownerName} (${businessName})` : ownerName;

	logger.info({ to: maskedTo, provider: activeEmailProvider }, "Preparing verification approved email");

	if (config.EMAIL_PROVIDER === "brevo-api") {
		return sendViaBrevoAPI(
			to,
			"Your Roomies PG owner account has been verified",
			`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;background:#f4f4f5;"><div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:40px;"><h1 style="color:#18181b;font-size:22px;">Roomies</h1><p style="font-size:22px;">✅</p><h2 style="color:#18181b;">Account verified!</h2><p style="color:#52525b;">Hi ${ownerName}, your PG owner account for <strong>${businessName ?? "your business"}</strong> has been reviewed and approved.</p><p style="color:#52525b;">You can now create properties and post listings.</p><a href="https://roomies.sumitly.app/dashboard" style="display:inline-block;background:#18181b;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">Go to Dashboard</a></div></body></html>`,
			`Hi ${ownerName},\n\nGreat news! Your PG owner account for ${businessName ?? "your business"} has been verified.\n\nYou can now create properties and post listings.\n\n— The Roomies Team`,
		);
	}

	try {
		const info = await transport.sendMail({
			from: fromAddress,
			to,
			subject: "Your Roomies PG owner account has been verified",
			text:
				`Hi ${ownerName},\n\n` +
				`Great news! Your PG owner account on Roomies has been verified.\n\n` +
				`You can now create properties and post listings for students to discover.\n\n` +
				`Log in to get started: https://roomies.in/dashboard\n\n` +
				`If you have any questions, please contact our support team.\n\n` +
				`— The Roomies Team`,
			html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Account Verified — Roomies</title>
</head>
<body style="margin:0; padding:0; background-color:#f4f4f5; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#f4f4f5; padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:480px; background-color:#ffffff; border-radius:12px; box-shadow:0 2px 8px rgba(0,0,0,0.08); overflow:hidden;">
 
          <!-- Header -->
          <tr>
            <td style="background-color:#18181b; padding:28px 40px 24px;">
              <p style="margin:0; font-size:22px; font-weight:700; color:#ffffff; letter-spacing:-0.3px;">Roomies</p>
              <p style="margin:6px 0 0; font-size:13px; color:#a1a1aa;">Find your perfect PG or roommate</p>
            </td>
          </tr>
 
          <!-- Body -->
          <tr>
            <td style="padding:36px 40px 32px;">
              <p style="margin:0 0 8px; font-size:22px;">✅</p>
              <p style="margin:0 0 8px; font-size:16px; font-weight:600; color:#18181b;">Account verified!</p>
              <p style="margin:0 0 20px; font-size:14px; line-height:1.6; color:#52525b;">
                Hi ${ownerName}, your PG owner account for <strong>${businessName ?? "your business"}</strong>
                has been reviewed and approved by our team.
              </p>
              <p style="margin:0 0 28px; font-size:14px; line-height:1.6; color:#52525b;">
                You can now create properties and post listings for students across India to discover.
              </p>
 
              <!-- CTA -->
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td align="center">
                    <a href="https://roomies.in/dashboard"
                       style="display:inline-block; background-color:#18181b; color:#ffffff; text-decoration:none;
                              padding:12px 28px; border-radius:8px; font-size:14px; font-weight:600;">
                      Go to Dashboard
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
 
          <!-- Footer -->
          <tr>
            <td style="background-color:#fafafa; border-top:1px solid #f0f0f0; padding:20px 40px;">
              <p style="margin:0; font-size:12px; color:#a1a1aa; line-height:1.5;">
                This is an automated message from Roomies. Please do not reply to this email.
              </p>
            </td>
          </tr>
 
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
      `,
		});

		const previewUrl = nodemailer.getTestMessageUrl(info);
		if (previewUrl) {
			logger.info({ to: maskedTo, previewUrl }, "Verification approved email sent (Ethereal preview)");
		} else {
			logger.info(
				{ to: maskedTo, messageId: info.messageId, provider: config.EMAIL_PROVIDER },
				"Verification approved email sent",
			);
		}

		return info.messageId;
	} catch (err) {
		logger.error(
			{ to: maskedTo, provider: config.EMAIL_PROVIDER, errCode: err.code, errMessage: err.message },
			"Failed to send verification approved email",
		);
		throw new AppError("Failed to send verification approved email — try again shortly", 502);
	}
};

// ─── Verification rejected email ──────────────────────────────────────────────
//
// Sent to a PG owner when an admin rejects their verification request.
// Includes the rejection reason so the owner knows what to fix before resubmitting.
export const sendVerificationRejectedEmail = async (to, ownerName, rejectionReason) => {
	if (!to || typeof to !== "string" || !to.includes("@")) {
		throw new AppError("Invalid recipient email address", 400);
	}
	if (!ownerName || typeof ownerName !== "string") {
		throw new AppError("ownerName is required for verification rejected email", 400);
	}

	const maskedTo = maskEmail(to);
	const fromAddress = getSenderAddress();
	const reasonText = rejectionReason?.trim() || "Please review your submitted documents and try again.";

	logger.info({ to: maskedTo, provider: activeEmailProvider }, "Preparing verification rejected email");

	if (config.EMAIL_PROVIDER === "brevo-api") {
		return sendViaBrevoAPI(
			to,
			"Update on your Roomies verification request",
			`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;background:#f4f4f5;"><div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:40px;"><h1 style="color:#18181b;font-size:22px;">Roomies</h1><h2 style="color:#18181b;">Verification update</h2><p style="color:#52525b;">Hi ${ownerName}, we were unable to approve your verification request.</p><div style="background:#fef2f2;border-left:3px solid #ef4444;padding:16px;border-radius:4px;margin:20px 0;"><p style="margin:0 0 4px;font-size:11px;font-weight:600;color:#dc2626;text-transform:uppercase;">Reason</p><p style="margin:0;color:#18181b;">${reasonText}</p></div><p style="color:#52525b;">You can submit a new verification request with updated documents from your account settings.</p><a href="https://roomies.sumitly.app/settings/verification" style="display:inline-block;background:#18181b;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">Resubmit Documents</a></div></body></html>`,
			`Hi ${ownerName},\n\nWe were unable to approve your verification request.\n\nReason: ${reasonText}\n\nYou can resubmit with updated documents.\n\n— The Roomies Team`,
		);
	}

	try {
		const info = await transport.sendMail({
			from: fromAddress,
			to,
			subject: "Update on your Roomies verification request",
			text:
				`Hi ${ownerName},\n\n` +
				`We've reviewed your PG owner verification request and unfortunately we were unable to approve it at this time.\n\n` +
				`Reason: ${reasonText}\n\n` +
				`You can submit a new verification request with updated documents from your account settings.\n\n` +
				`If you have questions, please contact our support team.\n\n` +
				`— The Roomies Team`,
			html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Verification Update — Roomies</title>
</head>
<body style="margin:0; padding:0; background-color:#f4f4f5; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#f4f4f5; padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:480px; background-color:#ffffff; border-radius:12px; box-shadow:0 2px 8px rgba(0,0,0,0.08); overflow:hidden;">
 
          <!-- Header -->
          <tr>
            <td style="background-color:#18181b; padding:28px 40px 24px;">
              <p style="margin:0; font-size:22px; font-weight:700; color:#ffffff; letter-spacing:-0.3px;">Roomies</p>
              <p style="margin:6px 0 0; font-size:13px; color:#a1a1aa;">Find your perfect PG or roommate</p>
            </td>
          </tr>
 
          <!-- Body -->
          <tr>
            <td style="padding:36px 40px 32px;">
              <p style="margin:0 0 8px; font-size:16px; font-weight:600; color:#18181b;">Verification update</p>
              <p style="margin:0 0 20px; font-size:14px; line-height:1.6; color:#52525b;">
                Hi ${ownerName}, we've reviewed your verification request but were unable to approve it
                with the documents currently on file.
              </p>
 
              <!-- Reason box -->
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:24px;">
                <tr>
                  <td style="background-color:#fef2f2; border-left:3px solid #ef4444; border-radius:4px; padding:16px 20px;">
                    <p style="margin:0 0 4px; font-size:11px; font-weight:600; letter-spacing:1px; text-transform:uppercase; color:#dc2626;">Reason</p>
                    <p style="margin:0; font-size:14px; color:#18181b; line-height:1.5;">${reasonText}</p>
                  </td>
                </tr>
              </table>
 
              <p style="margin:0 0 28px; font-size:14px; line-height:1.6; color:#52525b;">
                You can submit a new verification request with updated documents from your account settings.
                If you believe this decision was made in error, please contact our support team.
              </p>
 
              <!-- CTA -->
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td align="center">
                    <a href="https://roomies.in/settings/verification"
                       style="display:inline-block; background-color:#18181b; color:#ffffff; text-decoration:none;
                              padding:12px 28px; border-radius:8px; font-size:14px; font-weight:600;">
                      Resubmit Documents
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
 
          <!-- Footer -->
          <tr>
            <td style="background-color:#fafafa; border-top:1px solid #f0f0f0; padding:20px 40px;">
              <p style="margin:0; font-size:12px; color:#a1a1aa; line-height:1.5;">
                This is an automated message from Roomies. Please do not reply to this email.
              </p>
            </td>
          </tr>
 
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
      `,
		});

		const previewUrl = nodemailer.getTestMessageUrl(info);
		if (previewUrl) {
			logger.info({ to: maskedTo, previewUrl }, "Verification rejected email sent (Ethereal preview)");
		} else {
			logger.info(
				{ to: maskedTo, messageId: info.messageId, provider: config.EMAIL_PROVIDER },
				"Verification rejected email sent",
			);
		}

		return info.messageId;
	} catch (err) {
		logger.error(
			{ to: maskedTo, provider: config.EMAIL_PROVIDER, errCode: err.code, errMessage: err.message },
			"Failed to send verification rejected email",
		);
		throw new AppError("Failed to send verification rejected email — try again shortly", 502);
	}
};

// ─── Verification pending / received email ────────────────────────────────────
//
// Sent to a PG owner immediately after they submit a verification document and
// the status transitions to 'pending'. The purpose is a simple acknowledgement:
// "We got your documents, an admin will review them shortly." This prevents
// the owner from thinking their submission was lost and spamming resubmissions.
export const sendVerificationPendingEmail = async (to, ownerName, businessName) => {
	if (!to || typeof to !== "string" || !to.includes("@")) {
		throw new AppError("Invalid recipient email address", 400);
	}
	if (!ownerName || typeof ownerName !== "string") {
		throw new AppError("ownerName is required for verification pending email", 400);
	}

	const maskedTo = maskEmail(to);
	const fromAddress = getSenderAddress();
	const displayBusiness = businessName ?? "your business";

	logger.info({ to: maskedTo, provider: activeEmailProvider }, "Preparing verification pending email");

	if (config.EMAIL_PROVIDER === "brevo-api") {
		return sendViaBrevoAPI(
			to,
			"We received your Roomies verification documents",
			`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;background:#f4f4f5;"><div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:40px;"><h1 style="color:#18181b;font-size:22px;">Roomies</h1><p style="font-size:22px;">📋</p><h2 style="color:#18181b;">Documents received</h2><p style="color:#52525b;">Hi ${ownerName}, we've received your verification documents for <strong>${displayBusiness}</strong>.</p><div style="background:#fefce8;border-left:3px solid #eab308;padding:16px;border-radius:4px;margin:20px 0;"><p style="margin:0 0 4px;font-size:11px;font-weight:600;color:#a16207;text-transform:uppercase;">Status</p><p style="margin:0;font-weight:600;color:#18181b;">Under review</p><p style="margin:4px 0 0;font-size:13px;color:#71717a;">Our team will review your submission within 2–3 business days.</p></div></div></body></html>`,
			`Hi ${ownerName},\n\nWe've received your verification documents for ${displayBusiness}.\n\nOur team will review within 2–3 business days.\n\n— The Roomies Team`,
		);
	}

	try {
		const info = await transport.sendMail({
			from: fromAddress,
			to,
			subject: "We received your Roomies verification documents",
			text:
				`Hi ${ownerName},\n\n` +
				`Thank you for submitting verification documents for ${displayBusiness} on Roomies.\n\n` +
				`Our team has received your submission and will review it within 2–3 business days. ` +
				`We will email you as soon as a decision has been made.\n\n` +
				`If you have any questions in the meantime, please contact our support team.\n\n` +
				`— The Roomies Team`,
			html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Documents Received — Roomies</title>
</head>
<body style="margin:0; padding:0; background-color:#f4f4f5; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#f4f4f5; padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:480px; background-color:#ffffff; border-radius:12px; box-shadow:0 2px 8px rgba(0,0,0,0.08); overflow:hidden;">
 
          <!-- Header -->
          <tr>
            <td style="background-color:#18181b; padding:28px 40px 24px;">
              <p style="margin:0; font-size:22px; font-weight:700; color:#ffffff; letter-spacing:-0.3px;">Roomies</p>
              <p style="margin:6px 0 0; font-size:13px; color:#a1a1aa;">Find your perfect PG or roommate</p>
            </td>
          </tr>
 
          <!-- Body -->
          <tr>
            <td style="padding:36px 40px 32px;">
              <p style="margin:0 0 8px; font-size:22px;">📋</p>
              <p style="margin:0 0 8px; font-size:16px; font-weight:600; color:#18181b;">Documents received</p>
              <p style="margin:0 0 20px; font-size:14px; line-height:1.6; color:#52525b;">
                Hi ${ownerName}, we've received the verification documents for
                <strong>${displayBusiness}</strong>.
              </p>
 
              <!-- Status box -->
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:24px;">
                <tr>
                  <td style="background-color:#fefce8; border-left:3px solid #eab308; border-radius:4px; padding:16px 20px;">
                    <p style="margin:0 0 4px; font-size:11px; font-weight:600; letter-spacing:1px; text-transform:uppercase; color:#a16207;">Status</p>
                    <p style="margin:0; font-size:14px; color:#18181b; font-weight:600;">Under review</p>
                    <p style="margin:4px 0 0; font-size:13px; color:#71717a; line-height:1.5;">
                      Our team will review your submission within 2–3 business days.
                    </p>
                  </td>
                </tr>
              </table>
 
              <p style="margin:0 0 8px; font-size:14px; line-height:1.6; color:#52525b;">
                You will receive another email as soon as a decision has been made.
                No further action is required from you at this time.
              </p>
            </td>
          </tr>
 
          <!-- Footer -->
          <tr>
            <td style="background-color:#fafafa; border-top:1px solid #f0f0f0; padding:20px 40px;">
              <p style="margin:0; font-size:12px; color:#a1a1aa; line-height:1.5;">
                This is an automated message from Roomies. Please do not reply to this email.
              </p>
            </td>
          </tr>
 
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
            `,
		});

		const previewUrl = nodemailer.getTestMessageUrl(info);
		if (previewUrl) {
			logger.info({ to: maskedTo, previewUrl }, "Verification pending email sent (Ethereal preview)");
		} else {
			logger.info(
				{ to: maskedTo, messageId: info.messageId, provider: config.EMAIL_PROVIDER },
				"Verification pending email sent",
			);
		}

		return info.messageId;
	} catch (err) {
		logger.error(
			{ to: maskedTo, provider: config.EMAIL_PROVIDER, errCode: err.code, errMessage: err.message },
			"Failed to send verification pending email",
		);
		throw new AppError("Failed to send verification pending email — try again shortly", 502);
	}
};

// Brevo REST API transport — used when EMAIL_PROVIDER=brevo-api.
// Uses HTTPS (port 443), which is never blocked, unlike SMTP ports.
// Brevo API docs: https://developers.brevo.com/reference/send-transac-email
const sendViaBrevoAPI = async (to, subject, html, text) => {
	const maskedTo = maskEmail(to);
	logger.info({ to: maskedTo, provider: "brevo-api" }, "Sending email via Brevo REST API");

	const response = await fetch("https://api.brevo.com/v3/smtp/email", {
		method: "POST",
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

	if (!response.ok) {
		const errorBody = await response.json().catch(() => ({}));
		logger.error({ to: maskedTo, status: response.status, error: errorBody }, "Brevo API: email send failed");
		throw new AppError("Failed to send email via Brevo API — try again shortly", 502);
	}

	const result = await response.json();
	logger.info({ to: maskedTo, messageId: result.messageId }, "Brevo API: email sent successfully");
	return result.messageId;
};
