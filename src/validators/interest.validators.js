// src/validators/interest.validators.js
//
// Validation schemas for interest request endpoints.
//
// The schemas here are deliberately lean. Most of the interesting validation
// in this phase is *semantic* — "is this transition legal from the current
// state?" — and semantic validation requires database context that Zod doesn't
// have. Zod handles the structural layer (are the right fields present and
// the right types?), and the service handles the semantic layer (is this
// transition allowed for this actor from this state?).

import { z } from "zod";

// ─── Create interest request ──────────────────────────────────────────────────
// POST /api/v1/listings/:listingId/interests
// No body — the entire intent is expressed by the route verb and path.
// The listingId param is the only input that needs validation.
export const createInterestSchema = z.object({
	params: z.object({
		listingId: z.uuid({ error: "Invalid listing ID" }),
	}),
});

// ─── Update interest status ───────────────────────────────────────────────────
// PATCH /api/v1/interests/:interestId/status
//
// The status field accepts any of the four actor-driven terminal values.
// The service validates whether the specific transition is legal — Zod only
// confirms the value is one of the known status strings, not that it's
// reachable from the current state. 'expired' is intentionally excluded:
// that status is only ever set by the system (listing deactivation / expiry),
// never by a user action. If a client sends 'expired', Zod rejects it here
// before the request reaches the service.
export const updateInterestStatusSchema = z.object({
	params: z.object({
		interestId: z.uuid({ error: "Invalid interest request ID" }),
	}),
	body: z.object({
		status: z.enum(["accepted", "declined", "withdrawn"], {
			error: "status must be one of: accepted, declined, withdrawn",
		}),
	}),
});

// ─── Get interest requests for a listing ─────────────────────────────────────
// GET /api/v1/listings/:listingId/interests
// Poster-facing view of all requests on their listing. Supports filtering by
// status so a poster can quickly see only 'pending' items they need to act on.
// Keyset pagination uses (created_at DESC, interest_id ASC) — newest requests
// first, which is the most useful default for a poster managing a busy listing.
export const getListingInterestsSchema = z.object({
	params: z.object({
		listingId: z.uuid({ error: "Invalid listing ID" }),
	}),
	query: z
		.object({
			status: z.enum(["pending", "accepted", "declined", "withdrawn", "expired"]).optional(),
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
		),
});

// ─── Get my interest requests (student dashboard) ─────────────────────────────
// GET /api/v1/interests/me
// The student's view of all interest requests they have sent, across all listings.
// Status filter lets them focus on e.g. only 'accepted' requests (confirmed
// interest from the poster) or only 'pending' requests (waiting for a response).
export const getMyInterestsSchema = z.object({
	query: z
		.object({
			status: z.enum(["pending", "accepted", "declined", "withdrawn", "expired"]).optional(),
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
		),
});

// ─── Interest params (reused by single-resource routes) ───────────────────────
// Used wherever only an interestId param needs validating — e.g. a future
// GET /interests/:interestId for detail view.
export const interestParamsSchema = z.object({
	params: z.object({
		interestId: z.uuid({ error: "Invalid interest request ID" }),
	}),
});
