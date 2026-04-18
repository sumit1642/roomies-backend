// src/services/adminUser.service.js
//
// Admin-facing user management. Three operations:
//
//   listUsers        — paginated user list with role and status filters.
//   getUserDetail    — full profile context for a single user.
//   updateUserStatus — suspend, ban, or reactivate a user account.
//
// ─── SECURITY: ADMIN-TARGETING GUARD ─────────────────────────────────────────
//
// An admin cannot change the account_status of another admin. This prevents a
// rogue or compromised admin account from locking out the entire admin team.
// The check reads user_roles for the TARGET user before any UPDATE — if the
// target holds the 'admin' role, the operation is rejected with 403.
//
// An admin also cannot change their own status — that would allow self-lockout
// which, while recoverable via DB, creates unnecessary support burden.
//
// ─── STATUS TRANSITION TABLE ─────────────────────────────────────────────────
//
// Admin-driven transitions differ from user-driven ones:
//   'active'      → 'suspended' | 'banned'
//   'suspended'   → 'active'    | 'banned'
//   'banned'      → 'active'
//   'deactivated' → 'active'    (admin can reactivate a self-deactivated account)
//
// The 'deactivated' status is user-initiated (soft-delete). Admins can restore
// it to 'active' if the user contacts support. Admins cannot set 'deactivated'
// directly — that's the user's own soft-delete action.
//
// ─── IMMEDIATE EFFECT ────────────────────────────────────────────────────────
//
// When a user is suspended or banned, the effect is immediate: authenticate.js
// reads account_status from the DB on every request via findUserById(), and
// INACTIVE_STATUSES includes 'suspended' and 'banned'. No session invalidation
// from Redis is needed — the next request from any of their sessions will fail
// the account_status check and return 401.
//
// When a user is reactivated, their existing Redis sessions (refresh tokens) are
// still valid. They can use them immediately — no re-login required.

import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";

// ─── Allowed admin-driven status transitions ───────────────────────────────────
const ALLOWED_TRANSITIONS = {
	active: ["suspended", "banned"],
	suspended: ["active", "banned"],
	banned: ["active"],
	deactivated: ["active"],
};

// ─── List users ───────────────────────────────────────────────────────────────
//
// Returns a paginated summary of all non-deleted users. Supports three filters:
//   role          — filter to users who hold this role ('student' | 'pg_owner' | 'admin')
//   accountStatus — filter by account_status enum value
//   isEmailVerified — true | false
//
// The role filter uses EXISTS against user_roles rather than a JOIN so that
// mixed-role users appear exactly once in the results regardless of how many
// roles they hold.
//
// Keyset pagination on (created_at DESC, user_id ASC).
export const listUsers = async (filters) => {
	const { role, accountStatus, isEmailVerified, cursorTime, cursorId, limit: rawLimit = 20 } = filters;

	const limit = Math.min(Math.max(1, rawLimit), 100);

	const clauses = [`u.deleted_at IS NULL`];
	const params = [];
	let p = 1;

	if (role !== undefined) {
		clauses.push(`
			EXISTS (
				SELECT 1 FROM user_roles ur
				WHERE ur.user_id   = u.user_id
				  AND ur.role_name = $${p}::role_enum
			)
		`);
		params.push(role);
		p++;
	}

	if (accountStatus !== undefined) {
		clauses.push(`u.account_status = $${p}::account_status_enum`);
		params.push(accountStatus);
		p++;
	}

	if (isEmailVerified !== undefined) {
		clauses.push(`u.is_email_verified = $${p}`);
		params.push(isEmailVerified);
		p++;
	}

	const hasCursor = cursorTime !== undefined && cursorId !== undefined;
	if (hasCursor) {
		// Newest-first with stable tiebreaker: (created_at DESC, user_id ASC)
		// The cursor condition mirrors the ORDER BY exactly.
		clauses.push(`(u.created_at < $${p} OR (u.created_at = $${p} AND u.user_id > $${p + 1}::uuid))`);
		params.push(cursorTime, cursorId);
		p += 2;
	}

	params.push(limit + 1);
	const limitParam = p;

	const { rows } = await pool.query(
		`SELECT
			u.user_id,
			u.email,
			u.account_status,
			u.is_email_verified,
			u.average_rating,
			u.rating_count,
			u.created_at,

			-- Aggregate the user's roles into an array. ARRAY_AGG with ORDER BY
			-- gives a stable ordering so tests can assert on role arrays reliably.
			COALESCE(
				(
					SELECT ARRAY_AGG(ur.role_name ORDER BY ur.role_name)
					FROM user_roles ur
					WHERE ur.user_id = u.user_id
				),
				'{}'::role_enum[]
			) AS roles,

			-- Display name: prefer student full_name, then pg_owner full name,
			-- fall back to email prefix so admins always see something human-readable.
			COALESCE(
				sp.full_name,
				pop.owner_full_name,
				split_part(u.email, '@', 1)
			) AS display_name

		FROM users u
		LEFT JOIN student_profiles  sp
			ON sp.user_id    = u.user_id
		   AND sp.deleted_at IS NULL
		LEFT JOIN pg_owner_profiles pop
			ON pop.user_id   = u.user_id
		   AND pop.deleted_at IS NULL
		WHERE ${clauses.join(" AND ")}
		ORDER BY u.created_at DESC, u.user_id ASC
		LIMIT $${limitParam}`,
		params,
	);

	const hasNextPage = rows.length > limit;
	const items = hasNextPage ? rows.slice(0, limit) : rows;

	const nextCursor =
		hasNextPage ?
			{
				cursorTime: items[items.length - 1].created_at.toISOString(),
				cursorId: items[items.length - 1].user_id,
			}
		:	null;

	return {
		items: items.map((row) => ({
			userId: row.user_id,
			email: row.email,
			displayName: row.display_name,
			roles: Array.isArray(row.roles) ? row.roles : [],
			accountStatus: row.account_status,
			isEmailVerified: row.is_email_verified,
			averageRating: row.average_rating,
			ratingCount: row.rating_count,
			createdAt: row.created_at,
		})),
		nextCursor,
	};
};

