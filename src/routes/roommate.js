// src/routes/roommate.js
//
// Mounted inside student.js BEFORE the /:userId param routes to prevent
// "roommates" being captured as a userId.
//
// Route tree (relative to /api/v1/students):
//   GET  /roommates                   — paginated roommate feed
//   PUT  /:userId/roommate-profile    — toggle opt-in + update bio
//   POST /:userId/block/:targetUserId — block a user from your feed
//   DELETE /:userId/block/:targetUserId — unblock

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import {
	getRoommateFeedSchema,
	updateRoommateProfileSchema,
	blockTargetParamsSchema,
} from "../validators/roommate.validators.js";
import * as roommateController from "../controllers/roommate.controller.js";

export const roommateRouter = Router();

// Feed — any authenticated student can browse
roommateRouter.get(
	"/roommates",
	authenticate,
	authorize("student"),
	validate(getRoommateFeedSchema),
	roommateController.getFeed,
);

// Opt-in toggle — own profile only (service layer enforces userId match)
roommateRouter.put(
	"/:userId/roommate-profile",
	authenticate,
	authorize("student"),
	validate(updateRoommateProfileSchema),
	roommateController.updateRoommateProfile,
);

// Block / unblock
roommateRouter.post(
	"/:userId/block/:targetUserId",
	authenticate,
	authorize("student"),
	validate(blockTargetParamsSchema),
	roommateController.blockUser,
);

roommateRouter.delete(
	"/:userId/block/:targetUserId",
	authenticate,
	authorize("student"),
	validate(blockTargetParamsSchema),
	roommateController.unblockUser,
);
