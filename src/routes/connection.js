























import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { connectionParamsSchema, getMyConnectionsSchema } from "../validators/connection.validators.js";
import * as connectionController from "../controllers/connection.controller.js";

export const connectionRouter = Router();







connectionRouter.get("/me", authenticate, validate(getMyConnectionsSchema), connectionController.getMyConnections);







connectionRouter.get(
	"/:connectionId",
	authenticate,
	validate(connectionParamsSchema),
	connectionController.getConnection,
);





connectionRouter.post(
	"/:connectionId/confirm",
	authenticate,
	validate(connectionParamsSchema),
	connectionController.confirmConnection,
);
