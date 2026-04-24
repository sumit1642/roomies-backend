

import * as propertyService from "../services/property.service.js";

export const createProperty = async (req, res, next) => {
	try {
		const property = await propertyService.createProperty(req.user.userId, req.body);
		res.status(201).json({ status: "success", data: property });
	} catch (err) {
		next(err);
	}
};

export const getProperty = async (req, res, next) => {
	try {
		const property = await propertyService.getProperty(req.params.propertyId);
		res.json({ status: "success", data: property });
	} catch (err) {
		next(err);
	}
};

export const listProperties = async (req, res, next) => {
	try {
		const { cursorTime, cursorId, limit } = req.query;
		const result = await propertyService.listProperties(req.user.userId, {
			cursorTime,
			cursorId,
			limit: limit ? Number(limit) : undefined,
		});
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const updateProperty = async (req, res, next) => {
	try {
		const property = await propertyService.updateProperty(req.user.userId, req.params.propertyId, req.body);
		res.json({ status: "success", data: property });
	} catch (err) {
		next(err);
	}
};

export const deleteProperty = async (req, res, next) => {
	try {
		const result = await propertyService.deleteProperty(req.user.userId, req.params.propertyId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};
