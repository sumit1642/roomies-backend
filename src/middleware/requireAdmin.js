// src/middleware/requireAdmin.js
// Composite guard: email verified AND role === 'admin'.
// Use as: router.get('/route', authenticate, ...requireAdmin, handler)

import { authorize } from "./authorize.js";
import { AppError } from "./errorHandler.js";

const assertEmailVerified = (req, res, next) => {
	if (!req.user) {
		// 401 — the caller is unauthenticated, not a server misconfiguration.
		return next(new AppError("Authentication required", 401));
	}
	if (!req.user.isEmailVerified) {
		return next(new AppError("Email verification required", 403));
	}
	next();
};

// Export as an array so callers spread it: `...requireAdmin`
export const requireAdmin = [assertEmailVerified, authorize("admin")];
