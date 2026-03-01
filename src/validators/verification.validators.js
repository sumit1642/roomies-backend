// src/validators/verification.validators.js

import { z } from "zod";

// ─── Document submission ──────────────────────────────────────────────────────

// POST /api/v1/pg-owners/:userId/documents
// document_url is validated as a non-empty string here — format and reachability
// are enforced by the storage layer in Phase 2. Accepting a URL string now keeps
// the verification pipeline decoupled from the upload mechanism.
export const submitDocumentSchema = z.object({
	params: z.object({
		userId: z.uuid({ error: "Invalid user ID" }),
	}),
	body: z.object({
		documentType: z.enum(["property_document", "rental_agreement", "owner_id", "trade_license"], {
			error: "Must be one of: property_document, rental_agreement, owner_id, trade_license",
		}),
		documentUrl: z.string({ error: "Document URL is required" }).min(1, { error: "Document URL cannot be empty" }),
	}),
});

// ─── Admin queue pagination ───────────────────────────────────────────────────

// GET /api/v1/admin/verification-queue
// Keyset pagination — cursor encodes the last-seen (submitted_at, request_id) pair.
// Both fields are required together or neither: a partial cursor is ambiguous.
// limit defaults to 20 and is capped at 100 to prevent accidentally large responses.
export const getQueueSchema = z.object({
	query: z
		.object({
			cursorTime: z.string().optional(),
			cursorId: z.uuid({ error: "cursorId must be a valid UUID" }).optional(),
			limit: z.coerce.number().int().min(1).max(100).default(20).optional(),
		})
		.refine(
			(data) => {
				const hasTime = data.cursorTime !== undefined;
				const hasId = data.cursorId !== undefined;
				// Either both cursor fields are present or neither is.
				return hasTime === hasId;
			},
			{ error: "cursorTime and cursorId must be provided together" },
		),
});

// ─── Admin resolution ─────────────────────────────────────────────────────────

// POST /api/v1/admin/verification-queue/:requestId/approve
export const approveRequestSchema = z.object({
	params: z.object({
		requestId: z.uuid({ error: "Invalid request ID" }),
	}),
	body: z.object({
		adminNotes: z.string().max(1000).optional(),
	}),
});

// POST /api/v1/admin/verification-queue/:requestId/reject
// rejectionReason is required on rejection — it is what the PG owner sees when
// they check their status, so a rejection without a reason is not allowed.
export const rejectRequestSchema = z.object({
	params: z.object({
		requestId: z.uuid({ error: "Invalid request ID" }),
	}),
	body: z.object({
		rejectionReason: z
			.string({ error: "Rejection reason is required" })
			.min(1, { error: "Rejection reason cannot be empty" })
			.max(1000),
		adminNotes: z.string().max(1000).optional(),
	}),
});
