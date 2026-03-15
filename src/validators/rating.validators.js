// src/validators/rating.validators.js
//
// ─── FIX IN THIS VERSION ──────────────────────────────────────────────────────
//
// cursorTime was validated as z.string().optional() which accepted any arbitrary
// string. A malformed timestamp would then reach the service layer and cause
// a PostgreSQL error (or silently produce wrong pagination results) instead of
// a clean 400 from the validator. The fix uses z.iso.datetime({ offset: true })
// which enforces valid ISO 8601 format including timezone offset, consistent
// with every other paginated endpoint in the codebase.

import { z } from "zod";

// ─── Shared pagination sub-schema ─────────────────────────────────────────────
const paginationQuerySchema = z
	.object({
		// Validated as a strict ISO 8601 datetime with timezone offset.
		// Invalid timestamps now produce a 400 at the Zod layer instead of
		// reaching the SQL layer as malformed input.
		cursorTime: z.iso.datetime({ offset: true }).optional(),
		cursorId: z.uuid({ error: "cursorId must be a valid UUID" }).optional(),
		limit: z.coerce.number().int().min(1).max(100).default(20),
	})
	.refine(
		(data) => {
			const hasTime = data.cursorTime !== undefined;
			const hasId = data.cursorId !== undefined;
			return hasTime === hasId;
		},
		{ error: "cursorTime and cursorId must be provided together" },
	);

// ─── Submit rating ─────────────────────────────────────────────────────────────
export const submitRatingSchema = z.object({
	body: z.object({
		connectionId: z.uuid({ error: "connectionId must be a valid UUID" }),

		revieweeType: z.enum(["user", "property"], {
			error: "revieweeType must be either 'user' or 'property'",
		}),

		revieweeId: z.uuid({ error: "revieweeId must be a valid UUID" }),

		overallScore: z.coerce
			.number()
			.int({ error: "overallScore must be an integer" })
			.min(1, { error: "overallScore must be between 1 and 5" })
			.max(5, { error: "overallScore must be between 1 and 5" }),

		cleanlinessScore: z.coerce
			.number()
			.int()
			.min(1, { error: "cleanlinessScore must be between 1 and 5" })
			.max(5, { error: "cleanlinessScore must be between 1 and 5" })
			.optional(),

		communicationScore: z.coerce
			.number()
			.int()
			.min(1, { error: "communicationScore must be between 1 and 5" })
			.max(5, { error: "communicationScore must be between 1 and 5" })
			.optional(),

		reliabilityScore: z.coerce
			.number()
			.int()
			.min(1, { error: "reliabilityScore must be between 1 and 5" })
			.max(5, { error: "reliabilityScore must be between 1 and 5" })
			.optional(),

		valueScore: z.coerce
			.number()
			.int()
			.min(1, { error: "valueScore must be between 1 and 5" })
			.max(5, { error: "valueScore must be between 1 and 5" })
			.optional(),

		comment: z
			.string()
			.trim()
			.min(1, { message: "comment cannot be empty" })
			.max(2000, { message: "comment must not exceed 2000 characters" })
			.optional(),
	}),
});

// ─── Get ratings for a connection ─────────────────────────────────────────────
export const getRatingsForConnectionSchema = z.object({
	params: z.object({
		connectionId: z.uuid({ error: "Invalid connection ID" }),
	}),
});

// ─── Get public ratings for a user ────────────────────────────────────────────
export const getPublicRatingsSchema = z.object({
	params: z.object({
		userId: z.uuid({ error: "Invalid user ID" }),
	}),
	query: paginationQuerySchema,
});

// ─── Get my given ratings ──────────────────────────────────────────────────────
export const getMyGivenRatingsSchema = z.object({
	query: paginationQuerySchema,
});

// ─── Get public ratings for a property ────────────────────────────────────────
export const getPublicPropertyRatingsSchema = z.object({
	params: z.object({
		propertyId: z.uuid({ error: "Invalid property ID" }),
	}),
	query: paginationQuerySchema,
});
