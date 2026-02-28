import { logger } from "../logger/index.js";

// AppError is the base class for all known, intentional errors.
// Any error thrown with new AppError(...) gets a clean JSON response.
// Anything else (unexpected errors) gets a generic 500.
export class AppError extends Error {
	constructor(message, statusCode = 500) {
		super(message);
		this.statusCode = statusCode;
		this.isOperational = true; // marks this as a known, handled error
	}
}

// Must have exactly 4 parameters for Express to recognise it as an error handler.
// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
	// Zod validation errors — thrown by our validate() middleware
	if (err.name === "ZodError") {
		return res.status(400).json({
			status: "error",
			message: "Validation failed",
			errors: err.issues.map((issue) => ({
				field: issue.path.join("."),
				message: issue.message,
			})),
		});
	}

	// Known operational errors — thrown deliberately with AppError
	if (err.isOperational) {
		return res.status(err.statusCode).json({
			status: "error",
			message: err.message,
		});
	}

	// PostgreSQL unique constraint violation
	if (err.code === "23505") {
		return res.status(409).json({
			status: "error",
			message: "A record with this value already exists",
		});
	}

	// PostgreSQL foreign key violation
	if (err.code === "23503") {
		return res.status(409).json({
			status: "error",
			message: "Referenced record does not exist",
		});
	}

	// PostgreSQL check constraint violation
	if (err.code === "23514") {
		return res.status(400).json({
			status: "error",
			message: "Data failed a database constraint check",
		});
	}

	// JWT errors
	if (err.name === "JsonWebTokenError") {
		return res.status(401).json({
			status: "error",
			message: "Invalid token",
		});
	}

	if (err.name === "TokenExpiredError") {
		return res.status(401).json({
			status: "error",
			message: "Token has expired",
		});
	}

	// Unknown / unexpected errors — log the full error, return generic message.
	// Never expose internal error details in production.
	logger.error({ err, req: { method: req.method, url: req.url } }, "Unhandled error");

	return res.status(500).json({
		status: "error",
		message: "An unexpected error occurred",
	});
};
