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
// refreshToken is optional in the body because browser clients send no body —
// they carry the refresh token exclusively in the HttpOnly cookie set at login.
// The controller resolves the token via:
//   req.body.refreshToken ?? req.cookies?.refreshToken
// Android clients send the token explicitly in the body. Making it optional
// here lets both client types reach the same endpoint without a validation
// failure. The "at least one source must provide a token" check lives in the
// controller, which can see req.cookies — Zod cannot.
export const refreshSchema = z.object({
	body: z
		.object({
			refreshToken: z.string().min(1, { error: "Refresh token must not be empty" }).optional(),
		})
		.optional()
		.default({}),
});

export const logoutCurrentSchema = z.object({
	body: z
		.object({
			refreshToken: z.string().min(1, { error: "Refresh token must not be empty" }).optional(),
		})
		.optional()
		.default({}),
});

export const listSessionsSchema = z.object({
	query: z.object({}).passthrough().optional().default({}),
});

export const revokeSessionSchema = z.object({
	params: z.object({
		sid: z.string().min(1, { error: "Session id is required" }),
	}),
});

// ─── OTP verify ──────────────────────────────────────────────────────────────
export const otpVerifySchema = z.object({
	body: z.object({
		// Exactly 6 digits — length check alone would accept "ab1234"
		otp: z.string().regex(/^\d{6}$/, { error: "OTP must be exactly 6 digits" }),
	}),
});

// ─── Google OAuth callback ────────────────────────────────────────────────────
// The client (browser via Google One Tap, or Android via GoogleSignIn SDK)
// obtains a Google ID token directly from Google and POSTs it here. This server
// never handles the OAuth redirect or code exchange — it only receives the
// already-issued ID token and verifies its signature using google-auth-library.
//
// idToken is validated as a non-empty string only — structural validation
// (signature, expiry, audience, issuer) is performed by OAuth2Client.verifyIdToken()
// in the service. Doing structural checks in Zod would duplicate google-auth-library
// and create a maintenance burden if Google's token format ever changes.
//
// role, fullName, and businessName are optional here because they are only
// required for new registrations (the service enforces them in that branch).
// Returning users omit all three — attempting to re-specify a role on an existing
// account is silently ignored, not an error.
export const googleCallbackSchema = z.object({
	body: z.object({
		idToken: z.string().min(1, { error: "Google ID token is required" }),

		// Required only for new-user registration via OAuth.
		// For returning users and account-linking, role is ignored.
		role: z.enum(["student", "pg_owner"], { error: "Role must be student or pg_owner" }).optional(),

		// Required for all new registrations; ignored for returning users.
		fullName: z.string().min(2).max(255).optional(),

		// Required for new pg_owner registrations — enforced in the service.
		businessName: z.string().min(2).max(255).optional(),
	}),
});
