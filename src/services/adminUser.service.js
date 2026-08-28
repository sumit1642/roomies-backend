// src/services/adminUser.service.js
//
// ADR-016 Phase 2. Every function here is admin-only (routes are gated by
// requireAdmin) and deliberately bypasses the caller-scoped redaction that
// getStudentProfile/getPgOwnerProfile apply to email/phone for non-owners —
// an admin needs the real values to do account moderation. Do not reuse
// these functions from any non-admin route.

import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";

// ─── getUserDetail ────────────────────────────────────────────────────────
//
// Full account detail: base user row + roles + whichever profile
// (student_profiles / pg_owner_profiles) exists for this user, unredacted.
// Replaces: SELECT * FROM users JOIN ... WHERE user_id = $1 (run by hand today).
export const getUserDetail = async (userId) => {
	const { rows } = await pool.query(
		`SELECT
       u.user_id,
       u.email,
       u.phone,
       u.account_status,
       u.status_reason,
       u.status_changed_at,
       u.status_changed_by,
       u.is_email_verified,
       u.is_phone_verified,
       u.average_rating,
       u.rating_count,
       u.created_at,
       u.updated_at,
       COALESCE(
         (
           SELECT ARRAY_AGG(r.role_name ORDER BY r.role_name)
           FROM (SELECT DISTINCT ur.role_name FROM user_roles ur WHERE ur.user_id = u.user_id) r
         ),
         '{}'
       ) AS roles,

       sp.full_name          AS student_full_name,
       sp.bio                AS student_bio,
       sp.course             AS student_course,
       sp.year_of_study      AS student_year_of_study,
       sp.institution_id     AS student_institution_id,
       sp.is_aadhaar_verified AS student_is_aadhaar_verified,

       pop.business_name         AS pg_owner_business_name,
       pop.owner_full_name       AS pg_owner_full_name,
       pop.business_phone        AS pg_owner_business_phone,
       pop.verification_status   AS pg_owner_verification_status,
       pop.rejection_reason      AS pg_owner_rejection_reason,
       pop.verified_at           AS pg_owner_verified_at

     FROM users u
     LEFT JOIN student_profiles sp ON sp.user_id = u.user_id AND sp.deleted_at IS NULL
     LEFT JOIN pg_owner_profiles pop ON pop.user_id = u.user_id AND pop.deleted_at IS NULL
     WHERE u.user_id = $1
       AND u.deleted_at IS NULL`,
		[userId],
	);

	if (!rows.length) {
		throw new AppError("User not found", 404);
	}

	const row = rows[0];
	const roles =
		typeof row.roles === "string" ? row.roles.replace(/^{|}$/g, "").split(",").filter(Boolean) : row.roles;

	return {
		userId: row.user_id,
		email: row.email,
		phone: row.phone,
		accountStatus: row.account_status,
		statusReason: row.status_reason,
		statusChangedAt: row.status_changed_at,
		statusChangedBy: row.status_changed_by,
		isEmailVerified: row.is_email_verified,
		isPhoneVerified: row.is_phone_verified,
		averageRating: row.average_rating,
		ratingCount: row.rating_count,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		roles,
		studentProfile:
			row.student_full_name !== null || roles.includes("student") ?
				{
					fullName: row.student_full_name,
					bio: row.student_bio,
					course: row.student_course,
					yearOfStudy: row.student_year_of_study,
					institutionId: row.student_institution_id,
					isAadhaarVerified: row.student_is_aadhaar_verified,
				}
			:	null,
		pgOwnerProfile:
			row.pg_owner_business_name !== null ?
				{
					businessName: row.pg_owner_business_name,
					ownerFullName: row.pg_owner_full_name,
					businessPhone: row.pg_owner_business_phone,
					verificationStatus: row.pg_owner_verification_status,
					rejectionReason: row.pg_owner_rejection_reason,
					verifiedAt: row.pg_owner_verified_at,
				}
			:	null,
	};
};

