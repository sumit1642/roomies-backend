// src/email/index.js
//
// Selects the concrete EmailSender based on config.EMAIL_PROVIDER and
// exports a singleton. Every caller depends only on `emailSender.send()` —
// never on nodemailer, fetch, or any provider-specific config directly.
// This mirrors storage/index.js's STORAGE_ADAPTER selection pattern exactly;
// see that file for the template this was copied from.

import { EtherealSender } from "./senders/etherealSender.js";
import { BrevoSmtpSender } from "./senders/brevoSmtpSender.js";
import { BrevoApiSender } from "./senders/brevoApiSender.js";
import { config } from "../config/env.js";

let emailSender;

if (config.EMAIL_PROVIDER === "brevo-api") {
	emailSender = new BrevoApiSender();
} else if (config.EMAIL_PROVIDER === "brevo") {
	emailSender = new BrevoSmtpSender();
} else {
	emailSender = new EtherealSender();
}

export { emailSender };
