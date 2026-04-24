




























import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import {
	interestParamsSchema,
	updateInterestStatusSchema,
	getMyInterestsSchema,
} from "../validators/interest.validators.js";
import * as interestController from "../controllers/interest.controller.js";

export const interestRouter = Router();






interestRouter.get(
	"/me",
	authenticate,
	authorize("student"),
	validate(getMyInterestsSchema),
	interestController.getMyInterestRequests,
);








interestRouter.get("/:interestId", authenticate, validate(interestParamsSchema), interestController.getInterestRequest);







interestRouter.patch(
	"/:interestId/status",
	authenticate,
	validate(updateInterestStatusSchema),
	interestController.updateInterestStatus,
);
