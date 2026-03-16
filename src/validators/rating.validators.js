// src/validators/rating.validators.js
//
// ─── FIX: cursorTime validated as strict ISO 8601 datetime ───────────────────
// Previously accepted any string; now uses z.iso.datetime({ offset: true })
// consistent with every other paginated endpoint.
//
// ─── FIX: shared dimensionScoreSchema ────────────────────────────────────────
// cleanlinessScore, communicationScore, reliabilityScore, and valueScore all
// share the same validation rule (optional integer 1–5). Extracting them into
// a single schema removes the repetition and ensures any future change
// (e.g. extending the scale to 1–10) only needs to happen in one place.

import { z } from "zod";

// ─── Shared sub-schemas ───────────────────────────────────────────────────────

// Reusable optional 1–5 dimension score. Used for all four dimension fields on
// a rating submission. Keeping the error message generic ("Score must be between
// 1 and 5") means we don't encode the field name in the schema — the path in
// the Zod issue already tells the caller which field failed.
const dimensionScoreSchema = z.coerce
	.number()
	.int()
	.min(1, { error: "Score must be between 1 and 5" })
	.max(5, { error: "Score must be between 1 and 5" })
	.optional();

// Keyset pagination used by all four read endpoints.
const paginationQuerySchema = z
	.object({
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

		cleanlinessScore: dimensionScoreSchema,
		communicationScore: dimensionScoreSchema,
		reliabilityScore: dimensionScoreSchema,
		valueScore: dimensionScoreSchema,

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
