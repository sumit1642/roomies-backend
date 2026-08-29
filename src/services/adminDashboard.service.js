// src/services/adminDashboard.service.js
//
// New scope, not originally in ADR-016's endpoint inventory. Gives the
// admin a single-screen operational overview so daily moderation priorities
// (pending queues, recent growth, funnel health) don't require separately
// hitting five different list endpoints or falling back to SQL.
//
// Design constraints, per adminResponse.js's own documented convention
// ("totalMatching ... should only ever be passed when it was already cheap
// to compute ... never a separate COUNT(*) that blocks the response"):
//
//   1. ONE round trip. All counts are gathered via parallel CTEs in a single
//      query rather than N sequential COUNT(*) calls — avoids both
//      N+1-style round-trip latency and holding N separate connections.
//   2. Every COUNT(*) here is backed by an existing partial index from the
//      schema (see inline comments per CTE) — none of these are full-table
//      scans on an unbounded table. Tables without a relevant partial index
//      for the exact predicate (e.g. plain row counts on small reference
//      tables like institutions/amenities) are cheap regardless of index
//      because they're reference-data scale (tens to low-thousands of rows),
//      not user-generated-content scale.
//   3. "Recent" windows use a fixed 7-day lookback, matching the codebase's
//      existing convention for growth-style queries (e.g.
//      expiryWarning.js's WARNING_WINDOW_DAYS, rentIndexRefresh.js's
//      WINDOW_DAYS) — configurable via a function param rather than hardcoded
//      inline, so a future admin-UI date-range picker doesn't require a
//      service rewrite.

import { pool } from "../db/client.js";

const DEFAULT_RECENT_DAYS = 7;

