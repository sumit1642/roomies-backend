// src/db/utils/auth.js

import { pool } from "../client.js";

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
	if (!rows[0]) return null;

	const user = rows[0];

	if (typeof user.roles === "string") {
		user.roles = user.roles === "{}" ? [] : user.roles.replace(/^{|}$/g, "").split(",");
	}
	return user;

	// return rows[0] ?? null;
};

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
