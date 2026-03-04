// src/middleware/upload.js
//
// Multer configuration for listing photo uploads.
//
// Multer's job is narrow and well-defined: receive the multipart/form-data
// request, parse the file stream, write the raw bytes to a staging location,
// and attach the file metadata to req.file. That is all it does. Compression,
// resizing, and final-destination storage are handled separately — by Sharp
// and the StorageAdapter — in the BullMQ worker after the HTTP response has
// already been sent.
//
// WHY A STAGING DIRECTORY?
// Multer writes the raw uploaded file (could be a 8MB JPEG fresh from a phone
// camera). Sharp then reads that file, resizes it, converts it to WebP, and
// produces a much smaller output buffer. These are two different files at two
// different paths. If Multer wrote directly to the final destination, Sharp's
// output would need to overwrite it — which requires the final path to be
// known at request time, before the worker runs. Keeping them separate is
// cleaner: Multer always writes to /uploads/staging/, the worker reads from
// staging, writes the compressed result to /uploads/listings/{listingId}/,
// and then deletes the staging file.
//
// WHY diskStorage AND NOT memoryStorage?
// memoryStorage holds the raw file bytes in a Buffer in process heap memory.
// For a 10MB JPEG, that means 10MB of heap pressure per concurrent upload.
// With diskStorage the bytes go to disk immediately — the Node.js heap only
// holds a small file descriptor and metadata object. Under concurrent uploads
// this difference is significant. The staging file is temporary (deleted by
// the worker after processing) so the disk usage is also transient.

import multer from "multer";
import path from "path";
import crypto from "crypto";
import { AppError } from "./errorHandler.js";

// Allowlisted MIME types. We check mimetype at the Multer layer as a fast
// pre-filter. This is not a security guarantee — a malicious actor can set
// any mimetype header they like. The real safety net is Sharp: it will throw
// when it tries to decode something that is not actually an image, and the
// worker's error handler will move the job to the failed queue. The mimetype
// filter here just improves the developer and user experience by returning
// a clear 400 early rather than a cryptic Sharp error later.
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

// Maximum raw file size: 10MB. This is enforced at the HTTP streaming layer
// by Multer — the connection is aborted before the file is fully written to
// disk, so a 2GB upload never consumes 2GB of staging space. The limit is
// generous enough to accommodate full-resolution JPEG exports from modern
// smartphones while still being a meaningful bound against abuse.
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

// Multer diskStorage configuration.
// destination: always the staging directory — not listingId-scoped because
//   we don't know listingId at Multer configuration time (it comes from
//   req.params, which Multer receives but the destination function can also
//   access via the `req` argument).
// filename: UUID + original extension. UUID prevents any collision between
//   concurrent uploads from different users. Preserving the extension helps
//   with debugging — you can open a staging file and immediately know its
//   original format.
const storage = multer.diskStorage({
	destination: (_req, _file, cb) => {
		cb(null, "uploads/staging");
	},
	filename: (_req, file, cb) => {
		const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
		const name = `${crypto.randomUUID()}${ext}`;
		cb(null, name);
	},
});

// fileFilter runs before any bytes are written to disk.
// Returning cb(null, false) rejects the file without writing it.
// Returning cb(error) causes Multer to pass the error through to next(),
// which our global error handler picks up and returns as a 400.
const fileFilter = (_req, file, cb) => {
	if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
		cb(null, true);
	} else {
		cb(new AppError(`Unsupported file type: ${file.mimetype}. Accepted types: JPEG, PNG, WebP`, 400));
	}
};

// The configured Multer instance, exported for use in photo routes.
// upload.single('photo') is the correct call at the route level — it tells
// Multer to accept exactly one file under the field name 'photo'.
// Accepting a field name other than 'photo' silently results in req.file
// being undefined, which the controller checks and rejects with a clear 400.
export const upload = multer({
	storage,
	fileFilter,
	limits: {
		fileSize: MAX_FILE_SIZE_BYTES,
		files: 1, // Belt-and-suspenders: reject multi-file requests at the Multer level
	},
});
