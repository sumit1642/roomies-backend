// src/validators/adminListing.validators.js
//
// ADR-016 Phase 4. Admin moderation override for listings — bypasses the
// owner-driven ALLOWED_STATUS_TRANSITIONS state machine in
// listing.service.js entirely. An admin is not "another actor going through
// the normal transition table with elevated permissions" — they are a
// superuser override for cases the normal state machine was never designed
// to handle (e.g. taking down a listing flagged as fraudulent regardless of
// its current status). All four listing_status_enum values are therefore
// legal targets here, unlike updateListingStatusSchema in listing.validators.js.

import { z } from "zod";

const LISTING_STATUS_VALUES = ["active", "filled", "expired", "deactivated"];

export const adminListingParamsSchema = z.object({
	params: z.object({
		listingId: z.uuid({ error: "Invalid listing ID" }),
	}),
});

export const forceListingStatusSchema = z.object({
	params: z.object({
		listingId: z.uuid({ error: "Invalid listing ID" }),
	}),
	body: z.object({
		status: z.enum(LISTING_STATUS_VALUES, {
			error: `status must be one of: ${LISTING_STATUS_VALUES.join(", ")}`,
		}),
		reason: z
			.string({ error: "reason is required" })
			.trim()
			.min(1, { error: "reason cannot be empty" })
			.max(1000, { error: "reason must not exceed 1000 characters" }),
	}),
});
