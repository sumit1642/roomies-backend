// src/config/env.js
//
// ─── ENVIRONMENT LOADING ─────────────────────────────────────────────────────
//
// ENV_FILE is set by the npm script before Node starts:
//   npm run dev             → ENV_FILE=.env.local  (Ethereal mail + local DB/Redis)
//   npm run dev:azure       → ENV_FILE=.env.azure  (Azure DB/Redis + Brevo mail)
//   npm run dev:brevo       → ENV_FILE=.env.local  (local DB/Redis + Brevo mail)
//   npm run start:prod      → no ENV_FILE          (App Service env vars, no .env file)
//
// If no ENV_FILE is set (bare `node src/server.js` in production), dotenv
// simply finds nothing to load — the process inherits env vars from the shell
// or from Azure App Service Application Settings. That is correct behaviour.

import { z } from "zod";
import dotenv from "dotenv";

const envFile = process.env.ENV_FILE;
if (envFile) {
	dotenv.config({ path: envFile });
} else {
	// Fallback for bare local invocations. Production (App Service) sets env
	// vars natively so dotenv is a no-op there — both calls just produce empty.
	dotenv.config({ path: ".env.local" });
	dotenv.config({ path: ".env" });
}

// ─── SCHEMA ──────────────────────────────────────────────────────────────────

const envSchema = z.object({
	NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
	PORT: z.coerce.number().int().positive().default(3000),

	// ── Database ────────────────────────────────────────────────────────────────
	DATABASE_URL: z.url({ error: "DATABASE_URL must be a valid PostgreSQL connection URL" }),

	// ── Redis ───────────────────────────────────────────────────────────────────
	REDIS_URL: z.url({ error: "REDIS_URL must be a valid Redis connection URL" }),

	// ── JWT ─────────────────────────────────────────────────────────────────────
	JWT_SECRET: z.string().min(32, { error: "JWT_SECRET must be at least 32 characters" }),
	JWT_REFRESH_SECRET: z.string().min(32, { error: "JWT_REFRESH_SECRET must be at least 32 characters" }),
	JWT_EXPIRES_IN: z.string().default("15m"),
	JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),

	// ── Google OAuth ────────────────────────────────────────────────────────────
	GOOGLE_CLIENT_ID: z.string().optional(),
	GOOGLE_CLIENT_SECRET: z.string().optional(),

	// ── Email provider selector ─────────────────────────────────────────────────
	//
	// EMAIL_PROVIDER controls which Nodemailer transport is initialised at startup.
	//
	//   "ethereal" — Ethereal Mail: a fake SMTP server. Every sent email is
	//                intercepted by Ethereal's test account and never delivered to
	//                the real recipient. A preview URL is logged to the console so
	//                you can read the OTP during local development. Requires the
	//                four SMTP_* vars below.
	//
	//   "brevo"    — Brevo SMTP relay: real email delivery via smtp-relay.brevo.com.
	//                The host/port are intentionally hardcoded to Brevo's documented
	//                values (port 587, STARTTLS) so they cannot be accidentally
	//                overridden in an env file. Requires the three BREVO_SMTP_* vars
	//                and BREVO_SMTP_FROM below.
	//
	// Cross-field guards after the schema parse enforce that the right variables
	// are present for the chosen provider, and exit with a clear per-variable
	// error message if anything is missing.
	/**
	 * "brevo-api : For tier0 deployment, render doesn't provides smtp on free tier , so we are using brevo http api key as fallback option."
	 */
	EMAIL_PROVIDER: z
		.enum(["ethereal", "brevo", "brevo-api"], {
			error: 'EMAIL_PROVIDER must be "ethereal", "brevo", or "brevo-api"',
		})
		.default("ethereal"),

	// ── Ethereal SMTP (required when EMAIL_PROVIDER=ethereal) ──────────────────
	//
	// All four values come from your Ethereal test account at https://ethereal.email
	// The host is always smtp.ethereal.email. Port 587 uses STARTTLS (secure: false).
	SMTP_HOST: z.string().min(1).optional(),
	SMTP_PORT: z.coerce.number().int().positive().default(587),
	SMTP_USER: z.string().min(1).optional(),
	SMTP_PASS: z.string().min(1).optional(),
	SMTP_FROM: z.email({ error: "SMTP_FROM must be a valid email address" }).optional(),

	// ── Brevo SMTP (required when EMAIL_PROVIDER=brevo) ────────────────────────
	//
	// BREVO_SMTP_LOGIN — your Brevo SMTP login (e.g. xxxxx@smtp-brevo.com).
	//                    Found in Brevo → Settings → SMTP & API → SMTP tab,
	//                    under the "Login" column.
	//
	// BREVO_SMTP_KEY   — your Brevo SMTP key (starts with "xsmtpsib-...").
	//                    This is NOT the API key (which starts with "xkeysib-...").
	//                    The SMTP key is generated separately in the same SMTP tab.
	//                    It is used as the SMTP password for authentication.
	//
	// BREVO_SMTP_FROM  — the "From" address shown to email recipients. Must be a
	//                    sender address verified in your Brevo account (Senders &
	//                    Domains section). This can differ from BREVO_SMTP_LOGIN.
	//
	// The SMTP server host and port are NOT taken from env vars. They are hardcoded
	// in email.service.js as smtp-relay.brevo.com:587 per Brevo's official docs:
	// https://developers.brevo.com/docs/smtp-integration
	BREVO_SMTP_LOGIN: z.email({ error: "BREVO_SMTP_LOGIN must be a valid email address" }).optional(),
	BREVO_SMTP_KEY: z.string().min(1).optional(),
	BREVO_SMTP_FROM: z.email({ error: "BREVO_SMTP_FROM must be a valid email address" }).optional(),
	BREVO_API_KEY: z.string().min(1).optional(),

	// ── Storage ─────────────────────────────────────────────────────────────────
	//
	// "local"  → LocalDiskAdapter: writes WebP files to /uploads on disk (dev).
	//            Express serves /uploads statically in development.
	// "azure"  → AzureBlobAdapter: writes to Azure Blob Storage (prod).
	STORAGE_ADAPTER: z.enum(["local", "azure"]).default("local"),
	AZURE_STORAGE_CONNECTION_STRING: z.string().optional(),
	AZURE_STORAGE_CONTAINER: z.string().optional(),

	// ── Azure Communication Services (Phase 5 email worker) ─────────────────────
	ACS_CONNECTION_STRING: z.string().optional(),
	ACS_FROM_EMAIL: z.email({ error: "ACS_FROM_EMAIL must be a valid email address" }).optional(),

	// ── CORS ────────────────────────────────────────────────────────────────────
	// Comma-separated list of allowed origins in production.
	// In development, origin: true is used (reflects the incoming Origin header).
	ALLOWED_ORIGINS: z.string().optional(),

	// ── Trust Proxy ─────────────────────────────────────────────────────────────
	// Controls Express's proxy trust setting. Used by req.ip (for OTP rate limiting).
	//   "false" / "0"        → false  (no proxy trust, local dev default)
	//   "1", "2", etc.       → numeric hop count (production behind load balancers)
	// Parsed into a boolean or number in the config export below.
	TRUST_PROXY: z.string().optional().default("false"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
	console.error(`❌  Invalid environment variables in ${envFile ?? ".env.local / .env"} — server cannot start\n`);
	parsed.error.issues.forEach((issue) => {
		console.error(`   ${issue.path.join(".")}: ${issue.message}`);
	});
	console.error("\nCheck your env file against .env.example\n");
	process.exit(1);
}

// ─── CROSS-FIELD GUARD: Ethereal ─────────────────────────────────────────────
//
// When EMAIL_PROVIDER=ethereal all four SMTP_* vars must be present. Missing
// any of them means Nodemailer cannot authenticate to Ethereal and every
// sendMail call will fail immediately at runtime.
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
				`\n\nAdd them to your env file. Generate a free Ethereal account at https://ethereal.email\n`,
		);
		process.exit(1);
	}
}

