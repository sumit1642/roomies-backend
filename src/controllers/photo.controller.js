// src/controllers/photo.controller.js

import * as photoService from "../services/photo.service.js";

export const uploadPhoto = async (req, res, next) => {
	try {
		if (!req.file) {
			return res.status(400).json({
				status: "error",
				message: "No file uploaded — send the image under the field name 'photo'",
			});
		}

		const result = await photoService.enqueuePhotoUpload(
			req.user.userId,
			req.params.listingId,
			req.file.path, // Absolute path to the staged file on disk
			req.body.displayOrder, // May be undefined — service handles the default
		);

		// 202 Accepted: the request has been received and queued. The photo is not
		// yet available. The client should poll GET /photos to observe completion.
		res.status(202).json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const getPhotos = async (req, res, next) => {
	try {
		const photos = await photoService.getListingPhotos(req.params.listingId);
		res.json({ status: "success", data: photos });
	} catch (err) {
		next(err);
	}
};

export const deletePhoto = async (req, res, next) => {
	try {
		const result = await photoService.deletePhoto(req.user.userId, req.params.listingId, req.params.photoId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const setCoverPhoto = async (req, res, next) => {
	try {
		const result = await photoService.setCoverPhoto(req.user.userId, req.params.listingId, req.params.photoId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const reorderPhotos = async (req, res, next) => {
	try {
		const photos = await photoService.reorderPhotos(req.user.userId, req.params.listingId, req.body.photos);
		res.json({ status: "success", data: photos });
	} catch (err) {
		next(err);
	}
};
