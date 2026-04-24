import multer from "multer";
import path from "path";
import crypto from "crypto";
import fs from "fs/promises";
import { AppError } from "./errorHandler.js";
import { MAX_UPLOAD_SIZE_BYTES } from "../config/constants.js";



const MIME_TO_EXTENSIONS = {
	"image/jpeg": [".jpg", ".jpeg"],
	"image/png": [".png"],
	"image/webp": [".webp"],
};

const ALLOWED_MIME_TYPES = new Set(Object.keys(MIME_TO_EXTENSIONS));

const storage = multer.diskStorage({
	destination: async (_req, _file, cb) => {
		try {
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
		fileSize: MAX_UPLOAD_SIZE_BYTES,
		files: 1,
	},
});
