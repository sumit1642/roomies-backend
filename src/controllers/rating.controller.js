






import * as ratingService from "../services/rating.service.js";








export const submitRating = async (req, res, next) => {
	try {
		const result = await ratingService.submitRating(req.user.userId, req.body);
		res.status(201).json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};





export const getRatingsForConnection = async (req, res, next) => {
	try {
		const result = await ratingService.getRatingsForConnection(req.user.userId, req.params.connectionId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};





export const getPublicRatings = async (req, res, next) => {
	try {
		const result = await ratingService.getPublicRatings(req.params.userId, req.query);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};




export const getMyGivenRatings = async (req, res, next) => {
	try {
		const result = await ratingService.getMyGivenRatings(req.user.userId, req.query);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};





export const getPublicPropertyRatings = async (req, res, next) => {
	try {
		const result = await ratingService.getPublicPropertyRatings(req.params.propertyId, req.query);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};
