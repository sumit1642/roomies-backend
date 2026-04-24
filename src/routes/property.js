

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import {
	propertyParamsSchema,
	listPropertiesSchema,
	createPropertySchema,
	updatePropertySchema,
} from "../validators/property.validators.js";
import * as propertyController from "../controllers/property.controller.js";

export const propertyRouter = Router();







propertyRouter.get("/:propertyId", authenticate, validate(propertyParamsSchema), propertyController.getProperty);















propertyRouter.get(
	"/",
	authenticate,
	authorize("pg_owner"),
	validate(listPropertiesSchema),
	propertyController.listProperties,
);

propertyRouter.post(
	"/",
	authenticate,
	authorize("pg_owner"),
	validate(createPropertySchema),
	propertyController.createProperty,
);

propertyRouter.put(
	"/:propertyId",
	authenticate,
	authorize("pg_owner"),
	validate(updatePropertySchema),
	propertyController.updateProperty,
);

propertyRouter.delete(
	"/:propertyId",
	authenticate,
	authorize("pg_owner"),
	validate(propertyParamsSchema),
	propertyController.deleteProperty,
);
