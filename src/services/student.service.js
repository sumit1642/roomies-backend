// src/services/student.service.js

import { pool } from "../db/client.js";
import { AppError } from "../middleware/errorHandler.js";

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

// Returns contact details for a student. Requires an active student_profiles row
// (INNER JOIN, not LEFT JOIN) so only users who actually have a student profile
// can be returned — preventing PG owners or admin accounts from being exposed
// through this endpoint even if their user_id is known.
//
// emailOnly: false — verified callers; returns email + whatsapp_phone (u.phone).
// emailOnly: true  — guests/unverified callers; returns email only.
// The whatsapp_phone field is stripped at this boundary so it never reaches
// the response serialiser for restricted callers.
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
