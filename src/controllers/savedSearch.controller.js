// src/controllers/savedSearch.controller.js

import * as savedSearchService from "../services/savedSearch.service.js";

export const create = async (req, res, next) => {
	try {
		const result = await savedSearchService.createSavedSearch(req.user.userId, req.body);
		res.status(201).json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const list = async (req, res, next) => {
	try {
		const result = await savedSearchService.listSavedSearches(req.user.userId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const update = async (req, res, next) => {
	try {
		const result = await savedSearchService.updateSavedSearch(req.user.userId, req.params.searchId, req.body);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const remove = async (req, res, next) => {
	try {
		const result = await savedSearchService.deleteSavedSearch(req.user.userId, req.params.searchId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};
