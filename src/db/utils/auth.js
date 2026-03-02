// src/db/utils/auth.js

import { pool } from "../client.js";

// Called by authenticate middleware on every protected request.
// Selects only what req.user needs — not SELECT *.
// Returns null if not found or soft-deleted.
//
// Roles are aggregated via a correlated subquery rather than a JOIN + GROUP BY
// for two reasons:
//   1. DISTINCT + ORDER BY cannot coexist inside ARRAY_AGG(DISTINCT ...) in the
//      same clause in PostgreSQL — the subquery deduplicates first, then the outer
//      AGG orders the result, which satisfies both requirements cleanly.
//   2. The subquery approach avoids the GROUP BY on the users columns entirely,
//      which is simpler and less error-prone when new columns are selected later.
// In practice user_roles has a composite PK (user_id, role_name) that already
// prevents duplicates, but the DISTINCT makes the query correct-by-construction
// regardless of future schema changes.
export const findUserById = async (id, client = pool) => {
	const { rows } = await client.query(
		`
		SELECT
			u.user_id,
			u.email,
			u.account_status,
			u.is_email_verified,
			COALESCE(
						(
							SELECT ARRAY_AGG(r.role_name ORDER BY r.role_name)
							FROM (
								SELECT DISTINCT ur.role_name
								FROM user_roles ur
								WHERE ur.user_id = u.user_id
									AND ur.role_name IS NOT NULL
								) r
							),
						'{}'
					) AS roles
		FROM users u
		WHERE u.user_id = $1
			AND u.deleted_at IS NULL`,
		[id],
	);
	return rows[0] ?? null;
};

// Called by login (needs password_hash for bcrypt compare) and registration
// duplicate check (only needs existence). Also called by the OAuth account-linking
// path which needs google_id to detect whether the row already has a google_id set.
// Returns null if not found or soft-deleted.
export const findUserByEmail = async (email, client = pool) => {
	const { rows } = await client.query(
		`
		SELECT
			user_id,
			email,
			password_hash,
			google_id,
			account_status,
			is_email_verified
		FROM users
		WHERE email = $1
			AND deleted_at IS NULL`,
		[email],
	);
	return rows[0] ?? null;
};

// Looks up a user by their Google OAuth subject ID (the `sub` field in the
// Google ID token). Called during OAuth sign-in to determine whether this
// Google account has been seen before (returning user) or is new.
//
// Returns enough columns for the service to make a branching decision:
//   - user_id           → needed for JWT issuance and Redis key
//   - email             → included in JWT payload
//   - google_id         → returned so the caller can confirm the link rather
//                         than assuming it
//   - account_status    → checked before issuing tokens, same as login
//   - is_email_verified → included in token response user object
//
// Does NOT return password_hash — OAuth users may not have one, and the
// OAuth flow never needs it. Keeping it out prevents accidental logging.
//
// Accepts an optional client so it can participate in a transaction when the
// account-linking UPDATE and a subsequent SELECT need to be atomic.
export const findUserByGoogleId = async (googleId, client = pool) => {
	const { rows } = await client.query(
		`
		SELECT
			user_id,
			email,
			google_id,
			account_status,
			is_email_verified
		FROM users
		WHERE google_id = $1
			AND deleted_at IS NULL`,
		[googleId],
	);
	return rows[0] ?? null;
};
