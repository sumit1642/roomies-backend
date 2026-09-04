// src/controllers/institution.controller.js

import * as institutionService from "../services/institution.service.js";
import { adminMutationEnvelope, adminListEnvelope } from "../utils/adminResponse.js";

export const createInstitution = async (req, res, next) => {
	try {
		const result = await institutionService.createInstitution(req.user.userId, req.body);
		res.status(201).json(adminMutationEnvelope(result, { actorId: req.user.userId, action: "institution.create" }));
	} catch (err) {
		next(err);
	}
};

export const getInstitution = async (req, res, next) => {
	try {
		const result = await institutionService.getInstitution(req.params.institutionId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const listInstitutions = async (req, res, next) => {
	try {
		const result = await institutionService.listInstitutions(req.query);
		res.json(adminListEnvelope(result.items, result.nextCursor));
	} catch (err) {
		next(err);
	}
};

export const updateInstitution = async (req, res, next) => {
	try {
		const result = await institutionService.updateInstitution(req.user.userId, req.params.institutionId, req.body);
		res.json(adminMutationEnvelope(result, { actorId: req.user.userId, action: "institution.update" }));
	} catch (err) {
		next(err);
	}
};

export const deactivateInstitution = async (req, res, next) => {
	try {
		const result = await institutionService.deactivateInstitution(req.user.userId, req.params.institutionId);
		res.json(adminMutationEnvelope(result, { actorId: req.user.userId, action: "institution.deactivate" }));
	} catch (err) {
		next(err);
	}
};

export const reactivateInstitution = async (req, res, next) => {
	try {
		const result = await institutionService.reactivateInstitution(req.user.userId, req.params.institutionId);
		res.json(adminMutationEnvelope(result, { actorId: req.user.userId, action: "institution.reactivate" }));
	} catch (err) {
		next(err);
	}
};
