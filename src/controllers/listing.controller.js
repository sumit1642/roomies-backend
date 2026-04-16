// src/controllers/listing.controller.js

import * as listingService from "../services/listing.service.js";

export const createListing = async (req, res, next) => {
	try {
		const listing = await listingService.createListing(req.user.userId, req.user.roles, req.body);
		res.status(201).json({ status: "success", data: listing });
	} catch (err) {
		next(err);
	}
};

export const getListing = async (req, res, next) => {
	try {
		const listing = await listingService.getListing(req.params.listingId);
		res.json({ status: "success", data: listing });
	} catch (err) {
		next(err);
	}
};

// userId is nullable: req.user is undefined for guests (optionalAuthenticate ran).
// Passing null signals the service to skip compatibility scoring.
export const searchListings = async (req, res, next) => {
	try {
		const userId = req.user?.userId ?? null;
		const result = await listingService.searchListings(userId, req.query);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const updateListing = async (req, res, next) => {
	try {
		const listing = await listingService.updateListing(req.user.userId, req.params.listingId, req.body);
		res.json({ status: "success", data: listing });
	} catch (err) {
		next(err);
	}
};

export const deleteListing = async (req, res, next) => {
	try {
		const result = await listingService.deleteListing(req.user.userId, req.params.listingId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const updateListingStatus = async (req, res, next) => {
	try {
		const result = await listingService.updateListingStatus(req.user.userId, req.params.listingId, req.body.status);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const getListingPreferences = async (req, res, next) => {
	try {
		const preferences = await listingService.getListingPreferences(req.params.listingId);
		res.json({ status: "success", data: preferences });
	} catch (err) {
		next(err);
	}
};

export const updateListingPreferences = async (req, res, next) => {
	try {
		const preferences = await listingService.updateListingPreferences(
			req.user.userId,
			req.params.listingId,
			req.body.preferences,
		);
		res.json({ status: "success", data: preferences });
	} catch (err) {
		next(err);
	}
};

export const saveListing = async (req, res, next) => {
	try {
		const result = await listingService.saveListing(req.user.userId, req.params.listingId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const unsaveListing = async (req, res, next) => {
	try {
		const result = await listingService.unsaveListing(req.user.userId, req.params.listingId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const getSavedListings = async (req, res, next) => {
	try {
		const { cursorTime, cursorId, limit } = req.query;
		const result = await listingService.getSavedListings(req.user.userId, {
			cursorTime,
			cursorId,
			limit: limit ? Number(limit) : undefined,
		});
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};
