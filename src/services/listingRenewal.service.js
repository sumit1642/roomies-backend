// src/services/listingRenewal.service.js

import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";

const RENEWABLE_STATUSES = new Set(["active", "expired", "deactivated"]);
const RENEWAL_INTERVAL_DAYS = 60;

export const renewListing = async (posterId, listingId) => {
	// Use GREATEST(expires_at, NOW()) so an active listing with time remaining
	// gets the full renewal interval *added on top of* its current expiry, not
	// replaced from NOW(). COALESCE handles the NULL case for listings that have
	// never had an expiry set.
	const { rows } = await pool.query(
		`UPDATE listings
     SET status     = 'active'::listing_status_enum,
         expires_at = GREATEST(COALESCE(expires_at, NOW()), NOW()) + ($1::int * INTERVAL '1 day'),
         updated_at = NOW()
     WHERE listing_id = $2
       AND posted_by  = $3
       AND deleted_at IS NULL
       AND status     = ANY($4::listing_status_enum[])
     RETURNING
       listing_id,
       status,
       expires_at`,
		[RENEWAL_INTERVAL_DAYS, listingId, posterId, [...RENEWABLE_STATUSES]],
	);

	if (!rows.length) {
		const { rows: check } = await pool.query(
			`SELECT status, posted_by
       FROM listings
       WHERE listing_id = $1
         AND deleted_at IS NULL`,
			[listingId],
		);

		if (!check.length) {
			throw new AppError("Listing not found", 404);
		}

		if (check[0].posted_by !== posterId) {
			throw new AppError("Forbidden", 403);
		}

		throw new AppError(
			`Listing cannot be renewed from its current status '${check[0].status}'. ` +
				`Only active, expired, or deactivated listings can be renewed.`,
			422,
		);
	}

	const row = rows[0];

	logger.info(
		{
			posterId,
			listingId,
			newStatus: row.status,
			newExpiresAt: row.expires_at,
			renewalDays: RENEWAL_INTERVAL_DAYS,
		},
		"Listing renewed",
	);

	return {
		listingId: row.listing_id,
		status: row.status,
		expiresAt: row.expires_at,
		renewedFor: `${RENEWAL_INTERVAL_DAYS} days`,
	};
};