// ─── listUsers ────────────────────────────────────────────────────────────
//
// Replaces: SELECT * FROM users WHERE email ILIKE ... (run by hand today).
// email filter is a prefix match (consistent with searchListings'/roommate
// feed's city-filter convention elsewhere in this codebase) with the same
// LIKE-metacharacter escaping used there.
export const listUsers = async (filters) => {
	const { role, accountStatus, email, cursorTime, cursorId, limit: rawLimit = 20 } = filters;
	const limit = Math.min(Math.max(1, rawLimit), 100);

	const clauses = [`u.deleted_at IS NULL`];
	const params = [];
	let p = 1;

	if (role !== undefined) {
		clauses.push(
			`EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.user_id AND ur.role_name = $${p}::role_enum)`,
		);
		params.push(role);
		p++;
	}

	if (accountStatus !== undefined) {
		clauses.push(`u.account_status = $${p}::account_status_enum`);
		params.push(accountStatus);
		p++;
	}

	if (email !== undefined) {
		const escaped = email.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
		clauses.push(`LOWER(u.email) LIKE LOWER($${p}) ESCAPE '\\'`);
		params.push(`${escaped}%`);
		p++;
	}

	const hasCursor = cursorTime !== undefined && cursorId !== undefined;
	if (hasCursor) {
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
       u.phone,
       u.account_status,
       u.is_email_verified,
       u.created_at,
       COALESCE(
         (
           SELECT ARRAY_AGG(r.role_name ORDER BY r.role_name)
           FROM (SELECT DISTINCT ur.role_name FROM user_roles ur WHERE ur.user_id = u.user_id) r
         ),
         '{}'
       ) AS roles
     FROM users u
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
		items: items.map((row) => {
			const roles =
				typeof row.roles === "string" ? row.roles.replace(/^{|}$/g, "").split(",").filter(Boolean) : row.roles;
			return {
				userId: row.user_id,
				email: row.email,
				phone: row.phone,
				accountStatus: row.account_status,
				isEmailVerified: row.is_email_verified,
				createdAt: row.created_at,
				roles,
			};
		}),
		nextCursor,
	};
};

// ─── setUserAccountStatus ─────────────────────────────────────────────────
//
// Replaces: UPDATE users SET account_status = ... (run by hand today, with
// no reason/actor/timestamp recorded anywhere — see migration 016).
//
// No-op guard: setting the SAME status the user already has is rejected
// with a 422 rather than silently succeeding — an admin re-submitting the
// same status is almost always a UI double-click or a stale page, and
// silently "succeeding" would overwrite a possibly-different existing
// reason without the admin realizing nothing actually changed.
export const setUserAccountStatus = async (adminUserId, targetUserId, { accountStatus, reason }) => {
	const { rows } = await pool.query(
		`UPDATE users
     SET account_status     = $1::account_status_enum,
         status_reason      = $2,
         status_changed_at  = NOW(),
         status_changed_by  = $3
     WHERE user_id     = $4
       AND deleted_at  IS NULL
       AND account_status IS DISTINCT FROM $1::account_status_enum
     RETURNING user_id, account_status, status_reason, status_changed_at, status_changed_by`,
		[accountStatus, reason, adminUserId, targetUserId],
	);

	if (!rows.length) {
		const { rows: existRows } = await pool.query(
			`SELECT account_status FROM users WHERE user_id = $1 AND deleted_at IS NULL`,
			[targetUserId],
		);

		if (!existRows.length) {
			throw new AppError("User not found", 404);
		}

		throw new AppError(`User already has account status '${existRows[0].account_status}' — no change made`, 422);
	}

	const row = rows[0];

	logger.info(
		{ adminUserId, targetUserId, accountStatus, reason, action: "user.setAccountStatus" },
		`Admin set user account status to '${accountStatus}'`,
	);

	return {
		userId: row.user_id,
		accountStatus: row.account_status,
		statusReason: row.status_reason,
		statusChangedAt: row.status_changed_at,
		statusChangedBy: row.status_changed_by,
	};
};
