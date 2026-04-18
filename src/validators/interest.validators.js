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
import { buildKeysetPaginationQuerySchema } from "./pagination.validators.js";

// ─── Create interest request ──────────────────────────────────────────────────
// POST /api/v1/listings/:listingId/interests
//
// The listingId param is validated. The message field is optional — a student
// may send a bare interest signal without an intro message. The service defaults
// it to null if absent.
export const createInterestSchema = z.object({
	params: z.object({
		listingId: z.uuid({ error: "Invalid listing ID" }),
	}),
	body: z
		.object({
			message: z.string().min(1).max(1000).optional(),
		})
		.optional()
		.default({}),
});

// ─── Get single interest request ─────────────────────────────────────────────
// GET /api/v1/interests/:interestId
//
// Used by both the student (to check the status of a request they sent) and
// the poster (to see a specific request on their listing). Access control is
// enforced in the service — only the two parties can fetch a given row.
export const interestParamsSchema = z.object({
	params: z.object({
		interestId: z.uuid({ error: "Invalid interest request ID" }),
	}),
});

// ─── Update interest status ───────────────────────────────────────────────────
// PATCH /api/v1/interests/:interestId/status
//
// The status field accepts the three actor-driven transitions. 'expired' is
// intentionally excluded — that value is system-only (set by the listing
// deactivation/delete path and the cron job), never by a user action. If a
// client sends 'expired', Zod rejects it here before the request reaches the
// service.
//
// Whether a given transition is *legal* for the caller's role and current state
// is a semantic question the service answers — Zod only confirms the value is
// one of the known user-facing statuses.
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
//
// Poster-facing view of all requests on their listing. Supports filtering by
// status so a poster can quickly see only 'pending' items they need to act on.
// Keyset pagination uses (created_at DESC, interest_id ASC) — newest requests
// first, which is the most useful default for a poster managing a busy listing.
export const getListingInterestsSchema = z.object({
	params: z.object({
		listingId: z.uuid({ error: "Invalid listing ID" }),
	}),
	query: buildKeysetPaginationQuerySchema({
		status: z.enum(["pending", "accepted", "declined", "withdrawn", "expired"]).optional(),
	}),
});

// ─── Get my interest requests (student dashboard) ─────────────────────────────
// GET /api/v1/interests/me
//
// The student's view of all interest requests they have sent, across all listings.
// Status filter lets them focus on e.g. only 'accepted' requests (confirmed
// interest from the poster) or only 'pending' requests (waiting for a response).
export const getMyInterestsSchema = z.object({
	query: buildKeysetPaginationQuerySchema({
		status: z.enum(["pending", "accepted", "declined", "withdrawn", "expired"]).optional(),
	}),
});
