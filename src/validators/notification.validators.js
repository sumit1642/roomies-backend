// src/validators/notification.validators.js
//
// Validation schemas for the three notification HTTP endpoints.
//
// The notification system has no creation endpoint exposed over HTTP — rows are
// written exclusively by the notification worker. All three schemas here are
// therefore read or mutation schemas, never creation schemas.

import { z } from "zod";

// ─── Notification feed ────────────────────────────────────────────────────────
// GET /api/v1/notifications
//
// The paginated in-app notification feed for the authenticated user.
// Keyset pagination on (created_at DESC, notification_id ASC) — same compound
// cursor pattern used throughout the codebase.
//
// isRead is an optional filter so the client can request only unread
// notifications (e.g. for a dropdown preview) or all notifications (for the
// full history page) with the same endpoint. z.coerce.boolean() handles the
// query string reality that ?isRead=true arrives as the string "true", not
// the boolean true.
//
// The both-or-neither cursor refinement is standard across all paginated
// endpoints — a cursorTime without a cursorId gives no stable row to resume
// from, so Zod rejects the partial cursor before it reaches the service.
export const getFeedSchema = z.object({
	query: z
		.object({
			isRead: z
				.preprocess((val) => {
					if (typeof val === "string") return val.toLowerCase() === "true";
					if (typeof val === "number") return Boolean(val);
					return val;
				}, z.boolean())
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

// ─── Mark notifications as read ───────────────────────────────────────────────
// POST /api/v1/notifications/mark-read
//
// Two modes, controlled by which field is present in the body:
//
//   { notificationIds: [uuid, ...] }  — mark specific notifications as read
//   { all: true }                     — mark all unread notifications as read
//
// The cross-field refinement enforces that at least one mode is specified.
// An empty body (or { all: false } with no notificationIds) is rejected so the
// client cannot accidentally send a no-op request and receive a misleading 200.
//
// { all: false } with no notificationIds is intentionally rejected — there is
// no meaningful action to take for that input. If the client wants to do
// nothing, it should simply not call the endpoint.
export const markReadSchema = z.object({
	body: z
		.object({
			notificationIds: z
				.array(z.uuid({ error: "Each notification ID must be a valid UUID" }))
				.min(1, { error: "notificationIds must contain at least one ID" })
				.optional(),

			// all: true clears every unread notification for the user in one query.
			// all: false is accepted by the schema but rejected by the refinement
			// below unless notificationIds is also present, which is an unusual but
			// technically valid combination (the service handles it by running the
			// selective update, not the bulk update).
			all: z.boolean().optional(),
		})
		.refine(
			(data) => data.all === true || (Array.isArray(data.notificationIds) && data.notificationIds.length > 0),
			{
				error:
					"Provide either { all: true } to mark all notifications as read, " +
					"or { notificationIds: [...] } to mark specific ones",
			},
		),
});
