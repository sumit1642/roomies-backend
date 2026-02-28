// src/middleware/authorize.js

import { AppError } from "./errorHandler.js";

// Role gate — must run after authenticate (req.user must exist).
// Usage: router.get('/queue', authenticate, authorize('admin'), controller.fn)
//
// If req.user is missing entirely it means authorize() was placed on a route
// without authenticate() — that is a programming error, not an auth failure.
export const authorize = (role) => (req, res, next) => {
	if (!req.user) {
		return next(new AppError("authenticate middleware must run before authorize", 500));
	}

	if (!req.user.roles.includes(role)) {
		return next(new AppError("Forbidden", 403));
	}

	next();
};
