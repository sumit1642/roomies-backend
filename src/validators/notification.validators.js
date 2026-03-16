// src/validators/notification.validators.js
//
// ─── FIXES IN THIS VERSION ────────────────────────────────────────────────────
//
// 1. isRead COERCION — narrowed so only the exact strings "true" / "false"
//    (case-insensitive) are accepted. Any other string is left unchanged and
//    rejected by z.boolean() with a clean 400.
//
// 2. MUTUAL EXCLUSION — `all` is now z.literal(true) instead of z.boolean().
//    This means the field can only ever be the value `true` or absent (undefined).
//    The .refine() uses a presence check (data.all !== undefined) so that sending
//    { all: false, notificationIds: [...] } is correctly rejected — previously
//    hasAll was computed as (data.all === true) which evaluated to false for
//    all: false, letting it through as if `all` were not present.
//
//    With z.literal(true):
//      { all: true }                  → hasAll=true,  hasIds=false → valid ✓
//      { notificationIds: ["uuid"] }  → hasAll=false, hasIds=true  → valid ✓
//      { all: true, notificationIds } → hasAll=true,  hasIds=true  → 400 ✓
//      { all: false }                 → Zod rejects immediately    → 400 ✓
//      { all: false, notificationIds }→ Zod rejects immediately    → 400 ✓

import { z } from "zod";

// ─── Notification feed ────────────────────────────────────────────────────────
export const getFeedSchema = z.object({
	query: z
		.object({
			// Only the exact strings "true" and "false" (case-insensitive) are
			// accepted. Any other string (e.g. "1", "yes", "on") is passed through
			// unchanged so z.boolean() rejects it with a 400 Validation error.
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
// `all` is z.literal(true) — it can only be the value `true` or absent.
// Sending { all: false } is therefore rejected at the Zod parse step before
// the .refine() even runs, which gives the clearest possible error message.
//
// The .refine() XOR uses a presence check (data.all !== undefined) rather than
// a value check (data.all === true). Since z.literal(true) guarantees that if
// the field is present its value is true, both checks are equivalent — but
// the presence check makes the intent more explicit: "exactly one mode must
// be indicated".
export const markReadSchema = z.object({
	body: z
		.object({
			notificationIds: z
				.array(z.uuid({ error: "Each notification ID must be a valid UUID" }))
				.min(1, { error: "notificationIds must contain at least one ID" })
				.optional(),

			// z.literal(true) means this field can only appear as the value true.
			// { all: false } will be rejected by Zod before reaching .refine().
			all: z.literal(true).optional(),
		})
		.refine(
			(data) => {
				// Presence check: is the `all` mode activated?
				// Because z.literal(true) is used above, data.all is either true
				// or undefined — never false or any other value.
				const hasAll = data.all !== undefined;
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
