

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
