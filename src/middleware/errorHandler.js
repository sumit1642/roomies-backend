import { logger } from "../logger/index.js";
import { MAX_UPLOAD_SIZE_BYTES, UPLOAD_FIELD_NAME } from "../config/constants.js";

const formatBytesToHumanReadable = (bytes) => {
	const units = ["B", "KB", "MB", "GB", "TB"];
	if (!Number.isFinite(bytes) || bytes <= 0) return "0B";

	const power = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1));
	const value = bytes / 1024 ** power;
	const rounded = Number.isInteger(value) ? value.toString() : value.toFixed(1);

	return `${rounded}${units[power]}`;
};

export class AppError extends Error {
	constructor(message, statusCode = 500) {
		super(message);
		this.statusCode = statusCode;
		this.isOperational = true;
	}
}

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
	if (res.headersSent) {
		return next(err);
	}

	// Zod v4 validation errors — format all issues into field/message pairs.
	if (err.name === "ZodError") {
		logger.warn(
			{
				req: { method: req.method, url: req.url },
				validationErrors: err.issues.map((issue) => ({
					field: issue.path.join("."),
					message: issue.message,
				})),
			},
			"Request validation failed",
		);

		return res.status(400).json({
			status: "error",
			message: "Validation failed",
			errors: err.issues.map((issue) => ({
				field: issue.path.join("."),
				message: issue.message,
			})),
		});
	}

	// Multer upload errors. Each branch logs the specific Multer error code and
	// message so upload failures are diagnosable without reading raw stack traces.
	if (err.name === "MulterError") {
		if (err.code === "LIMIT_FILE_SIZE") {
			logger.warn(
				{
					req: { method: req.method, url: req.url },
					multerCode: err.code,
					multerMessage: err.message,
					maxSizeBytes: MAX_UPLOAD_SIZE_BYTES,
					maxSizeHuman: formatBytesToHumanReadable(MAX_UPLOAD_SIZE_BYTES),
				},
				"Upload rejected: file too large",
			);
			return res.status(413).json({
				status: "error",
				message: `File is too large. Maximum allowed size is ${formatBytesToHumanReadable(
					MAX_UPLOAD_SIZE_BYTES,
				)}`,
			});
		}

		if (err.code === "LIMIT_UNEXPECTED_FILE") {
			logger.warn(
				{
					req: { method: req.method, url: req.url },
					multerCode: err.code,
					multerMessage: err.message,
					expectedField: UPLOAD_FIELD_NAME,
				},
				"Upload rejected: unexpected file field",
			);
			return res.status(400).json({
				status: "error",
				message: `Unexpected file field. Use field name '${UPLOAD_FIELD_NAME}'`,
			});
		}

		// Unknown Multer error — log the full code and message so it is not lost.
		logger.warn(
			{
				req: { method: req.method, url: req.url },
				multerCode: err.code,
				multerMessage: err.message,
				err,
			},
			"Upload rejected: unknown Multer error",
		);
		return res.status(400).json({
			status: "error",
			message: "Invalid upload payload",
		});
	}

	if (err.isOperational) {
		return res.status(err.statusCode).json({
			status: "error",
			message: err.message,
		});
	}

	if (err.code === "23505")
		return res.status(409).json({ status: "error", message: "A record with this value already exists" });
	if (err.code === "23503")
		return res.status(409).json({ status: "error", message: "Referenced record does not exist" });
	if (err.code === "23514")
		return res.status(400).json({ status: "error", message: "Data failed a database constraint check" });

	if (err.name === "JsonWebTokenError") return res.status(401).json({ status: "error", message: "Invalid token" });
	if (err.name === "TokenExpiredError")
		return res.status(401).json({ status: "error", message: "Token has expired" });

	logger.error({ err, req: { method: req.method, url: req.url } }, "Unhandled error");
	return res.status(500).json({ status: "error", message: "An unexpected error occurred" });
};
