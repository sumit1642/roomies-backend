// src/controllers/profilePhoto.controller.js

import { rm } from "node:fs/promises";
import { logger } from "../logger/index.js";
import { UPLOAD_FIELD_NAME } from "../config/constants.js";
import * as profilePhotoService from "../services/profilePhoto.service.js";

// ─── shared helper ────────────────────────────────────────────────────────────

const cleanupStagedFile = async (filePath) => {
	if (!filePath) return;
	try {
		await rm(filePath, { force: true });
	} catch (err) {
		logger.warn({ filePath, err }, "profilePhoto: failed to clean up staged file");
	}
};

// ─── student ─────────────────────────────────────────────────────────────────

export const uploadStudentPhoto = async (req, res, next) => {
	try {
		if (!req.file) {
			return res.status(400).json({
				status: "error",
				message: `No file uploaded — send the image under the field name '${UPLOAD_FIELD_NAME}'`,
			});
		}

		const result = await profilePhotoService.uploadStudentPhoto(req.user.userId, req.params.userId, req.file.path);

		// Staging file has been consumed by sharp; remove it.
		await cleanupStagedFile(req.file.path);

		res.json({ status: "success", data: result });
	} catch (err) {
		await cleanupStagedFile(req.file?.path);
		next(err);
	}
};

export const deleteStudentPhoto = async (req, res, next) => {
	try {
		const result = await profilePhotoService.deleteStudentPhoto(req.user.userId, req.params.userId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

// ─── pg owner ────────────────────────────────────────────────────────────────

export const uploadPgOwnerPhoto = async (req, res, next) => {
	try {
		if (!req.file) {
			return res.status(400).json({
				status: "error",
				message: `No file uploaded — send the image under the field name '${UPLOAD_FIELD_NAME}'`,
			});
		}

		const result = await profilePhotoService.uploadPgOwnerPhoto(req.user.userId, req.params.userId, req.file.path);

		await cleanupStagedFile(req.file.path);

		res.json({ status: "success", data: result });
	} catch (err) {
		await cleanupStagedFile(req.file?.path);
		next(err);
	}
};

export const deletePgOwnerPhoto = async (req, res, next) => {
	try {
		const result = await profilePhotoService.deletePgOwnerPhoto(req.user.userId, req.params.userId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};
