import { z } from "zod";
import dotenv from "dotenv";

// Load .env.local first, fall back to .env
// This means you never accidentally use production values locally
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const envSchema = z.object({
	NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
	PORT: z.coerce.number().int().positive().default(3000),

	// Database
	DATABASE_URL: z.string().url({ message: "DATABASE_URL must be a valid PostgreSQL connection URL" }),

	// Redis
	REDIS_URL: z.string().url({ message: "REDIS_URL must be a valid Redis connection URL" }),

	// JWT
	JWT_SECRET: z.string().min(32, { message: "JWT_SECRET must be at least 32 characters" }),
	JWT_REFRESH_SECRET: z.string().min(32, { message: "JWT_REFRESH_SECRET must be at least 32 characters" }),
	JWT_EXPIRES_IN: z.string().default("15m"),
	JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),

	// Google OAuth — optional until OAuth routes are implemented in phase1/auth
	GOOGLE_CLIENT_ID: z.string().optional(),
	GOOGLE_CLIENT_SECRET: z.string().optional(),

	// Email (SMTP)
	SMTP_HOST: z.string().min(1, { message: "SMTP_HOST is required" }),
	SMTP_PORT: z.coerce.number().int().positive().default(587),
	SMTP_USER: z.string().min(1, { message: "SMTP_USER is required" }),
	SMTP_PASS: z.string().min(1, { message: "SMTP_PASS is required" }),
	SMTP_FROM: z.string().email({ message: "SMTP_FROM must be a valid email address" }),

	// Storage
	STORAGE_ADAPTER: z.enum(["local", "azure"]).default("local"),
});

// Parse and validate — if this throws, the server refuses to start.
// The error message tells you exactly which variable is wrong and why.
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
