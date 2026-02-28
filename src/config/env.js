import { z } from "zod";
import dotenv from "dotenv";

// Load .env.local first, fall back to .env.
// This means you never accidentally use production values locally.
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

// Zod v4 note: string format validators moved to top-level functions.
// z.string().email() → z.email()
// z.string().url()   → z.url()
// z.string().uuid()  → z.uuid()
// The old chained methods still work but are deprecated.

const envSchema = z.object({
	NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
	PORT: z.coerce.number().int().positive().default(3000),

	// z.url() in Zod v4 uses the native URL() constructor which accepts
	// postgresql:// and redis:// — they are valid URIs, just not HTTP.
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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
	console.error("❌  Invalid environment variables — server cannot start\n");
	parsed.error.issues.forEach((issue) => {
		console.error(`   ${issue.path.join(".")}: ${issue.message}`);
	});
	console.error("\nCheck your .env.local file against .env.example\n");
	process.exit(1);
}

export const config = parsed.data;
