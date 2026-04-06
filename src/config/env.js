// src/config/env.js

import { z } from "zod";
import dotenv from "dotenv";

// ENV_FILE is set by the npm script before Node starts.
// npm run dev       → ENV_FILE=.env.local
// npm run dev:azure → ENV_FILE=.env.azure
// If run directly without npm script, falls back to .env.local then .env.
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

	// Email (SMTP) — used by Nodemailer in development (Ethereal Mail)
	SMTP_HOST: z.string().min(1, { error: "SMTP_HOST is required" }),
	SMTP_PORT: z.coerce.number().int().positive().default(587),
	SMTP_USER: z.string().min(1, { error: "SMTP_USER is required" }),
	SMTP_PASS: z.string().min(1, { error: "SMTP_PASS is required" }),
	SMTP_FROM: z.email({ error: "SMTP_FROM must be a valid email address" }),

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
