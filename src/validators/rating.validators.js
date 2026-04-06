// src/validators/rating.validators.js

import { z } from "zod";
import { keysetPaginationQuerySchema } from "./pagination.validators.js";

// Reusable optional 1–5 dimension score for cleanliness, communication,
// reliability, and value fields. Keeping one definition prevents drift
// if the scale ever changes.
const dimensionScoreSchema = z.coerce
	.number()
	.int()
	.min(1, { error: "Score must be between 1 and 5" })
	.max(5, { error: "Score must be between 1 and 5" })
	.optional();

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
			.min(1, { error: "comment cannot be empty" })
			.max(2000, { error: "comment must not exceed 2000 characters" })
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
	query: keysetPaginationQuerySchema,
});

// ─── Get my given ratings ──────────────────────────────────────────────────────
export const getMyGivenRatingsSchema = z.object({
	query: keysetPaginationQuerySchema,
});

// ─── Get public ratings for a property ────────────────────────────────────────
export const getPublicPropertyRatingsSchema = z.object({
	params: z.object({
		propertyId: z.uuid({ error: "Invalid property ID" }),
	}),
	query: keysetPaginationQuerySchema,
});
