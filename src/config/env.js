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

	// Email (SMTP)
	SMTP_HOST: z.string().min(1, { error: "SMTP_HOST is required" }),
	SMTP_PORT: z.coerce.number().int().positive().default(587),
	SMTP_USER: z.string().min(1, { error: "SMTP_USER is required" }),
	SMTP_PASS: z.string().min(1, { error: "SMTP_PASS is required" }),
	SMTP_FROM: z.email({ error: "SMTP_FROM must be a valid email address" }),

	// Storage
	STORAGE_ADAPTER: z.enum(["local", "azure"]).default("local"),

	// CORS — comma-separated list of allowed origins in production
	// e.g. "https://roomies.in,https://www.roomies.in"
	// Not required in development (origin:true is used instead)
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

// Parse ALLOWED_ORIGINS into an array once at startup so app.js never touches process.env directly
export const config = {
	...parsed.data,
	ALLOWED_ORIGINS: parsed.data.ALLOWED_ORIGINS ? parsed.data.ALLOWED_ORIGINS.split(",").map((o) => o.trim()) : [],
};
