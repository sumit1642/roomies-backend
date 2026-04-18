// src/validators/notification.validators.js

import { z } from "zod";

// ─── Notification feed ────────────────────────────────────────────────────────
export const getFeedSchema = z.object({
	query: z
		.object({
			// Accepts the exact strings "true"/"false" (case-insensitive) and the
			// numeric values 0 (false) and 1 (true). Any other value — including
			// numbers like 2 or -1 — is passed through unchanged so z.boolean()
			// rejects it with a clean 400.
			isRead: z
				.preprocess((val) => {
					if (typeof val === "string") {
						if (val.toLowerCase() === "true") return true;
						if (val.toLowerCase() === "false") return false;
						return val;
					}
					if (typeof val === "number") {
						if (val === 0) return false;
						if (val === 1) return true;
						return val;
					}
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
// `all` is z.literal(true) — only the value true is accepted, not false or any
// other value. Sending { all: false } is rejected by Zod before .refine() runs.
// The .refine() XOR uses a presence check (data.all !== undefined) rather than
// a value check, which is equivalent since z.literal(true) guarantees that if
// the field is present its value is always true.
export const markReadSchema = z.object({
	body: z
		.object({
			notificationIds: z
				.array(z.uuid({ error: "Each notification ID must be a valid UUID" }))
				.min(1, { error: "notificationIds must contain at least one ID" })
				.optional(),

			all: z.literal(true).optional(),
		})
		.refine(
			(data) => {
				const hasAll = data.all !== undefined;
				const hasIds = Array.isArray(data.notificationIds) && data.notificationIds.length > 0;
				return hasAll !== hasIds;
			},
			{
				error:
					"Provide exactly one mode: either { all: true } to mark all notifications as read, " +
					"or { notificationIds: [...] } to mark specific ones — not both simultaneously",
			},
		),
});
