// src/services/profilePhoto.service.js

import sharp from "sharp";
import { pool } from "../db/client.js";
import { storageService } from "../storage/index.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";

const MAX_DIMENSION_PX = 400;
const WEBP_QUALITY = 82;

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

// Checks the DB to see whether the given URL is still referenced by the profile
// row. Returns true when the row owns that URL (so we must NOT delete it).
const rowOwnsUrl = async (table, userId, url) => {
	try {
		const { rows } = await pool.query(
			`SELECT 1 FROM ${table} WHERE user_id = $1 AND profile_photo_url = $2 AND deleted_at IS NULL`,
			[userId, url],
		);
		return rows.length > 0;
	} catch {
		// If the ownership check itself fails, assume owned to be safe.
		return true;
	}
};

export const uploadStudentPhoto = async (requestingUserId, targetUserId, stagingPath) => {
	if (requestingUserId !== targetUserId) {
		throw new AppError("Forbidden", 403);
	}

	// Upload first, then atomically swap + capture old URL in one UPDATE.
	const newUrl = await compressAndUpload(stagingPath, targetUserId);

	let rows;
	try {
		({ rows } = await pool.query(
			`WITH current AS (
       SELECT profile_photo_url
       FROM student_profiles
       WHERE user_id = $2 AND deleted_at IS NULL
     )
     UPDATE student_profiles sp
     SET profile_photo_url = $1,
         updated_at        = NOW()
     FROM current
     WHERE sp.user_id    = $2
       AND sp.deleted_at IS NULL
     RETURNING current.profile_photo_url AS old_url`,
			[newUrl, targetUserId],
		));
	} catch (dbErr) {
		// pool.query can throw after the backend committed (network drop, timeout).
		// Re-check whether the row now owns newUrl before deleting it.
		const owned = await rowOwnsUrl("student_profiles", targetUserId, newUrl);
		if (!owned) {
			await tryDeleteBlob(newUrl, { userId: targetUserId, stage: "db-error-cleanup" });
		} else {
			logger.warn(
				{ userId: targetUserId, newUrl },
				"profilePhoto: DB error but row already references newUrl — skipping blob delete",
			);
		}
		throw dbErr;
	}

	if (!rows.length) {
		// Profile disappeared between compress and update — clean up the uploaded blob.
		await tryDeleteBlob(newUrl, { userId: targetUserId, stage: "post-upload-race" });
		throw new AppError("Student profile not found", 404);
	}

	const oldUrl = rows[0].old_url;
	logger.info({ userId: targetUserId, newUrl, hadPrevious: Boolean(oldUrl) }, "Student profile photo updated");

	// Delete old blob after DB commit — but only when oldUrl differs from newUrl.
	// Azure Blob Storage overwrites in place and returns the same URL for the same
	// object key, so when oldUrl === newUrl the "old" blob is the one we just wrote.
	if (oldUrl && oldUrl !== newUrl) {
		await tryDeleteBlob(oldUrl, { userId: targetUserId, stage: "replace-old" });
	}

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

	const newUrl = await compressAndUpload(stagingPath, targetUserId);

	let rows;
	try {
		({ rows } = await pool.query(
			`WITH current AS (
       SELECT profile_photo_url
       FROM pg_owner_profiles
       WHERE user_id = $2 AND deleted_at IS NULL
     )
     UPDATE pg_owner_profiles pop
     SET profile_photo_url = $1,
         updated_at        = NOW()
     FROM current
     WHERE pop.user_id    = $2
       AND pop.deleted_at IS NULL
     RETURNING current.profile_photo_url AS old_url`,
			[newUrl, targetUserId],
		));
	} catch (dbErr) {
		// Same guarded cleanup as uploadStudentPhoto above.
		const owned = await rowOwnsUrl("pg_owner_profiles", targetUserId, newUrl);
		if (!owned) {
			await tryDeleteBlob(newUrl, { userId: targetUserId, stage: "db-error-cleanup" });
		} else {
			logger.warn(
				{ userId: targetUserId, newUrl },
				"profilePhoto: DB error but pg_owner row already references newUrl — skipping blob delete",
			);
		}
		throw dbErr;
	}

	if (!rows.length) {
		await tryDeleteBlob(newUrl, { userId: targetUserId, stage: "post-upload-race" });
		throw new AppError("PG owner profile not found", 404);
	}

	const oldUrl = rows[0].old_url;
	logger.info({ userId: targetUserId, newUrl, hadPrevious: Boolean(oldUrl) }, "PG owner profile photo updated");

	// Skip delete when oldUrl === newUrl (same key, same blob).
	if (oldUrl && oldUrl !== newUrl) {
		await tryDeleteBlob(oldUrl, { userId: targetUserId, stage: "replace-old" });
	}

	return { profilePhotoUrl: newUrl };
};

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
