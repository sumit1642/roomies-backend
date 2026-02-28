// src/validators/auth.validators.js

import { z } from "zod";

// ─── Register ───────────────────────────────────────────────────────────────
// Cross-field dependency (businessName required for pg_owner) is enforced
// in auth.service.js — Zod handles shape, service handles business rules.
export const registerSchema = z.object({
	body: z.object({
		email: z.email({ error: "Must be a valid email address" }),

		// Min 8 chars, at least one letter and one number
		password: z
			.string()
			.min(8, { error: "Password must be at least 8 characters" })
			.regex(/(?=.*[a-zA-Z])(?=.*\d)/, {
				error: "Password must contain at least one letter and one number",
			}),

		role: z.enum(["student", "pg_owner"], {
			error: "Role must be student or pg_owner",
		}),

		// Written to student_profiles.full_name or pg_owner_profiles.owner_full_name
		fullName: z.string().min(2, { error: "Full name must be at least 2 characters" }).max(255),

		// Required only if role = pg_owner — validated in service
		businessName: z.string().min(2).max(255).optional(),
	}),
});

// ─── Login ──────────────────────────────────────────────────────────────────
export const loginSchema = z.object({
	body: z.object({
		email: z.email({ error: "Must be a valid email address" }),
		password: z.string().min(1, { error: "Password is required" }),
	}),
});

// ─── Refresh token ───────────────────────────────────────────────────────────
export const refreshSchema = z.object({
	body: z.object({
		refreshToken: z.string().min(1, { error: "Refresh token is required" }),
	}),
});

// ─── OTP verify ──────────────────────────────────────────────────────────────
export const otpVerifySchema = z.object({
	body: z.object({
		otp: z.string().length(6, { error: "OTP must be exactly 6 digits" }),
	}),
});
