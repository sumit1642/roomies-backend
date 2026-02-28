// src/db/utils/auth.js

import { pool } from "../client.js";

// Called by authenticate middleware on every protected request.
// JOINs user_roles so we get the roles array in one round-trip — never two queries.
// Selects only what req.user needs — not SELECT *.
// Returns null if not found or soft-deleted.
export const findUserById = async (id, client = pool) => {
	const { rows } = await client.query(
		`
		SELECT
			u.user_id,
			u.email,
			u.account_status,
			u.is_email_verified,
			COALESCE(
				ARRAY_AGG(ur.role_name ORDER BY ur.role_name) FILTER (WHERE ur.role_name IS NOT NULL),
			'{}'
			) AS roles
		FROM users u
		LEFT JOIN user_roles ur ON ur.user_id = u.user_id
		WHERE u.user_id = $1
		AND u.deleted_at IS NULL
		GROUP BY u.user_id, u.email, u.account_status, u.is_email_verified`,
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