// ─── Get user detail ──────────────────────────────────────────────────────────
//
// Returns full profile context for a single user: their base identity, both
// profile records if they exist (a user can be both student AND pg_owner),
// verification status for PG owners, and activity counts for context.
//
// We never throw 404 for admin endpoints the way we do for user-facing endpoints
// — the privacy-preserving 404 pattern is specifically for non-admin callers who
// shouldn't know whether a resource exists. Admins always get an honest 404
// when a user genuinely doesn't exist.
export const getUserDetail = async (userId) => {
	// Single query joining all relevant tables. Using LEFT JOINs throughout so
	// users without a student_profile or pg_owner_profile still return.
	const { rows } = await pool.query(
		`SELECT
			u.user_id,
			u.email,
			u.google_id              IS NOT NULL AS has_google_auth,
			u.account_status,
			u.is_email_verified,
			u.is_phone_verified,
			u.average_rating,
			u.rating_count,
			u.created_at,
			u.updated_at,

			-- Roles array
			COALESCE(
				(
					SELECT ARRAY_AGG(ur.role_name ORDER BY ur.role_name)
					FROM user_roles ur
					WHERE ur.user_id = u.user_id
				),
				'{}'::role_enum[]
			) AS roles,

			-- Student profile (may be NULL)
			sp.profile_id            AS student_profile_id,
			sp.full_name             AS student_full_name,
			sp.bio                   AS student_bio,
			sp.course,
			sp.year_of_study,
			sp.gender,
			sp.is_aadhaar_verified,
			sp.profile_photo_url     AS student_photo_url,
			sp.institution_id,

			-- PG owner profile (may be NULL)
			pop.profile_id           AS pg_owner_profile_id,
			pop.business_name,
			pop.owner_full_name,
			pop.business_phone,
			pop.operating_since,
			pop.verification_status,
			pop.verified_at,
			pop.rejection_reason,

			-- Activity counts: listings, connections, ratings given/received
			(
				SELECT COUNT(*)::int
				FROM listings l
				WHERE l.posted_by  = u.user_id
				  AND l.deleted_at IS NULL
			) AS listing_count,

			(
				SELECT COUNT(*)::int
				FROM connections c
				WHERE (c.initiator_id = u.user_id OR c.counterpart_id = u.user_id)
				  AND c.deleted_at IS NULL
			) AS connection_count,

			(
				SELECT COUNT(*)::int
				FROM ratings r
				WHERE r.reviewer_id = u.user_id
				  AND r.deleted_at  IS NULL
			) AS ratings_given_count,

			(
				SELECT COUNT(*)::int
				FROM ratings r
				WHERE r.reviewee_id  = u.user_id
				  AND r.reviewee_type = 'user'
				  AND r.deleted_at   IS NULL
			) AS ratings_received_count,

			-- Open reports filed BY this user (reporter)
			(
				SELECT COUNT(*)::int
				FROM rating_reports rr
				WHERE rr.reporter_id = u.user_id
				  AND rr.status      = 'open'
				  AND rr.deleted_at  IS NULL
			) AS open_reports_filed_count

		FROM users u
		LEFT JOIN student_profiles  sp
			ON sp.user_id    = u.user_id
		   AND sp.deleted_at IS NULL
		LEFT JOIN pg_owner_profiles pop
			ON pop.user_id   = u.user_id
		   AND pop.deleted_at IS NULL
		WHERE u.user_id    = $1
		  AND u.deleted_at IS NULL`,
		[userId],
	);

	if (!rows.length) {
		throw new AppError("User not found", 404);
	}

	const row = rows[0];

	// Build profile objects only if the underlying row was actually joined —
	// checking a non-nullable column from each profile table as a presence signal.
	const studentProfile =
		row.student_profile_id ?
			{
				profileId: row.student_profile_id,
				fullName: row.student_full_name,
				bio: row.student_bio,
				course: row.course,
				yearOfStudy: row.year_of_study,
				gender: row.gender,
				isAadhaarVerified: row.is_aadhaar_verified,
				profilePhotoUrl: row.student_photo_url,
				institutionId: row.institution_id,
			}
		:	null;

	const pgOwnerProfile =
		row.pg_owner_profile_id ?
			{
				profileId: row.pg_owner_profile_id,
				businessName: row.business_name,
				ownerFullName: row.owner_full_name,
				businessPhone: row.business_phone,
				operatingSince: row.operating_since,
				verificationStatus: row.verification_status,
				verifiedAt: row.verified_at,
				rejectionReason: row.rejection_reason,
			}
		:	null;

	return {
		userId: row.user_id,
		email: row.email,
		hasGoogleAuth: row.has_google_auth,
		roles: Array.isArray(row.roles) ? row.roles : [],
		accountStatus: row.account_status,
		isEmailVerified: row.is_email_verified,
		isPhoneVerified: row.is_phone_verified,
		averageRating: row.average_rating,
		ratingCount: row.rating_count,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		studentProfile,
		pgOwnerProfile,
		activity: {
			listingCount: row.listing_count,
			connectionCount: row.connection_count,
			ratingsGivenCount: row.ratings_given_count,
			ratingsReceivedCount: row.ratings_received_count,
			openReportsFiledCount: row.open_reports_filed_count,
		},
	};
};

