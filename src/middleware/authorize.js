// src/middleware/authorize.js

import { AppError } from "./errorHandler.js";

// Role gate — must run after authenticate (req.user must exist).
// Usage: router.get('/queue', authenticate, authorize('admin'), controller.fn)
//
// The role parameter is validated immediately when authorize(role) is called —
// at route registration time, not per-request. This means a misconfigured route
// (e.g. authorize() or authorize(undefined)) throws at startup rather than
// silently making every request to that route return 403 at runtime.
//
// If req.user is missing entirely it means authorize() was placed on a route
// without authenticate() — that is a programming error, not an auth failure.
export const authorize = (role) => {
	if (!role || typeof role !== "string" || !role.trim()) {
		throw new Error(
			`authorize() requires a non-empty role string — received: ${JSON.stringify(role)}. ` +
				`Check the route registration that calls authorize().`,
		);
	}

	return (req, res, next) => {
		if (!req.user) {
			return next(new AppError("authenticate middleware must run before authorize", 500));
		}

		// Defensive guard: findUserById always returns COALESCE(..., '{}') so roles
		// is always an array, but guard here anyway to prevent a future refactor from
		// causing a silent TypeError instead of a clear 403.
		if (!Array.isArray(req.user.roles) || !req.user.roles.includes(role)) {
			return next(new AppError("Forbidden", 403));
		}

		next();
	};
};
