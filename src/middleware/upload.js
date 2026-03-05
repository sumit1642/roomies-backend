// src/middleware/upload.js

import multer from "multer";
import path from "path";
import crypto from "crypto";
import fs from "fs/promises";
import { AppError } from "./errorHandler.js";

// Maps each allowed MIME type to its valid file extensions.
// Used to catch obvious mismatches like a .txt file claiming image/jpeg.
const MIME_TO_EXTENSIONS = {
	"image/jpeg": [".jpg", ".jpeg"],
	"image/png": [".png"],
	"image/webp": [".webp"],
};

// Derived from MIME_TO_EXTENSIONS so a new entry in the map automatically
// becomes an allowed type — no second list to keep in sync.
const ALLOWED_MIME_TYPES = new Set(Object.keys(MIME_TO_EXTENSIONS));

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

const storage = multer.diskStorage({
	destination: async (_req, _file, cb) => {
		try {
			// Ensure the staging directory exists before Multer tries to write.
			// recursive: true makes this a no-op if the directory already exists,
			// so it's safe to call on every upload without a prior existence check.
			await fs.mkdir("uploads/staging", { recursive: true });
			cb(null, "uploads/staging");
		} catch (err) {
			cb(err);
		}
	},
	filename: (_req, file, cb) => {
		const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
		const name = `${crypto.randomUUID()}${ext}`;
		cb(null, name);
	},
});

const fileFilter = (_req, file, cb) => {
	if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
		return cb(new AppError(`Unsupported file type: ${file.mimetype}. Accepted types: JPEG, PNG, WebP`, 400));
	}

	// A client can lie about mimetype. Cross-check the file extension against
	// what's expected for the claimed MIME type to catch obvious mismatches
	// (e.g. a .txt file with Content-Type: image/jpeg).
	const ext = path.extname(file.originalname).toLowerCase();
	const allowedExts = MIME_TO_EXTENSIONS[file.mimetype];
	if (!allowedExts.includes(ext)) {
		return cb(
			new AppError(
				`File extension '${ext}' does not match declared type '${file.mimetype}'. ` +
					`Expected: ${allowedExts.join(", ")}`,
				400,
			),
		);
	}

	cb(null, true);
};

export const upload = multer({
	storage,
	fileFilter,
	limits: {
		fileSize: MAX_FILE_SIZE_BYTES,
		files: 1,
	},
});
