// src/routes/connection.js
//
// Mounted at /api/v1/connections.
//
// ─── ROUTE REGISTRATION ORDER ────────────────────────────────────────────────
// Express matches routes in registration order. The static segment /me must be
// registered BEFORE the parameterised segment /:connectionId, otherwise a GET
// to /connections/me would match /:connectionId with connectionId = "me", fail
// UUID validation in the schema, and return a 400 instead of the dashboard.
//
// This is the same ordering discipline applied in listing.js (/me/saved before
// /:listingId) and interest.js (/me before /:interestId).
//
// ─── ROUTE SURFACE ───────────────────────────────────────────────────────────
//
//   GET  /connections/me                      — user's connection dashboard feed
//   GET  /connections/:connectionId           — single connection detail
//   POST /connections/:connectionId/confirm   — flip caller's confirmation flag
//
// There is intentionally no POST /connections — connections are created
// exclusively by the interest service inside the accepted-transition transaction.
// Exposing a creation endpoint would allow connections to be created outside the
// trust pipeline, which would undermine the anti-fake-review guarantee.

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { connectionParamsSchema, getMyConnectionsSchema } from "../validators/connection.validators.js";
import * as connectionController from "../controllers/connection.controller.js";

export const connectionRouter = Router();

// ─── Static routes first ──────────────────────────────────────────────────────

// GET /api/v1/connections/me — the user's full connection history.
// No role restriction — both students and PG owners have connections. The
// service queries WHERE (initiator_id = $1 OR counterpart_id = $1) so the
// authenticated user always sees only their own connections.
connectionRouter.get("/me", authenticate, validate(getMyConnectionsSchema), connectionController.getMyConnections);

// ─── Parameterised routes after all static routes ─────────────────────────────

// GET /api/v1/connections/:connectionId — single connection detail.
// No role restriction — both parties need this endpoint (to check the other's
// confirmation status, to get the listing summary, etc.). Third parties get
// 404 enforced in the service via WHERE clause, not a 403.
connectionRouter.get(
	"/:connectionId",
	authenticate,
	validate(connectionParamsSchema),
	connectionController.getConnection,
);

// POST /api/v1/connections/:connectionId/confirm — flip caller's confirmation flag.
// No role restriction — both the student (initiator) and the PG owner
// (counterpart) confirm via the same endpoint. The service resolves which
// flag belongs to the caller from the row itself.
connectionRouter.post(
	"/:connectionId/confirm",
	authenticate,
	validate(connectionParamsSchema),
	connectionController.confirmConnection,
);
