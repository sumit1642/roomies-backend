// src/routes/property.js

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

// ─── Read routes — any authenticated user ─────────────────────────────────────
//
// GET /:propertyId is intentionally readable by any authenticated user.
// Students need to view property details when evaluating a PG listing —
// the property record is the "building profile" behind the listing card.
// No ownership check here; that check only applies to write operations.
propertyRouter.get("/:propertyId", authenticate, validate(propertyParamsSchema), propertyController.getProperty);

// ─── PG owner routes ──────────────────────────────────────────────────────────
//
// All write operations and the owner's own listing are restricted to the
// pg_owner role. authorize('pg_owner') fires at the middleware layer before
// any validation or DB work — a student JWT is rejected immediately.
//
// The service adds a second, independent layer: assertOwnerVerified checks
// verification_status, and the WHERE owner_id = $N clause on UPDATE/DELETE
// ensures a pg_owner cannot act on another owner's property. Two guards,
// two different failure modes, neither redundant.

// GET / — "my properties" dashboard list. pg_owner only because there is no
// meaningful use case for a student to browse all properties without going
// through listings. This is the management view, not a discovery view.
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
