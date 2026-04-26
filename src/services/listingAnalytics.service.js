// src/services/listingAnalytics.service.js

import { pool } from "../db/client.js";
import { AppError } from "../middleware/errorHandler.js";

export const getListingAnalytics = async (posterId, listingId) => {
	const { rows } = await pool.query(
		`SELECT
       l.listing_id,
       l.title,
       l.status,
       l.views_count,
       l.created_at,
       l.expires_at,

       -- Interest request counts by status in one aggregation
       COUNT(ir.request_id)                                        AS total_interests,
       COUNT(ir.request_id) FILTER (WHERE ir.status = 'pending')  AS pending_count,
       COUNT(ir.request_id) FILTER (WHERE ir.status = 'accepted') AS accepted_count,
       COUNT(ir.request_id) FILTER (WHERE ir.status = 'declined') AS declined_count,
       COUNT(ir.request_id) FILTER (WHERE ir.status = 'withdrawn') AS withdrawn_count,
       COUNT(ir.request_id) FILTER (WHERE ir.status = 'expired')  AS expired_count

     FROM listings l
     LEFT JOIN interest_requests ir
       ON ir.listing_id = l.listing_id
      AND ir.deleted_at IS NULL
     WHERE l.listing_id = $1
       AND l.posted_by  = $2
       AND l.deleted_at IS NULL
     GROUP BY l.listing_id`,
		[listingId, posterId],
	);

	if (!rows.length) {
		// Distinguish 404 from 403 with a second lightweight check.
		const { rows: existCheck } = await pool.query(
			`SELECT 1 FROM listings WHERE listing_id = $1 AND deleted_at IS NULL`,
			[listingId],
		);
		if (!existCheck.length) throw new AppError("Listing not found", 404);
		throw new AppError("Forbidden", 403);
	}

	const row = rows[0];

	const views = Number(row.views_count);
	const totalInterests = Number(row.total_interests);

	// Conversion rate: percentage of views that turned into an interest request.
	// Null when there are no views to avoid division-by-zero and misleading 0%.
	const conversionRate = views > 0 ? Math.round((totalInterests / views) * 10000) / 100 : null;

	return {
		listingId: row.listing_id,
		title: row.title,
		status: row.status,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		views: views,
		interests: {
			total: totalInterests,
			pending: Number(row.pending_count),
			accepted: Number(row.accepted_count),
			declined: Number(row.declined_count),
			withdrawn: Number(row.withdrawn_count),
			expired: Number(row.expired_count),
		},
		conversionRate,
	};
};
