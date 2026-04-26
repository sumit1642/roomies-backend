// src/services/profilePhoto.service.js

import sharp from "sharp";
import { pool } from "../db/client.js";
import { storageService } from "../storage/index.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";

const MAX_DIMENSION_PX = 400;
const WEBP_QUALITY = 82;

const profileBlobPath = (userId) => `profiles/${userId}/${userId}.webp`;

const compressAndUpload = async (stagingPath, userId) => {
	const buffer = await sharp(stagingPath)
		.resize(MAX_DIMENSION_PX, MAX_DIMENSION_PX, { fit: "cover", withoutEnlargement: true })
		.webp({ quality: WEBP_QUALITY })
		.withMetadata(false)
		.toBuffer();

	const url = await storageService.upload(buffer, `profile-${userId}`, `${userId}.webp`);
	return url;
};

const tryDeleteBlob = async (url, context) => {
	if (!url) return;
	try {
		await storageService.delete(url);
	} catch (err) {
		logger.warn({ err, url, ...context }, "profilePhoto: failed to delete old blob — orphan may remain");
	}
};

export const uploadStudentPhoto = async (requestingUserId, targetUserId, stagingPath) => {
	if (requestingUserId !== targetUserId) {
		throw new AppError("Forbidden", 403);
	}

	const { rows } = await pool.query(
		`SELECT profile_photo_url
     FROM student_profiles
     WHERE user_id    = $1
       AND deleted_at IS NULL`,
		[targetUserId],
	);

	if (!rows.length) {
		throw new AppError("Student profile not found", 404);
	}

	const oldUrl = rows[0].profile_photo_url;

	const newUrl = await compressAndUpload(stagingPath, targetUserId);

	const { rowCount } = await pool.query(
		`UPDATE student_profiles
     SET profile_photo_url = $1,
         updated_at        = NOW()
     WHERE user_id    = $2
       AND deleted_at IS NULL`,
		[newUrl, targetUserId],
	);

	if (rowCount === 0) {
		await tryDeleteBlob(newUrl, { userId: targetUserId, stage: "post-upload-race" });
		throw new AppError("Student profile not found", 404);
	}

	logger.info({ userId: targetUserId, newUrl, hadPrevious: Boolean(oldUrl) }, "Student profile photo updated");

	await tryDeleteBlob(oldUrl, { userId: targetUserId, stage: "replace-old" });

	return { profilePhotoUrl: newUrl };
};

export const deleteStudentPhoto = async (requestingUserId, targetUserId) => {
	if (requestingUserId !== targetUserId) {
		throw new AppError("Forbidden", 403);
	}

	const { rows: result } = await pool.query(
		`WITH old AS (
       SELECT profile_photo_url
       FROM student_profiles
       WHERE user_id = $1 AND deleted_at IS NULL
     )
     UPDATE student_profiles sp
     SET profile_photo_url = NULL,
         updated_at        = NOW()
     FROM old
     WHERE sp.user_id    = $1
       AND sp.deleted_at IS NULL
     RETURNING old.profile_photo_url AS old_url`,
		[targetUserId],
	);

	if (!result.length) {
		throw new AppError("Student profile not found", 404);
	}

	const oldUrl = result[0].old_url;

	logger.info({ userId: targetUserId, hadPhoto: Boolean(oldUrl) }, "Student profile photo deleted");

	await tryDeleteBlob(oldUrl, { userId: targetUserId, stage: "delete-photo" });

	return { profilePhotoUrl: null };
};

export const uploadPgOwnerPhoto = async (requestingUserId, targetUserId, stagingPath) => {
	if (requestingUserId !== targetUserId) {
		throw new AppError("Forbidden", 403);
	}

	const { rows } = await pool.query(
		`SELECT profile_photo_url
     FROM pg_owner_profiles
     WHERE user_id    = $1
       AND deleted_at IS NULL`,
		[targetUserId],
	);

	if (!rows.length) {
		throw new AppError("PG owner profile not found", 404);
	}

	const oldUrl = rows[0].profile_photo_url;

	const newUrl = await compressAndUpload(stagingPath, targetUserId);

	const { rowCount } = await pool.query(
		`UPDATE pg_owner_profiles
     SET profile_photo_url = $1,
         updated_at        = NOW()
     WHERE user_id    = $2
       AND deleted_at IS NULL`,
		[newUrl, targetUserId],
	);

	if (rowCount === 0) {
		await tryDeleteBlob(newUrl, { userId: targetUserId, stage: "post-upload-race" });
		throw new AppError("PG owner profile not found", 404);
	}

	logger.info({ userId: targetUserId, newUrl, hadPrevious: Boolean(oldUrl) }, "PG owner profile photo updated");

	await tryDeleteBlob(oldUrl, { userId: targetUserId, stage: "replace-old" });

	return { profilePhotoUrl: newUrl };
};

/**
 * Remove the profile photo for a PG owner.
 */
export const deletePgOwnerPhoto = async (requestingUserId, targetUserId) => {
	if (requestingUserId !== targetUserId) {
		throw new AppError("Forbidden", 403);
	}

	const { rows: result } = await pool.query(
		`WITH old AS (
       SELECT profile_photo_url
       FROM pg_owner_profiles
       WHERE user_id = $1 AND deleted_at IS NULL
     )
     UPDATE pg_owner_profiles pop
     SET profile_photo_url = NULL,
         updated_at        = NOW()
     FROM old
     WHERE pop.user_id    = $1
       AND pop.deleted_at IS NULL
     RETURNING old.profile_photo_url AS old_url`,
		[targetUserId],
	);

	if (!result.length) {
		throw new AppError("PG owner profile not found", 404);
	}

	const oldUrl = result[0].old_url;

	logger.info({ userId: targetUserId, hadPhoto: Boolean(oldUrl) }, "PG owner profile photo deleted");

	await tryDeleteBlob(oldUrl, { userId: targetUserId, stage: "delete-photo" });

	return { profilePhotoUrl: null };
};
