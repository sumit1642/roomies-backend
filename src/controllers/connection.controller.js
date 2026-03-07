// src/controllers/connection.controller.js

import * as connectionService from "../services/connection.service.js";

// POST /api/v1/connections/:connectionId/confirm
//
// Either party calls this endpoint to record that the real-world interaction
// happened from their side. The service determines which flag to flip by
// comparing req.user.userId against the two party IDs on the row. No role
// restriction at the route level — both students and PG owners participate
// in two-sided confirmation.
export const confirmConnection = async (req, res, next) => {
	try {
		const result = await connectionService.confirmConnection(req.user.userId, req.params.connectionId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

// GET /api/v1/connections/:connectionId
//
// Full detail for one connection. Both parties can see the full shape including
// both confirmation flags — so each party knows whether the other has confirmed
// yet. Third parties receive 404 (enforced in service via WHERE clause).
export const getConnection = async (req, res, next) => {
	try {
		const result = await connectionService.getConnection(req.user.userId, req.params.connectionId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

// GET /api/v1/connections/me
//
// The authenticated user's full connection dashboard — all connections they are
// a party to, regardless of role. Supports filtering and keyset pagination.
export const getMyConnections = async (req, res, next) => {
	try {
		const result = await connectionService.getMyConnections(req.user.userId, req.query);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};
