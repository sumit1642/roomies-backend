// src/services/adminListing.service.js
//
// ADR-016 Phase 4 — "moderation edge case". Replaces:
//   UPDATE listings SET status = 'deactivated' ...
// run by hand today when an admin needs to take a listing down outside the
// owner-driven ALLOWED_STATUS_TRANSITIONS table in listing.service.js
// (e.g. a listing flagged as fraudulent that the owner won't touch).
//
// Deliberately does NOT reuse updateListingStatus from listing.service.js —
// that function enforces the owner's transition table (active->filled,
// active->deactivated, etc.) and the ownership WHERE clause (posted_by =
// $callerId). An admin override needs neither: any status -> any status,
// regardless of who posted it. Reusing that function would mean either
// weakening its guards for the admin case (risking a regression for the
// normal owner-driven path) or threading an "isAdmin" bypass flag through
// it — both worse than a small, separate, admin-only function whose only
// job is this override.
//
// Side effects mirrored from listing.service.js's own updateListingStatus
// where they still make sense for an admin-forced transition:
//   - Moving OUT of 'active' (to 'filled', 'expired', or 'deactivated')
//     expires any pending interest requests on the listing, same as the
//     owner-driven path — a pending interest on a listing the admin just
//     pulled down should not linger as actionable.
//   - Moving INTO 'active' from 'filled' resets current_occupants to 0,
//     matching the reactivatingFromFilled branch in listing.service.js —
//     otherwise a forced reactivation could leave a stale occupant count.
//   - filled_at is stamped on transition TO 'filled', cleared otherwise,
//     matching the semantics of that column elsewhere in the schema.
//
// No expires_at guard (unlike updateListingStatus's `l.expires_at > NOW()`
// check when going to 'active') — an admin reactivating an expired listing
// is a deliberate override, not a mistake the system should block.

import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";
import { expirePendingRequestsForListing } from "./interest.service.js";

export const forceListingStatus = async (adminUserId, listingId, { status, reason }) => {
	const client = await pool.connect();
	let previousStatus;
	let updatedRow;

	try {
		await client.query("BEGIN");

		const { rows: currentRows } = await client.query(
			`SELECT listing_id, status, posted_by
       FROM listings
       WHERE listing_id = $1
         AND deleted_at IS NULL
       FOR UPDATE`,
			[listingId],
		);

		if (!currentRows.length) {
			throw new AppError("Listing not found", 404);
		}

		previousStatus = currentRows[0].status;

		if (previousStatus === status) {
			throw new AppError(`Listing already has status '${status}' — no change made`, 422);
		}

		const reactivatingFromFilled = previousStatus === "filled" && status === "active";
		const movingOutOfActive = previousStatus === "active" && status !== "active";

		const { rows: updatedRows } = await client.query(
			`UPDATE listings
       SET status        = $1::listing_status_enum,
           filled_at      = CASE WHEN $1::listing_status_enum = 'filled'::listing_status_enum THEN NOW() ELSE NULL END,
           current_occupants = CASE WHEN $2::boolean THEN 0 ELSE current_occupants END,
           updated_at     = NOW()
       WHERE listing_id   = $3
         AND deleted_at   IS NULL
       RETURNING listing_id, status, posted_by, filled_at, current_occupants`,
			[status, reactivatingFromFilled, listingId],
		);

		if (!updatedRows.length) {
			throw new AppError("Listing status update could not be applied — please retry", 409);
		}

		updatedRow = updatedRows[0];

		if (movingOutOfActive) {
			await expirePendingRequestsForListing(listingId, client);
		}

		await client.query("COMMIT");
	} catch (err) {
		try {
			await client.query("ROLLBACK");
		} catch (rollbackErr) {
			logger.error({ rollbackErr, err, adminUserId, listingId }, "forceListingStatus: rollback failed");
		}
		throw err;
	} finally {
		client.release();
	}

	logger.info(
		{
			adminUserId,
			listingId,
			from: previousStatus,
			to: status,
			reason,
			postedBy: updatedRow.posted_by,
			action: "listing.forceStatus",
		},
		`Admin force-changed listing status from '${previousStatus}' to '${status}'`,
	);

	return {
		listingId: updatedRow.listing_id,
		status: updatedRow.status,
		previousStatus,
		reason,
		currentOccupants: updatedRow.current_occupants,
		filledAt: updatedRow.filled_at,
	};
};
