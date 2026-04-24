

import { z } from "zod";











const optionalRefreshTokenBody = z
	.object({
		refreshToken: z.string().min(1, { error: "Refresh token must not be empty" }).optional(),
	})
	.optional()
	.default({});




export const registerSchema = z.object({
	body: z.object({
		email: z.email({ error: "Must be a valid email address" }),

		
		password: z
			.string()
			.min(8, { error: "Password must be at least 8 characters" })
			.regex(/(?=.*[a-zA-Z])(?=.*\d)/, {
				error: "Password must contain at least one letter and one number",
			}),

		role: z.enum(["student", "pg_owner"], {
			error: "Role must be student or pg_owner",
		}),

		
		fullName: z.string().min(2, { error: "Full name must be at least 2 characters" }).max(255),

		
		businessName: z.string().min(2).max(255).optional(),
	}),
});


export const loginSchema = z.object({
	body: z.object({
		email: z.email({ error: "Must be a valid email address" }),
		password: z.string().min(1, { error: "Password is required" }),
	}),
});


export const refreshSchema = z.object({
	body: optionalRefreshTokenBody,
});


export const logoutCurrentSchema = z.object({
	body: optionalRefreshTokenBody,
});


export const listSessionsSchema = z.object({
	query: z.object({}).passthrough().optional().default({}),
});






export const revokeSessionSchema = z.object({
	params: z.object({
		sid: z.uuid({ error: "sid must be a valid UUID" }),
	}),
});


export const otpVerifySchema = z.object({
	body: z.object({
		
		otp: z.string().regex(/^\d{6}$/, { error: "OTP must be exactly 6 digits" }),
	}),
});
















export const googleCallbackSchema = z.object({
	body: z.object({
		idToken: z.string().min(1, { error: "Google ID token is required" }),

		
		
		role: z.enum(["student", "pg_owner"], { error: "Role must be student or pg_owner" }).optional(),

		
		fullName: z.string().min(2).max(255).optional(),

		
		businessName: z.string().min(2).max(255).optional(),
	}),
});
