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
	// Two separate dotenv.config() calls are intentional here — do not collapse
	// them into one. dotenv.config() never overwrites variables that are already
	// set in process.env, so the call order establishes a clear priority chain:
	//
	//   1. .env.local is loaded first — any variable defined here wins.
	//   2. .env is loaded second — only fills in variables NOT already set by
	//      .env.local, acting as a project-wide fallback (e.g. for CI pipelines
	//      or bare `node src/server.js` invocations without an npm script).
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
	// Switching adapters requires only an env var change — no code changes.
	STORAGE_ADAPTER: z.enum(["local", "azure"]).default("local"),

	// ─── Azure Blob Storage ────────────────────────────────────────────────────
	// Required when STORAGE_ADAPTER=azure. Optional otherwise so that local dev
	// boots cleanly without Azure credentials.
	//
	// AZURE_STORAGE_CONNECTION_STRING:
	//   Full connection string from Azure Portal → Storage Account →
	//   Security + networking → Access keys → key1 → Connection string.
	//   Format: DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...
	//
	// AZURE_STORAGE_CONTAINER:
	//   The blob container name you created inside your storage account.
	//   Example: "roomies-uploads"
	//   Container must exist before deployment — create it in the Azure portal
	//   or with the Azure CLI: az storage container create --name roomies-uploads
	AZURE_STORAGE_CONNECTION_STRING: z.string().optional(),
	AZURE_STORAGE_CONTAINER: z.string().optional(),

	// ─── Azure Communication Services (Phase 5 email worker) ─────────────────
	// Required when the email-queue BullMQ worker switches from Nodemailer/Ethereal
	// to ACS for production email delivery. Optional for all current phases.
	//
	// ACS_CONNECTION_STRING:
	//   From Azure Portal → Communication Services → Keys → Connection string.
	//
	// ACS_FROM_EMAIL:
	//   A verified sender address in your ACS resource.
	//   Must be verified in Azure Portal → Communication Services → Email →
	//   Domains before ACS will send mail from it.
	ACS_CONNECTION_STRING: z.string().optional(),
	ACS_FROM_EMAIL: z.email({ error: "ACS_FROM_EMAIL must be a valid email address" }).optional(),

	// CORS — comma-separated list of allowed origins in production.
	// Example: "https://roomies.in,https://www.roomies.in"
	// Not required in development (origin:true is used instead).
	ALLOWED_ORIGINS: z.string().optional(),
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

// Parse ALLOWED_ORIGINS into an array once at startup so app.js never touches
// process.env directly. An empty array is the safe default — app.js has a
// startup guard that crashes loudly if ALLOWED_ORIGINS is empty in production.
export const config = {
	...parsed.data,
	ALLOWED_ORIGINS: parsed.data.ALLOWED_ORIGINS ? parsed.data.ALLOWED_ORIGINS.split(",").map((o) => o.trim()) : [],
};
