// src/validators/notification.validators.js
//
// ─── FIXES IN THIS VERSION ────────────────────────────────────────────────────
//
// 1. isRead COERCION — was converting any non-"true" string (e.g. "yes", "1",
//    "TRUE") silently to false. The fix narrows the preprocess to only convert
//    the exact lowercase string "true" and the exact lowercase string "false",
//    leaving any other string untouched so z.boolean() rejects it with a 400.
//
// 2. MUTUAL EXCLUSION for all + notificationIds — the previous refine allowed
//    a client to send both fields simultaneously, which is semantically
//    ambiguous. The fix requires exactly one mode: either all:true OR a
//    non-empty notificationIds array, never both at the same time.

import { z } from "zod";

// ─── Notification feed ────────────────────────────────────────────────────────
export const getFeedSchema = z.object({
	query: z
		.object({
			// Only the exact strings "true" and "false" (case-insensitive) are
			// accepted. Any other string (e.g. "1", "yes", "on") is passed through
			// unchanged so z.boolean() can reject it with a 400 Validation error.
			// Numbers are still coerced to boolean for API clients that send 0/1.
			isRead: z
				.preprocess((val) => {
					if (typeof val === "string") {
						if (val.toLowerCase() === "true") return true;
						if (val.toLowerCase() === "false") return false;
						// Leave unrecognised strings unchanged — z.boolean() will reject them.
						return val;
					}
					if (typeof val === "number") return Boolean(val);
					return val;
				}, z.boolean())
				.optional(),

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
		),
});

// ─── Mark notifications as read ───────────────────────────────────────────────
//
// The two modes are mutually exclusive — sending both simultaneously is
// ambiguous and rejected. The refine returns true only when exactly one of the
// two modes is active (XOR logic):
//   only { all: true }               → valid
//   only { notificationIds: [...] }  → valid
//   both fields at once              → invalid (400)
//   neither field                    → invalid (400)
export const markReadSchema = z.object({
	body: z
		.object({
			notificationIds: z
				.array(z.uuid({ error: "Each notification ID must be a valid UUID" }))
				.min(1, { error: "notificationIds must contain at least one ID" })
				.optional(),

			all: z.boolean().optional(),
		})
		.refine(
			(data) => {
				const hasAll = data.all === true;
				const hasIds = Array.isArray(data.notificationIds) && data.notificationIds.length > 0;
				// Exactly one mode must be active — XOR.
				return hasAll !== hasIds;
			},
			{
				error:
					"Provide exactly one mode: either { all: true } to mark all notifications as read, " +
					"or { notificationIds: [...] } to mark specific ones — not both simultaneously",
			},
		),
});
