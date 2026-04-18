// src/services/adminAnalytics.service.js
//
// Platform analytics for the admin dashboard.
//
// ─── DESIGN: COMPUTED FRESH, NO CACHING ──────────────────────────────────────
//
// All metrics are computed live on every request. At Roomies' current scale
// (~100 users/day, tables with thousands of rows at most), these COUNT() and
// AVG() queries complete in single-digit milliseconds and don't warrant a
// caching layer. When query time consistently exceeds ~200ms, introduce a
// Redis-backed cache with a 5-minute TTL — but not before then.
//
// ─── DESIGN: PARALLEL QUERIES VIA Promise.all ────────────────────────────────
//
// Each metric group is an independent query with no dependency on the others.
// Running them sequentially would waste time waiting for each round-trip before
// starting the next. Promise.all fires all queries simultaneously; the total
// time is roughly the slowest individual query rather than their sum.
//
// ─── DESIGN: activeToday APPROXIMATION ───────────────────────────────────────
//
// True "daily active users" requires an activity log table that doesn't exist
// yet. The plan document suggested scanning Redis session keys, but that's not
// feasible without O(N) SCAN operations and no reliable "issued at" signal.
//
// Instead we track two meaningful signals that ARE available:
//   newToday    — users with created_at > NOW() - INTERVAL '24 hours'
//   newThisWeek — users with created_at > NOW() - INTERVAL '7 days'
//
// These are exact (backed by an index on created_at) and useful for growth
// monitoring. A future Phase 6 activity tracking table can replace this.

import { pool } from "../db/client.js";

export const getPlatformAnalytics = async () => {
	// Each query returns a single-row result. We destructure rows[0] from each.
	// The COALESCE on AVG handles the case where the ratings table is empty
	// (AVG of zero rows is NULL; we surface that as null so the API consumer
	// knows there's no data rather than a misleading 0.00).
	const [usersResult, listingsResult, connectionsResult, ratingsResult] = await Promise.all([
		// ── Users ──────────────────────────────────────────────────────────────
		// Counts total non-deleted users, new signups in the last 24h and 7d,
		// and breaks down by role. The role breakdown uses a FILTER clause on
		// COUNT so it stays in one query rather than requiring a GROUP BY subquery.
		//
		// The role breakdown uses EXISTS against user_roles rather than a JOIN
		// so that mixed-role users (both student AND pg_owner) are counted in
		// each applicable category without inflating the total.
		pool.query(`
			SELECT
				COUNT(*)::int                                                   AS total,
				COUNT(*) FILTER (
					WHERE created_at > NOW() - INTERVAL '24 hours'
				)::int                                                          AS new_today,
				COUNT(*) FILTER (
					WHERE created_at > NOW() - INTERVAL '7 days'
				)::int                                                          AS new_this_week,
				COUNT(*) FILTER (
					WHERE EXISTS (
						SELECT 1 FROM user_roles ur
						WHERE ur.user_id   = users.user_id
						  AND ur.role_name = 'student'
					)
				)::int                                                          AS student_count,
				COUNT(*) FILTER (
					WHERE EXISTS (
						SELECT 1 FROM user_roles ur
						WHERE ur.user_id   = users.user_id
						  AND ur.role_name = 'pg_owner'
					)
				)::int                                                          AS pg_owner_count,
				COUNT(*) FILTER (
					WHERE account_status = 'active'
				)::int                                                          AS active_count,
				COUNT(*) FILTER (
					WHERE account_status IN ('suspended', 'banned')
				)::int                                                          AS restricted_count
			FROM users
			WHERE deleted_at IS NULL
		`),

		// ── Listings ───────────────────────────────────────────────────────────
		// Tracks the current health of the listing inventory.
		// "filled this month" and "expired this month" use the current calendar
		// month so the numbers reset naturally on the 1st — more useful to an
		// admin than a rolling 30-day window which shifts daily.
		pool.query(`
			SELECT
				COUNT(*) FILTER (
					WHERE status = 'active' AND deleted_at IS NULL
				)::int   AS active_count,
				COUNT(*) FILTER (
					WHERE status = 'filled'
					  AND date_trunc('month', filled_at) = date_trunc('month', NOW())
					  AND deleted_at IS NULL
				)::int   AS filled_this_month,
				COUNT(*) FILTER (
					WHERE status = 'expired'
					  AND date_trunc('month', updated_at) = date_trunc('month', NOW())
					  AND deleted_at IS NULL
				)::int   AS expired_this_month,
				COUNT(*) FILTER (
					WHERE deleted_at IS NULL
				)::int   AS total
			FROM listings
		`),

		// ── Connections ────────────────────────────────────────────────────────
		// "confirmed this month" measures the platform's actual trust pipeline
		// output — connections where both parties confirmed a real-world interaction
		// within the current calendar month.
		pool.query(`
			SELECT
				COUNT(*)::int                                                   AS total,
				COUNT(*) FILTER (
					WHERE confirmation_status = 'confirmed'
					  AND date_trunc('month', updated_at) = date_trunc('month', NOW())
				)::int                                                          AS confirmed_this_month,
				COUNT(*) FILTER (
					WHERE confirmation_status = 'confirmed'
				)::int                                                          AS total_confirmed
			FROM connections
			WHERE deleted_at IS NULL
		`),

		// ── Ratings ────────────────────────────────────────────────────────────
		// Includes hidden ratings in the total count (for admin visibility) but
		// the platform average only uses visible ratings, which is consistent
		// with how user-facing average_rating is calculated by the DB trigger.
		pool.query(`
			SELECT
				COUNT(*)::int                                                   AS total,
				COUNT(*) FILTER (WHERE is_visible = TRUE)::int                 AS visible_count,
				COUNT(*) FILTER (WHERE is_visible = FALSE)::int                AS hidden_count,
				ROUND(
					AVG(overall_score) FILTER (WHERE is_visible = TRUE),
					2
				)                                                               AS avg_platform_score
			FROM ratings
			WHERE deleted_at IS NULL
		`),
	]);

	const users = usersResult.rows[0];
	const listings = listingsResult.rows[0];
	const connections = connectionsResult.rows[0];
	const ratings = ratingsResult.rows[0];

	return {
		users: {
			total: users.total,
			newToday: users.new_today,
			newThisWeek: users.new_this_week,
			byRole: {
				student: users.student_count,
				pgOwner: users.pg_owner_count,
			},
			byStatus: {
				active: users.active_count,
				restricted: users.restricted_count,
			},
		},
		listings: {
			total: listings.total,
			active: listings.active_count,
			filledThisMonth: listings.filled_this_month,
			expiredThisMonth: listings.expired_this_month,
		},
		connections: {
			total: connections.total,
			totalConfirmed: connections.total_confirmed,
			confirmedThisMonth: connections.confirmed_this_month,
		},
		ratings: {
			total: ratings.total,
			visibleCount: ratings.visible_count,
			hiddenCount: ratings.hidden_count,
			// null when no visible ratings exist yet — more honest than 0.00
			avgPlatformScore: ratings.avg_platform_score ? parseFloat(ratings.avg_platform_score) : null,
		},
	};
};
