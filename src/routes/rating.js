
















import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { publicRatingsLimiter } from "../middleware/rateLimiter.js";
import { validate } from "../middleware/validate.js";
import {
	submitRatingSchema,
	getRatingsForConnectionSchema,
	getPublicRatingsSchema,
	getMyGivenRatingsSchema,
	getPublicPropertyRatingsSchema,
} from "../validators/rating.validators.js";
import { submitReportSchema } from "../validators/report.validators.js";
import * as ratingController from "../controllers/rating.controller.js";
import * as reportController from "../controllers/report.controller.js";

export const ratingRouter = Router();



ratingRouter.get("/me/given", authenticate, validate(getMyGivenRatingsSchema), ratingController.getMyGivenRatings);




ratingRouter.get(
	"/user/:userId",
	publicRatingsLimiter,
	validate(getPublicRatingsSchema),
	ratingController.getPublicRatings,
);

ratingRouter.get(
	"/property/:propertyId",
	publicRatingsLimiter,
	validate(getPublicPropertyRatingsSchema),
	ratingController.getPublicPropertyRatings,
);

ratingRouter.get(
	"/connection/:connectionId",
	authenticate,
	validate(getRatingsForConnectionSchema),
	ratingController.getRatingsForConnection,
);

ratingRouter.post("/", authenticate, validate(submitRatingSchema), ratingController.submitRating);












ratingRouter.post("/:ratingId/report", authenticate, validate(submitReportSchema), reportController.submitReport);
