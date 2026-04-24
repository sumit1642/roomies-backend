import { AppError } from "./errorHandler.js";









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

		
		
		
		if (!Array.isArray(req.user.roles) || !req.user.roles.includes(role)) {
			return next(new AppError("Forbidden", 403));
		}

		next();
	};
};