// ─── CROSS-FIELD GUARD: Brevo ─────────────────────────────────────────────────
//
// When EMAIL_PROVIDER=brevo all three Brevo SMTP vars and the From address must
// be present. Each is checked individually so the error message names the exact
// missing variable.
//
// A common mistake is supplying the API key (xkeysib-...) instead of the SMTP
// key (xsmtpsib-...). The prefix check below catches this and prints a specific
// remediation message so the developer doesn't waste time debugging.
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

	// Guard against the most common Brevo credential mistake: pasting the API
	// key (xkeysib-...) where the SMTP key (xsmtpsib-...) is expected. Both
	// look similar but the SMTP key is a separate credential generated in the
	// SMTP tab of Brevo's settings.
	if (parsed.data.BREVO_SMTP_KEY?.startsWith("xkeysib-")) {
		console.error(
			`❌  BREVO_SMTP_KEY starts with "xkeysib-" which is an API key, not an SMTP key.\n` +
				`   The correct SMTP key starts with "xsmtpsib-".\n` +
				`   Find it in Brevo → Settings → SMTP & API → SMTP tab → "Generate a new SMTP key".\n`,
		);
		process.exit(1);
	}
}

// Add this block after the existing brevo guard:
if (parsed.data.EMAIL_PROVIDER === "brevo-api") {
	const missing = [];
	if (!parsed.data.BREVO_API_KEY) missing.push("BREVO_API_KEY");
	if (!parsed.data.BREVO_SMTP_FROM) missing.push("BREVO_SMTP_FROM");
	if (missing.length > 0) {
		console.error(
			`❌  EMAIL_PROVIDER is "brevo-api" but these required variables are missing:\n` +
				missing.map((v) => `   ${v}`).join("\n") +
				`\n\nBREVO_API_KEY starts with "xkeysib-". Find it in Brevo → Settings → SMTP & API → API Keys.\n`,
		);
		process.exit(1);
	}
	if (parsed.data.BREVO_API_KEY?.startsWith("xsmtpsib-")) {
		console.error(
			`❌  BREVO_API_KEY starts with "xsmtpsib-" which is an SMTP key, not an API key.\n` +
				`   The API key starts with "xkeysib-". Find it in Brevo → Settings → SMTP & API → API Keys.\n`,
		);
		process.exit(1);
	}
}

// ─── CROSS-FIELD GUARD: Azure Blob Storage ───────────────────────────────────
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

// ─── TRUST_PROXY PARSING ──────────────────────────────────────────────────────
//
// Express accepts either a positive integer (hop count) or the boolean false.
// "false" and "0" both map to false. Any positive integer string becomes that
// number. Anything else defaults to false with a warning.
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

// ─── EXPORT ──────────────────────────────────────────────────────────────────
//
// ALLOWED_ORIGINS is split into an array once at startup so every middleware
// that checks origins gets a pre-parsed array, not a comma-separated string.
export const config = {
	...parsed.data,
	ALLOWED_ORIGINS: parsed.data.ALLOWED_ORIGINS ? parsed.data.ALLOWED_ORIGINS.split(",").map((o) => o.trim()) : [],
	TRUST_PROXY: parseTrustProxy(parsed.data.TRUST_PROXY),
};
