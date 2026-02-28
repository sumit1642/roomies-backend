// src/services/pgOwner.service.js

import { pool } from "../db/client.js";
import { AppError } from "../middleware/errorHandler.js";

export const getPgOwnerProfile = async (userId) => {
	const { rows } = await pool.query(
		`
		SELECT
			pop.profile_id,
			pop.user_id,
			pop.business_name,
			pop.owner_full_name,
			pop.business_description,
			pop.business_phone,
			pop.operating_since,
			pop.verification_status,
			pop.verified_at,
			u.email,
			u.is_email_verified,
			u.average_rating,
			u.rating_count,
			u.created_at
		FROM pg_owner_profiles pop
		JOIN users u ON u.user_id = pop.user_id
		WHERE pop.user_id = $1
			AND pop.deleted_at IS NULL
			AND u.deleted_at IS NULL`,
		[userId],
	);

	if (!rows.length) throw new AppError("PG owner profile not found", 404);
	return rows[0];
};

export const updatePgOwnerProfile = async (requestingUserId, targetUserId, updates) => {
	if (requestingUserId !== targetUserId) {
		throw new AppError("Forbidden", 403);
	}

	const { rows: existing } = await pool.query(
		`SELECT profile_id FROM pg_owner_profiles WHERE user_id = $1 AND deleted_at IS NULL`,
		[targetUserId],
	);
	if (!existing.length) throw new AppError("PG owner profile not found", 404);

	const columnMap = {
		businessName: "business_name",
		ownerFullName: "owner_full_name",
		businessDescription: "business_description",
		businessPhone: "business_phone",
		operatingSince: "operating_since",
	};

	const setClauses = [];
	const values = [];
	let paramIndex = 1;

	for (const [key, column] of Object.entries(columnMap)) {
		if (updates[key] !== undefined) {
			setClauses.push(`${column} = $${paramIndex}`);
			values.push(updates[key]);
			paramIndex++;
		}
	}

	if (!setClauses.length) {
		throw new AppError("No valid fields provided for update", 400);
	}

	values.push(targetUserId);

	const { rows } = await pool.query(
		`
		UPDATE pg_owner_profiles
			SET ${setClauses.join(", ")}
			WHERE user_id = $${paramIndex}
			AND deleted_at IS NULL
			RETURNING *`,
		values,
	);

	return rows[0];
};
