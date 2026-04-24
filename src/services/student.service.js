

import { pool } from "../db/client.js";
import { AppError } from "../middleware/errorHandler.js";
import { logger } from "../logger/index.js";
import { dedupePreferencesByKey } from "../config/preferences.js";

const assertStudentProfileExists = async (clientOrPool, userId) => {
	const { rows } = await clientOrPool.query(
		`SELECT 1
     FROM student_profiles
     WHERE user_id = $1
       AND deleted_at IS NULL`,
		[userId],
	);

	if (!rows.length) {
		throw new AppError("Student profile not found", 404);
	}
};

export const getStudentProfile = async (requestingUserId, targetUserId) => {
	const { rows } = await pool.query(
		`SELECT
			sp.profile_id,
			sp.user_id,
			sp.full_name,
			sp.date_of_birth,
			sp.gender,
			sp.profile_photo_url,
			sp.bio,
			sp.course,
			sp.year_of_study,
			sp.institution_id,
			sp.is_aadhaar_verified,
			CASE WHEN $2::uuid = sp.user_id THEN u.email ELSE NULL END AS email,
			u.is_email_verified,
			u.average_rating,
			u.rating_count,
			u.created_at
		FROM student_profiles sp
		JOIN users u ON u.user_id = sp.user_id
		WHERE sp.user_id = $1
		AND sp.deleted_at IS NULL
		AND u.deleted_at IS NULL`,
		[targetUserId, requestingUserId],
	);

	if (!rows.length) throw new AppError("Student profile not found", 404);
	return rows[0];
};



















export const getStudentContactReveal = async (targetUserId, emailOnly = false) => {
	const { rows } = await pool.query(
		`SELECT
			u.user_id,
			sp.full_name,
			u.email,
			u.phone AS whatsapp_phone
		FROM users u
		JOIN student_profiles sp
		  ON sp.user_id    = u.user_id
		 AND sp.deleted_at IS NULL
		WHERE u.user_id    = $1
		  AND u.deleted_at IS NULL`,
		[targetUserId],
	);

	if (!rows.length) throw new AppError("Student not found", 404);

	const row = rows[0];

	if (emailOnly) {
		
		
		return {
			user_id: row.user_id,
			full_name: row.full_name,
			email: row.email,
		};
	}

	return row;
};

export const updateStudentProfile = async (requestingUserId, targetUserId, updates) => {
	if (requestingUserId !== targetUserId) {
		throw new AppError("Forbidden", 403);
	}

	const columnMap = {
		fullName: "full_name",
		bio: "bio",
		course: "course",
		yearOfStudy: "year_of_study",
		gender: "gender",
		dateOfBirth: "date_of_birth",
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
		`UPDATE student_profiles
		SET ${setClauses.join(", ")}
		WHERE user_id = $${paramIndex}
		AND deleted_at IS NULL
		RETURNING *`,
		values,
	);

	if (!rows.length) {
		throw new AppError("Student profile not found", 404);
	}

	return rows[0];
};

const bulkInsertUserPreferences = async (client, userId, preferences) => {
	if (!preferences.length) return;

	const placeholders = preferences.map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`).join(", ");
	const values = [
		userId,
		...preferences.flatMap(({ preferenceKey, preferenceValue }) => [preferenceKey, preferenceValue]),
	];

	await client.query(
		`INSERT INTO user_preferences (user_id, preference_key, preference_value)
     VALUES ${placeholders}`,
		values,
	);
};

export const getStudentPreferences = async (requestingUserId, targetUserId) => {
	if (requestingUserId !== targetUserId) {
		throw new AppError("Forbidden", 403);
	}

	await assertStudentProfileExists(pool, targetUserId);

	const { rows } = await pool.query(
		`SELECT preference_key AS "preferenceKey", preference_value AS "preferenceValue"
     FROM user_preferences
     WHERE user_id = $1
     ORDER BY preference_key`,
		[targetUserId],
	);

	return rows;
};

export const updateStudentPreferences = async (requestingUserId, targetUserId, preferences) => {
	if (requestingUserId !== targetUserId) {
		throw new AppError("Forbidden", 403);
	}

	const dedupedPreferences = dedupePreferencesByKey(preferences);

	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await assertStudentProfileExists(client, targetUserId);
		await client.query(`DELETE FROM user_preferences WHERE user_id = $1`, [targetUserId]);
		await bulkInsertUserPreferences(client, targetUserId, dedupedPreferences);
		await client.query("COMMIT");

		logger.info(
			{ userId: targetUserId, preferenceCount: dedupedPreferences.length },
			"Student preferences updated",
		);

		return dedupedPreferences;
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
};
