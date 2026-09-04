// ─── NEW FILE: src/controllers/adminAmenity.controller.js ──────────────────

import * as adminAmenityService from "../services/adminAmenity.service.js";
import { adminMutationEnvelope } from "../utils/adminResponse.js";

export const createAmenity = async (req, res, next) => {
	try {
		const result = await adminAmenityService.createAmenity(req.user.userId, req.body);
		res.status(201).json(adminMutationEnvelope(result, { actorId: req.user.userId, action: "amenity.create" }));
	} catch (err) {
		next(err);
	}
};

export const updateAmenity = async (req, res, next) => {
	try {
		const result = await adminAmenityService.updateAmenity(req.user.userId, req.params.amenityId, req.body);
		res.json(adminMutationEnvelope(result, { actorId: req.user.userId, action: "amenity.update" }));
	} catch (err) {
		next(err);
	}
};

export const deleteAmenity = async (req, res, next) => {
	try {
		const result = await adminAmenityService.deleteAmenity(req.user.userId, req.params.amenityId);
		res.json(adminMutationEnvelope(result, { actorId: req.user.userId, action: "amenity.delete" }));
	} catch (err) {
		next(err);
	}
};
