// src/routes/adminUser.js
//
// ADR-016 Phase 2. Mounted at /admin/users in routes/index.js.
// Every route here is admin-only — see requireAdmin.js (email-verified AND
// role === 'admin').

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { validate } from "../middleware/validate.js";
import {
	getUserDetailSchema,
	listUsersSchema,
	setUserAccountStatusSchema,
} from "../validators/adminUser.validators.js";
import * as adminUserController from "../controllers/adminUser.controller.js";

export const adminUserRouter = Router();

adminUserRouter.get("/", authenticate, ...requireAdmin, validate(listUsersSchema), adminUserController.listUsers);

adminUserRouter.get(
	"/:userId",
	authenticate,
	...requireAdmin,
	validate(getUserDetailSchema),
	adminUserController.getUserDetail,
);

adminUserRouter.patch(
	"/:userId/status",
	authenticate,
	...requireAdmin,
	validate(setUserAccountStatusSchema),
	adminUserController.setUserAccountStatus,
);