export const getDashboardStats = async ({ recentDays = DEFAULT_RECENT_DAYS } = {}) => {
	const safeRecentDays =
		Number.isInteger(recentDays) && recentDays > 0 ? Math.min(recentDays, 90) : DEFAULT_RECENT_DAYS;

	const { rows } = await pool.query(
		`WITH
       -- Backed by idx_users_account_status (partial, deleted_at IS NULL).
       user_counts AS (
         SELECT
           COUNT(*)::int                                                    AS total,
           COUNT(*) FILTER (WHERE account_status = 'active')::int           AS active,
           COUNT(*) FILTER (WHERE account_status = 'suspended')::int        AS suspended,
           COUNT(*) FILTER (WHERE account_status = 'banned')::int           AS banned,
           COUNT(*) FILTER (WHERE account_status = 'deactivated')::int      AS deactivated,
           COUNT(*) FILTER (WHERE is_email_verified = FALSE)::int           AS unverified_email,
           COUNT(*) FILTER (WHERE created_at > NOW() - ($1::int * INTERVAL '1 day'))::int AS new_recent
         FROM users
         WHERE deleted_at IS NULL
       ),
       -- role counts via user_roles (idx_user_roles_role_name).
       role_counts AS (
         SELECT
           COUNT(*) FILTER (WHERE role_name = 'student')::int   AS students,
           COUNT(*) FILTER (WHERE role_name = 'pg_owner')::int  AS pg_owners,
           COUNT(*) FILTER (WHERE role_name = 'admin')::int     AS admins
         FROM user_roles ur
         JOIN users u ON u.user_id = ur.user_id AND u.deleted_at IS NULL
       ),
       -- Backed by idx_pg_owner_profiles_verification_status (partial, deleted_at IS NULL).
       pg_owner_verification_counts AS (
         SELECT
           COUNT(*) FILTER (WHERE verification_status = 'unverified')::int AS unverified,
           COUNT(*) FILTER (WHERE verification_status = 'pending')::int    AS pending,
           COUNT(*) FILTER (WHERE verification_status = 'verified')::int   AS verified,
           COUNT(*) FILTER (WHERE verification_status = 'rejected')::int   AS rejected
         FROM pg_owner_profiles
         WHERE deleted_at IS NULL
       ),
       -- Backed by idx_verification_requests_status_submitted (partial, deleted_at IS NULL).
       verification_queue_counts AS (
         SELECT COUNT(*)::int AS pending
         FROM verification_requests
         WHERE status = 'pending' AND deleted_at IS NULL
       ),
       -- Backed by idx_rating_reports_status_created (partial, deleted_at IS NULL).
       report_queue_counts AS (
         SELECT COUNT(*)::int AS open
         FROM rating_reports
         WHERE status = 'open' AND deleted_at IS NULL
       ),
       -- Backed by idx_listings_city_status for 'active'; other statuses are
       -- a small minority of the table so a plain filtered scan is cheap.
       listing_counts AS (
         SELECT
           COUNT(*)::int                                                      AS total,
           COUNT(*) FILTER (WHERE status = 'active')::int                     AS active,
           COUNT(*) FILTER (WHERE status = 'filled')::int                     AS filled,
           COUNT(*) FILTER (WHERE status = 'expired')::int                    AS expired,
           COUNT(*) FILTER (WHERE status = 'deactivated')::int                AS deactivated,
           COUNT(*) FILTER (
             WHERE status = 'active' AND expires_at <= NOW() + INTERVAL '3 days'
           )::int                                                             AS expiring_soon,
           COUNT(*) FILTER (WHERE created_at > NOW() - ($1::int * INTERVAL '1 day'))::int AS new_recent
         FROM listings
         WHERE deleted_at IS NULL
       ),
       -- Backed by idx_properties_status (partial, active AND deleted_at IS NULL).
       property_counts AS (
         SELECT
           COUNT(*)::int                                        AS total,
           COUNT(*) FILTER (WHERE status = 'active')::int        AS active,
           COUNT(*) FILTER (WHERE status = 'under_review')::int  AS under_review
         FROM properties
         WHERE deleted_at IS NULL
       ),
       -- Interest request funnel — backed by idx_interest_requests_listing_id
       -- and idx_interest_requests_sender_id, both partial on deleted_at IS NULL.
       interest_counts AS (
         SELECT
           COUNT(*)::int                                          AS total,
           COUNT(*) FILTER (WHERE status = 'pending')::int         AS pending,
           COUNT(*) FILTER (WHERE status = 'accepted')::int        AS accepted,
           COUNT(*) FILTER (WHERE created_at > NOW() - ($1::int * INTERVAL '1 day'))::int AS new_recent
         FROM interest_requests
         WHERE deleted_at IS NULL
       ),
       -- Backed by idx_connections_initiator_id / idx_connections_counterpart_id.
       connection_counts AS (
         SELECT
           COUNT(*)::int                                            AS total,
           COUNT(*) FILTER (WHERE confirmation_status = 'confirmed')::int AS confirmed,
           COUNT(*) FILTER (WHERE confirmation_status = 'pending')::int   AS pending
         FROM connections
         WHERE deleted_at IS NULL
       ),
       -- Small reference tables — cheap regardless of indexing at this scale.
       reference_counts AS (
         SELECT
           (SELECT COUNT(*)::int FROM institutions WHERE deleted_at IS NULL) AS institutions,
           (SELECT COUNT(*)::int FROM amenities)                             AS amenities
       )
     SELECT
       (SELECT row_to_json(user_counts)                    FROM user_counts)                    AS users,
       (SELECT row_to_json(role_counts)                     FROM role_counts)                     AS roles,
       (SELECT row_to_json(pg_owner_verification_counts)     FROM pg_owner_verification_counts)     AS pg_owner_verification,
       (SELECT row_to_json(verification_queue_counts)        FROM verification_queue_counts)        AS verification_queue,
       (SELECT row_to_json(report_queue_counts)               FROM report_queue_counts)               AS report_queue,
       (SELECT row_to_json(listing_counts)                   FROM listing_counts)                   AS listings,
       (SELECT row_to_json(property_counts)                  FROM property_counts)                  AS properties,
       (SELECT row_to_json(interest_counts)                  FROM interest_counts)                  AS interests,
       (SELECT row_to_json(connection_counts)                FROM connection_counts)                AS connections,
       (SELECT row_to_json(reference_counts)                 FROM reference_counts)                 AS reference_data`,
		[safeRecentDays],
	);

	const row = rows[0];

	return {
		generatedAt: new Date().toISOString(),
		recentWindowDays: safeRecentDays,

		users: {
			total: row.users.total,
			active: row.users.active,
			suspended: row.users.suspended,
			banned: row.users.banned,
			deactivated: row.users.deactivated,
			unverifiedEmail: row.users.unverified_email,
			newInWindow: row.users.new_recent,
			byRole: {
				students: row.roles.students,
				pgOwners: row.roles.pg_owners,
				admins: row.roles.admins,
			},
		},

		pgOwnerVerification: {
			unverified: row.pg_owner_verification.unverified,
			pending: row.pg_owner_verification.pending,
			verified: row.pg_owner_verification.verified,
			rejected: row.pg_owner_verification.rejected,
		},

		moderationQueues: {
			pendingVerificationRequests: row.verification_queue.pending,
			openReports: row.report_queue.open,
		},

		listings: {
			total: row.listings.total,
			active: row.listings.active,
			filled: row.listings.filled,
			expired: row.listings.expired,
			deactivated: row.listings.deactivated,
			expiringWithin3Days: row.listings.expiring_soon,
			newInWindow: row.listings.new_recent,
		},

		properties: {
			total: row.properties.total,
			active: row.properties.active,
			underReview: row.properties.under_review,
		},

		interests: {
			total: row.interests.total,
			pending: row.interests.pending,
			accepted: row.interests.accepted,
			newInWindow: row.interests.new_recent,
			conversionRate:
				row.interests.total > 0 ?
					Math.round((row.interests.accepted / row.interests.total) * 10000) / 100
				:	null,
		},

		connections: {
			total: row.connections.total,
			confirmed: row.connections.confirmed,
			pending: row.connections.pending,
			confirmationRate:
				row.connections.total > 0 ?
					Math.round((row.connections.confirmed / row.connections.total) * 10000) / 100
				:	null,
		},

		referenceData: {
			institutions: row.reference_data.institutions,
			amenities: row.reference_data.amenities,
		},
	};
};
