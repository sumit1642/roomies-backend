// src/services/student.service.js

import { pool } from "../db/client.js";
import { AppError } from "../middleware/errorHandler.js";

export const getStudentProfile = async (userId) => {
	const { rows } = await pool.query(
		`
		SELECT
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
			u.email,
			u.is_email_verified,
			u.average_rating,
			u.rating_count,
			u.created_at
		FROM student_profiles sp
		JOIN users u ON u.user_id = sp.user_id
		WHERE sp.user_id = $1
			AND sp.deleted_at IS NULL
			AND u.deleted_at IS NULL`,
		[userId],
	);

	if (!rows.length) throw new AppError("Student profile not found", 404);
	return rows[0];
};

export const updateStudentProfile = async (requestingUserId, targetUserId, updates) => {
	// Ownership check — a student can only update their own profile
	if (requestingUserId !== targetUserId) {
		throw new AppError("Forbidden", 403);
	}

	// Verify the profile exists
	const { rows: existing } = await pool.query(
		`SELECT profile_id FROM student_profiles WHERE user_id = $1 AND deleted_at IS NULL`,
		[targetUserId],
	);
	if (!existing.length) throw new AppError("Student profile not found", 404);

	// Build the SET clause dynamically from only the fields that were provided.
	// Using a map from camelCase request body to snake_case column names.
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

	values.push(targetUserId); // for the WHERE clause

	const { rows } = await pool.query(
		`
		UPDATE student_profiles
			SET ${setClauses.join(", ")}
			WHERE user_id = $${paramIndex}
			AND deleted_at IS NULL
			RETURNING *`,
		values,
	);

	return rows[0];
};
