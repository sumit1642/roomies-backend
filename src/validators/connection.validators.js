// src/validators/connection.validators.js
//
// Validation schemas for connection endpoints.
//
// Connections are created exclusively by the interest service (inside the
// accepted-transition transaction) — there is no POST /connections endpoint.
// All schemas here are for reading and confirming existing connections.
//
// The confirm endpoint has no body — the intent is fully expressed by the
// route verb (POST) and the path (/connections/:connectionId/confirm). Zod
// only needs to validate the path parameter.

import { z } from "zod";

// ─── Single connection ────────────────────────────────────────────────────────
// Used by:
//   GET  /api/v1/connections/:connectionId
//   POST /api/v1/connections/:connectionId/confirm
//
// Catches non-UUID path params at the validator edge so a malformed ID never
// reaches the service or generates a cryptic PostgreSQL invalid-uuid error.
export const connectionParamsSchema = z.object({
	params: z.object({
		connectionId: z.uuid({ error: "Invalid connection ID" }),
	}),
});

// ─── My connections feed ──────────────────────────────────────────────────────
// GET /api/v1/connections/me
//
// Returns all connections the authenticated user is a party to, newest first.
// Supports two optional filters:
//
//   confirmation_status — lets the client show only 'pending' connections
//   (interactions not yet mutually confirmed) or only 'confirmed' connections
//   (eligible for ratings in Phase 4). The 'denied' and 'expired' values are
//   included for completeness — a client may want to show a history of all
//   interactions regardless of outcome.
//
//   connection_type — lets the client filter by the nature of the interaction
//   (student_roommate, pg_stay, hostel_stay, visit_only). Useful for a student
//   who wants to see only their PG stays when preparing to write a rating.
//
// Keyset pagination uses (created_at DESC, connection_id ASC):
//   - newest-first is the most useful default for a dashboard
//   - compound cursor handles the created_at ties that will occur in tests
//     where rows are inserted in rapid succession
//
// Both cursor fields must come together or not at all — a partial cursor is
// ambiguous (cursorTime without cursorId gives no stable row to resume from).
// The .refine() enforces this as a cross-field constraint.
export const getMyConnectionsSchema = z.object({
	query: z
		.object({
			confirmationStatus: z
				.enum(["pending", "confirmed", "denied", "expired"], {
					error: "confirmationStatus must be one of: pending, confirmed, denied, expired",
				})
				.optional(),

			connectionType: z
				.enum(["student_roommate", "pg_stay", "hostel_stay", "visit_only"], {
					error: "connectionType must be one of: student_roommate, pg_stay, hostel_stay, visit_only",
				})
				.optional(),

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
