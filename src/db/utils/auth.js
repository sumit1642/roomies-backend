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
// duplicate check (only needs existence). Returns null if not found or soft-deleted.
export const findUserByEmail = async (email, client = pool) => {
	const { rows } = await client.query(
		`
		SELECT
			user_id,
			email,
			password_hash,
			account_status,
			is_email_verified
			FROM users
			WHERE email = $1
				AND deleted_at IS NULL`,
		[email],
	);
	return rows[0] ?? null;
};

// Added at end of branch when OAuth endpoint is implemented.
// Placeholder kept here so the import location is established.
// export const findUserByGoogleId = async (googleId, client = pool) => { ... }
