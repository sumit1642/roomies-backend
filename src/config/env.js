// src/config/env.js

import { z } from "zod";
import dotenv from "dotenv";

// ENV_FILE is set by the npm script before Node starts.
// npm run dev:ethereal       → ENV_FILE=.env.local   (local DB + Ethereal mail)
// npm run dev:brevo          → ENV_FILE=.env.local   (local DB + Brevo SMTP)
// npm run dev:azure_ethereal → ENV_FILE=.env.azure   (Azure DB + Ethereal mail)
// npm run dev:azure_brevo    → ENV_FILE=.env.azure   (Azure DB + Brevo SMTP)
// Kept for backward compat:
// npm run dev                → ENV_FILE=.env.local
// npm run dev:azure          → ENV_FILE=.env.azure
//
// If run directly without an npm script, falls back to .env.local then .env.
const envFile = process.env.ENV_FILE;
if (envFile) {
	dotenv.config({ path: envFile });
} else {
	dotenv.config({ path: ".env.local" });
	dotenv.config({ path: ".env" });
}

const envSchema = z.object({
	NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
	PORT: z.coerce.number().int().positive().default(3000),

	DATABASE_URL: z.url({ error: "DATABASE_URL must be a valid PostgreSQL connection URL" }),
	REDIS_URL: z.url({ error: "REDIS_URL must be a valid Redis connection URL" }),

	// JWT
	JWT_SECRET: z.string().min(32, { error: "JWT_SECRET must be at least 32 characters" }),
	JWT_REFRESH_SECRET: z.string().min(32, { error: "JWT_REFRESH_SECRET must be at least 32 characters" }),
	JWT_EXPIRES_IN: z.string().default("15m"),
	JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),

	// Google OAuth — optional until phase1/auth implements the OAuth callback
	GOOGLE_CLIENT_ID: z.string().optional(),
	GOOGLE_CLIENT_SECRET: z.string().optional(),

	// ─── Email provider selector ──────────────────────────────────────────────
	//
	// EMAIL_PROVIDER controls which Nodemailer transport is created at startup.
	//
	//   "ethereal"  — Ethereal Mail (fake SMTP, dev-only). Every sent email is
	//                 intercepted by Ethereal's test account and never actually
	//                 delivered. A preview URL is logged to the console so you
	//                 can inspect the OTP. Requires the four SMTP_* vars below.
	//
	//   "brevo"     — Brevo SMTP relay (real email delivery). The host and port
	//                 are hardcoded to Brevo's documented values so they cannot
	//                 be accidentally overridden to point at Ethereal in prod.
	//                 Requires BREVO_SMTP_LOGIN, BREVO_SMTP_KEY, BREVO_SMTP_FROM.
	//
	// Cross-field guards after the schema parse enforce that the right variables
	// are present for the chosen provider and exit with a clear error if not.
	EMAIL_PROVIDER: z
		.enum(["ethereal", "brevo"], {
			error: 'EMAIL_PROVIDER must be either "ethereal" or "brevo"',
		})
		.default("ethereal"),

	// ─── Ethereal SMTP vars (required when EMAIL_PROVIDER=ethereal) ───────────
	//
	// Ethereal auto-generates a test account at https://ethereal.email.
	// All four vars come from that test account — host is always smtp.ethereal.email.
	SMTP_HOST: z.string().min(1).optional(),
	SMTP_PORT: z.coerce.number().int().positive().default(587),
	SMTP_USER: z.string().min(1).optional(),
	SMTP_PASS: z.string().min(1).optional(),
	SMTP_FROM: z.email({ error: "SMTP_FROM must be a valid email address" }).optional(),

	// ─── Brevo SMTP vars (required when EMAIL_PROVIDER=brevo) ────────────────
	//
	// BREVO_SMTP_LOGIN  — your Brevo SMTP login address (e.g. xxxxx@smtp-brevo.com).
	//                     Found in Brevo → Settings → SMTP & API → SMTP tab.
	//                     This is the "Login" field shown under SMTP Settings.
	//
	// BREVO_SMTP_KEY    — your Brevo SMTP key (starts with "xsmtpsib-...").
	//                     IMPORTANT: this is NOT the API key (which starts with
	//                     "xkeysib-..."). The SMTP key is a separate credential
	//                     specifically for the smtp-relay.brevo.com connection.
	//
	// BREVO_SMTP_FROM   — the verified sender email address shown to recipients.
	//                     Must match a sender verified/authenticated in your Brevo
	//                     account. Can differ from BREVO_SMTP_LOGIN.
	BREVO_SMTP_LOGIN: z.email({ error: "BREVO_SMTP_LOGIN must be a valid email address" }).optional(),
	BREVO_SMTP_KEY: z.string().min(1).optional(),
	BREVO_SMTP_FROM: z.email({ error: "BREVO_SMTP_FROM must be a valid email address" }).optional(),

	// Storage adapter selector.
	// 'local'  → LocalDiskAdapter  (development — writes to /uploads on disk)
	// 'azure'  → AzureBlobAdapter  (production — writes to Azure Blob Storage)
	STORAGE_ADAPTER: z.enum(["local", "azure"]).default("local"),

	// Azure Blob Storage — required when STORAGE_ADAPTER=azure, optional otherwise.
	AZURE_STORAGE_CONNECTION_STRING: z.string().optional(),
	AZURE_STORAGE_CONTAINER: z.string().optional(),

	// Azure Communication Services (Phase 5 email worker) — optional for current phases.
	ACS_CONNECTION_STRING: z.string().optional(),
	ACS_FROM_EMAIL: z.email({ error: "ACS_FROM_EMAIL must be a valid email address" }).optional(),

	// CORS — comma-separated list of allowed origins in production.
	ALLOWED_ORIGINS: z.string().optional(),

	// TRUST_PROXY controls Express's proxy trust setting.
	// "false" or "0" → false (no proxy trust, local dev default)
	// "1", "2", etc. → numeric hop count (production behind load balancers)
	// This value is parsed into a number or boolean false in the config export below.
	TRUST_PROXY: z.string().optional().default("false"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
	console.error(`❌  Invalid environment variables in ${envFile ?? ".env.local"} — server cannot start\n`);
	parsed.error.issues.forEach((issue) => {
		console.error(`   ${issue.path.join(".")}: ${issue.message}`);
	});
	console.error("\nCheck your env file against .env.example\n");
	process.exit(1);
}

// ─── Cross-field guard: Ethereal provider ─────────────────────────────────────
//
// When EMAIL_PROVIDER=ethereal all four classic SMTP_* vars must be present.
// Missing any of them means Nodemailer cannot authenticate to Ethereal's server
// and every sendMail call will fail immediately at runtime.
if (parsed.data.EMAIL_PROVIDER === "ethereal") {
	const missing = [];
	if (!parsed.data.SMTP_HOST) missing.push("SMTP_HOST");
	if (!parsed.data.SMTP_USER) missing.push("SMTP_USER");
	if (!parsed.data.SMTP_PASS) missing.push("SMTP_PASS");
	if (!parsed.data.SMTP_FROM) missing.push("SMTP_FROM");
	if (missing.length > 0) {
		console.error(
			`❌  EMAIL_PROVIDER is "ethereal" but the following required variables are missing:\n` +
				missing.map((v) => `   ${v}`).join("\n") +
				`\n\nAdd them to your env file. You can generate a free Ethereal test account at https://ethereal.email\n`,
		);
		process.exit(1);
	}
}

// ─── Cross-field guard: Brevo provider ───────────────────────────────────────
//
// When EMAIL_PROVIDER=brevo all three Brevo SMTP vars must be present.
// The guard checks each individually and names them precisely so the developer
// knows exactly which credential is missing — "BREVO_SMTP_KEY missing" is
// far clearer than a generic "email configuration error".
//
// A common mistake is supplying the API key (xkeysib-...) instead of the
// SMTP key (xsmtpsib-...). The prefix check below catches this and prints a
// specific remediation message so the developer doesn't waste time debugging.
if (parsed.data.EMAIL_PROVIDER === "brevo") {
	const missing = [];
	if (!parsed.data.BREVO_SMTP_LOGIN) missing.push("BREVO_SMTP_LOGIN");
	if (!parsed.data.BREVO_SMTP_KEY) missing.push("BREVO_SMTP_KEY");
	if (!parsed.data.BREVO_SMTP_FROM) missing.push("BREVO_SMTP_FROM");

	if (missing.length > 0) {
		console.error(
			`❌  EMAIL_PROVIDER is "brevo" but the following required variables are missing:\n` +
				missing.map((v) => `   ${v}`).join("\n") +
				`\n\nFind them in Brevo → Settings → SMTP & API → SMTP tab.\n` +
				`BREVO_SMTP_KEY must be the SMTP key (starts with "xsmtpsib-"), NOT the API key (starts with "xkeysib-").\n`,
		);
		process.exit(1);
	}

	// Warn if the developer accidentally supplied the API key instead of the SMTP key.
	// This is the single most common Brevo integration mistake — the API key begins
	// with "xkeysib-" while the SMTP key begins with "xsmtpsib-".
	if (parsed.data.BREVO_SMTP_KEY && parsed.data.BREVO_SMTP_KEY.startsWith("xkeysib-")) {
		console.error(
			`❌  BREVO_SMTP_KEY starts with "xkeysib-" which is an API key, not an SMTP key.\n` +
				`   The correct SMTP key starts with "xsmtpsib-".\n` +
				`   Find it in Brevo → Settings → SMTP & API → SMTP tab → "Generate a new SMTP key".\n`,
		);
		process.exit(1);
	}
}

// When STORAGE_ADAPTER is azure, we require the Azure Blob config to be present.
// This is a cross-field constraint that Zod's superRefine handles after parsing.
if (parsed.data.STORAGE_ADAPTER === "azure") {
	const missing = [];
	if (!parsed.data.AZURE_STORAGE_CONNECTION_STRING) missing.push("AZURE_STORAGE_CONNECTION_STRING");
	if (!parsed.data.AZURE_STORAGE_CONTAINER) missing.push("AZURE_STORAGE_CONTAINER");
	if (missing.length > 0) {
		console.error(
			`❌  STORAGE_ADAPTER is "azure" but the following required variables are missing:\n` +
				missing.map((v) => `   ${v}`).join("\n") +
				`\n\nAdd them to your env file or Azure App Service application settings.\n`,
		);
		process.exit(1);
	}
}

// Parse TRUST_PROXY into the type Express expects: a positive integer for
// hop count, or boolean false to disable proxy trust entirely.
// "false" and "0" both map to false. Any other string that parses as a
// positive integer becomes that number. Anything else defaults to false
// with a warning so misconfiguration is never silently swallowed.
const parseTrustProxy = (raw) => {
	const trimmed = (raw ?? "false").trim().toLowerCase();
	if (trimmed === "false" || trimmed === "0") return false;
	const n = Number(trimmed);
	if (Number.isInteger(n) && n > 0) return n;
	console.warn(
		`[config] TRUST_PROXY="${raw}" is not a valid value (expected "false", "0", or a positive integer). ` +
			`Defaulting to false (no proxy trust).`,
	);
	return false;
};

export const config = {
	...parsed.data,
	ALLOWED_ORIGINS: parsed.data.ALLOWED_ORIGINS ? parsed.data.ALLOWED_ORIGINS.split(",").map((o) => o.trim()) : [],
	TRUST_PROXY: parseTrustProxy(parsed.data.TRUST_PROXY),
};
