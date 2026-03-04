// src/storage/adapters/localDisk.js
//
// Local filesystem storage adapter for development.
// Writes compressed WebP files to /uploads/listings/{listingId}/ on disk.
// Express already serves /uploads statically in development (wired in app.js),
// so files written here are immediately accessible via HTTP with no extra config.
//
// This adapter is never used in production. STORAGE_ADAPTER=local in .env.local
// selects it; STORAGE_ADAPTER=azure in .env.azure selects the Azure adapter.
// Neither the service nor the worker ever inspects which adapter is active —
// they only call upload() and delete() on the storageService singleton.

import fs from "fs/promises";
import path from "path";
import { logger } from "../../logger/index.js";

export class LocalDiskAdapter {
	// base is the root directory under which all listing photo subdirectories
	// are created. Defaults to the project-root /uploads folder that Express
	// already serves statically. Accepting it as a constructor param makes
	// tests trivial — pass a temp directory and no real files are created.
	constructor(base = "uploads") {
		this.base = base;
	}

	// Writes a Buffer of compressed image data to disk at:
	//   {base}/listings/{listingId}/{filename}
	//
	// Returns a URL string that can be stored in listing_photos.photo_url and
	// resolved by any HTTP client against the dev server's base URL.
	//
	// fs.mkdir with { recursive: true } is idempotent — it creates any missing
	// intermediate directories and is a no-op if the directory already exists.
	// This is called inside upload() rather than the constructor because the
	// listingId-scoped subdirectory cannot be known at construction time.
	async upload(buffer, listingId, filename) {
		const dir = path.join(this.base, "listings", listingId);
		await fs.mkdir(dir, { recursive: true });

		const filePath = path.join(dir, filename);
		await fs.writeFile(filePath, buffer);

		// Return a root-relative URL. Express serves /uploads at the root, so
		// /uploads/listings/{listingId}/{filename} resolves correctly in dev.
		const url = `/uploads/listings/${listingId}/${filename}`;
		logger.debug({ url }, "LocalDiskAdapter: file written");
		return url;
	}

	// Deletes the file at the path derived from the stored URL.
	// The URL is always root-relative (/uploads/...) so we strip the leading
	// slash and resolve against the project root to get the filesystem path.
	//
	// fs.unlink throws ENOENT if the file is already gone. We swallow that
	// specific error — a missing file is not a meaningful failure for a delete
	// operation (the desired end state, "file does not exist," is already true).
	// All other errors are re-thrown so the caller's error handler sees them.
	async delete(url) {
		// Strip leading slash to make the path relative to cwd (project root)
		const filePath = url.startsWith("/") ? url.slice(1) : url;
		try {
			await fs.unlink(filePath);
			logger.debug({ url }, "LocalDiskAdapter: file deleted");
		} catch (err) {
			if (err.code === "ENOENT") {
				// File already gone — treat as success
				logger.debug({ url }, "LocalDiskAdapter: file already absent, skipping delete");
				return;
			}
			throw err;
		}
	}
}
