// src/routes/pgOwner.js

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { getPgOwnerParamsSchema, updatePgOwnerSchema } from "../validators/pgOwner.validators.js";
import { submitDocumentSchema } from "../validators/verification.validators.js";
import * as pgOwnerController from "../controllers/pgOwner.controller.js";
import * as verificationController from "../controllers/verification.controller.js";

export const pgOwnerRouter = Router();

// GET is intentionally readable by any authenticated user — students need to
// view PG owner profiles to evaluate listings and credibility.
pgOwnerRouter.get("/:userId/profile", authenticate, validate(getPgOwnerParamsSchema), pgOwnerController.getProfile);

// PUT is restricted to pg_owner role — no other role has a legitimate reason to
// update a PG owner's business profile. authorize('pg_owner') rejects a wrong-role
// caller at the middleware layer before validation or any DB work happens.
// The service adds a second independent check (requestingUserId === targetUserId)
// so a pg_owner cannot update another pg_owner's profile either.
pgOwnerRouter.put(
	"/:userId/profile",
	authenticate,
	authorize("pg_owner"),
	validate(updatePgOwnerSchema),
	pgOwnerController.updateProfile,
);

// Document submission for PG owner verification.
//
// Two independent guards protect this route:
//
//   1. authorize('pg_owner') — checks req.user.roles to confirm the caller
//      actually holds the pg_owner role. A student JWT reaches this middleware
//      and is rejected before any DB work happens.
//
//   2. Service-layer ownership + profile existence check — verifies the
//      authenticated user matches :userId AND that a pg_owner_profiles row
//      actually exists for them. This catches data-integrity edge cases that
//      the role check alone cannot see (e.g. role exists but profile row was
//      deleted, or the JWT userId doesn't match the :userId param).
//
// These two guards address different failure modes and neither is redundant:
// authorize() catches the wrong-role case at the middleware layer (zero DB cost);
// the service check catches integrity anomalies after the role is confirmed.
pgOwnerRouter.post(
	"/:userId/documents",
	authenticate,
	authorize("pg_owner"),
	validate(submitDocumentSchema),
	verificationController.submitDocument,
);
