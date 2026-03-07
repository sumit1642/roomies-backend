// src/validators/rating.validators.js
//
// Four schemas covering the four rating endpoints.
//
// The pagination schema is extracted into a shared helper and composed into
// each read endpoint schema — adding a new pagination field in one place
// propagates to all three read endpoints automatically.

import { z } from "zod";

// ─── Shared pagination sub-schema ─────────────────────────────────────────────
//
// Keyset cursor on (created_at DESC, rating_id ASC). Both fields must come
// together or not at all — a partial cursor is ambiguous and rejected here
// before the service ever sees it.
const paginationQuerySchema = z
	.object({
		cursorTime: z.string().optional(),
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
//
// POST /api/v1/ratings
//
// The caller is the reviewer (from JWT). The body names the connection that
// proves the interaction happened and the reviewee being rated.
//
// revieweeType + revieweeId together form the polymorphic reference:
//   revieweeType = 'user'     → revieweeId is a user UUID
//   revieweeType = 'property' → revieweeId is a property UUID
//
// The service validates that revieweeId actually exists in the correct table —
// this cannot be enforced by Zod since it requires a DB lookup.
//
// Dimension scores are optional — not every dimension applies to every
// connection_type. The DB schema makes them nullable for the same reason.
// overall_score is always required; it is what gets cached in average_rating.
//
// comment maps to the review_text column in the DB.
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

		// Dimension scores — all optional
		cleanlinessScore: z.coerce
			.number()
			.int()
			.min(1, { error: "cleanlinessScore must be between 1 and 5" })
			.max(5)
			.optional(),

		communicationScore: z.coerce
			.number()
			.int()
			.min(1, { error: "communicationScore must be between 1 and 5" })
			.max(5)
			.optional(),

		reliabilityScore: z.coerce
			.number()
			.int()
			.min(1, { error: "reliabilityScore must be between 1 and 5" })
			.max(5)
			.optional(),

		valueScore: z.coerce.number().int().min(1, { error: "valueScore must be between 1 and 5" }).max(5).optional(),

		// Maps to review_text in the DB. Optional, max 2000 characters.
		comment: z.string().max(2000).optional(),
	}),
});

// ─── Get ratings for a connection ─────────────────────────────────────────────
//
// GET /api/v1/ratings/connection/:connectionId
//
// Returns both ratings for a connection (if submitted). Only the two connection
// parties may call this endpoint — enforced in the service via the connection
// membership check.
export const getRatingsForConnectionSchema = z.object({
	params: z.object({
		connectionId: z.uuid({ error: "Invalid connection ID" }),
	}),
});

// ─── Get public ratings for a user ────────────────────────────────────────────
//
// GET /api/v1/ratings/user/:userId
//
// Publicly readable — no authentication required. Returns the paginated rating
// history for any user (reviewee_type = 'user', is_visible = TRUE only).
export const getPublicRatingsSchema = z.object({
	params: z.object({
		userId: z.uuid({ error: "Invalid user ID" }),
	}),
	query: paginationQuerySchema,
});

// ─── Get my given ratings ──────────────────────────────────────────────────────
//
// GET /api/v1/ratings/me/given
//
// Returns all ratings the authenticated user has submitted as a reviewer.
// Useful for a student reviewing their own rating history.
export const getMyGivenRatingsSchema = z.object({
	query: paginationQuerySchema,
});

// ─── Get public ratings for a property ────────────────────────────────────────
//
// GET /api/v1/ratings/property/:propertyId
//
// Publicly readable — no authentication required. Returns paginated visible
// ratings for a property (reviewee_type = 'property', is_visible = TRUE only).
// Mirrors getPublicRatingsSchema for users.
export const getPublicPropertyRatingsSchema = z.object({
	params: z.object({
		propertyId: z.uuid({ error: "Invalid property ID" }),
	}),
	query: paginationQuerySchema,
});