// ─── Update user status ────────────────────────────────────────────────────────
//
// Applies an admin-driven status transition to a user account.
//
// Guards (checked in order):
//   1. Self-targeting: adminId === targetUserId → 403
//   2. Admin-targeting: target user holds 'admin' role → 403
//   3. Transition validity: current → requested must be in ALLOWED_TRANSITIONS
//   4. Concurrency: UPDATE with AND account_status = $current catches races
//
// adminNotes is required when banning (permanent action) and optional otherwise.
export const updateUserStatus = async (adminId, targetUserId, { status: newStatus, adminNotes }) => {
	// Guard 1: self-targeting
	if (adminId === targetUserId) {
		throw new AppError("You cannot change your own account status", 403);
	}

	// Guard 2: admin-targeting — fetch the target's roles before any mutation.
	// This query hits the user_roles index on user_id, so it's fast.
	const { rows: roleRows } = await pool.query(`SELECT role_name FROM user_roles WHERE user_id = $1`, [targetUserId]);

	const targetRoles = roleRows.map((r) => r.role_name);
	if (targetRoles.includes("admin")) {
		throw new AppError("You cannot change the account status of another admin", 403);
	}

	// Require adminNotes when banning — permanent action needs justification.
	if (newStatus === "banned" && (!adminNotes || adminNotes.trim() === "")) {
		throw new AppError("adminNotes is required when banning a user", 400);
	}

	// Read current status to validate the transition. We do this as a separate
	// read rather than embedding it in the UPDATE so we can return a precise
	// error message (transition not allowed vs. user not found vs. concurrent change).
	const { rows: userRows } = await pool.query(
		`SELECT account_status FROM users WHERE user_id = $1 AND deleted_at IS NULL`,
		[targetUserId],
	);

	if (!userRows.length) {
		throw new AppError("User not found", 404);
	}

	const currentStatus = userRows[0].account_status;

	// Guard 3: transition validity
	const allowed = ALLOWED_TRANSITIONS[currentStatus] ?? [];
	if (!allowed.includes(newStatus)) {
		throw new AppError(`Cannot transition account status from '${currentStatus}' to '${newStatus}'`, 422);
	}

	// Guard 4: concurrency — AND account_status = $current prevents a race
	// where two concurrent admin actions both read the same current status and
	// both attempt conflicting transitions. rowCount === 0 means someone else
	// already changed the status between our read and our write.
	const { rowCount } = await pool.query(
		`UPDATE users
		 SET account_status = $1,
		     updated_at     = NOW()
		 WHERE user_id       = $2
		   AND account_status = $3
		   AND deleted_at    IS NULL`,
		[newStatus, targetUserId, currentStatus],
	);

	if (rowCount === 0) {
		throw new AppError("Account status changed concurrently — please refresh and retry", 409);
	}

	logger.info(
		{
			adminId,
			targetUserId,
			previousStatus: currentStatus,
			newStatus,
			adminNotes: adminNotes ?? null,
		},
		`adminUser.updateUserStatus: account status changed from '${currentStatus}' to '${newStatus}'`,
	);

	return {
		userId: targetUserId,
		previousStatus: currentStatus,
		accountStatus: newStatus,
	};
};
