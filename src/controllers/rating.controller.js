// src/controllers/rating.controller.js
//
// Thin controller wrappers — no business logic here. All validation has already
// run via the validate() middleware; all service functions throw AppError on
// any known failure and the global error handler converts those to the correct
// HTTP status codes.

import * as ratingService from "../services/rating.service.js";

// POST /api/v1/ratings
// Submit a rating for a user or property, anchored to a confirmed connection.
// Returns 201 with { ratingId, createdAt } on success.
// Possible error codes from the service:
//   404 — reviewee not found, or connection not found / caller not a party
//   409 — rating already submitted for this (reviewer, connection, reviewee) triple
//   422 — connection exists but confirmation_status is not 'confirmed'
export const submitRating = async (req, res, next) => {
	try {
		const result = await ratingService.submitRating(req.user.userId, req.body);
		res.status(201).json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

// GET /api/v1/ratings/connection/:connectionId
// Returns both ratings for a connection from the caller's perspective:
//   { myRating: Rating | null, theirRating: Rating | null }
// Only the two connection parties can call this. Third parties get 404.
export const getRatingsForConnection = async (req, res, next) => {
	try {
		const result = await ratingService.getRatingsForConnection(req.user.userId, req.params.connectionId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

// GET /api/v1/ratings/user/:userId
// Public rating history for any user. No authentication required at the route
// level — the service enforces no caller-identity check. Returns paginated
// ratings the user has received (reviewee_type = 'user').
export const getPublicRatings = async (req, res, next) => {
	try {
		const result = await ratingService.getPublicRatings(req.params.userId, req.query);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

// GET /api/v1/ratings/me/given
// The authenticated user's full history of ratings they have submitted.
// Keyset paginated, newest first. Includes reviewee summary (name, photo, type).
export const getMyGivenRatings = async (req, res, next) => {
	try {
		const result = await ratingService.getMyGivenRatings(req.user.userId, req.query);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

// GET /api/v1/ratings/property/:propertyId
// Public rating history for a property. No authentication required.
// Returns paginated ratings the property has received (reviewee_type = 'property').
// 404 if the property doesn't exist or is soft-deleted.
export const getPublicPropertyRatings = async (req, res, next) => {
	try {
		const result = await ratingService.getPublicPropertyRatings(req.params.propertyId, req.query);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};
