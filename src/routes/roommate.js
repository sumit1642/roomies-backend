// src/routes/roommate.js

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { AppError } from "../middleware/errorHandler.js";
import {
	getRoommateFeedSchema,
	updateRoommateProfileSchema,
	blockTargetParamsSchema,
} from "../validators/roommate.validators.js";
import * as roommateController from "../controllers/roommate.controller.js";

export const roommateRouter = Router();

// Middleware: authenticated user must match :userId param
const requireSelf = (req, res, next) => {
	if (req.user?.userId !== req.params.userId) {
		return next(new AppError("Forbidden", 403));
	}
	next();
};

// Feed — any authenticated student can browse
roommateRouter.get(
	"/roommates",
	authenticate,
	authorize("student"),
	validate(getRoommateFeedSchema),
	roommateController.getFeed,
);

// Opt-in toggle — own profile only
roommateRouter.put(
	"/:userId/roommate-profile",
	authenticate,
	authorize("student"),
	requireSelf,
	validate(updateRoommateProfileSchema),
	roommateController.updateRoommateProfile,
);

// Block / unblock — :userId must be the authenticated user
roommateRouter.post(
	"/:userId/block/:targetUserId",
	authenticate,
	authorize("student"),
	requireSelf,
	validate(blockTargetParamsSchema),
	roommateController.blockUser,
);

roommateRouter.delete(
	"/:userId/block/:targetUserId",
	authenticate,
	authorize("student"),
	requireSelf,
	validate(blockTargetParamsSchema),
	roommateController.unblockUser,
);
