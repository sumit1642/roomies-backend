// src/storage/adapters/azureBlob.js
//
// Azure Blob Storage adapter — production implementation.
//
// Fixes applied:
//   Fix 7 — upload() now aborts after UPLOAD_TIMEOUT_MS (30s) via AbortController
//            to prevent the worker from hanging indefinitely on a slow/stalled
//            Azure connection.
//   Fix 8 — delete() strips query-string and fragment from the URL before
//            extracting the blob path, so SAS tokens or CDN cache-busters in
//            the stored URL don't cause a path mismatch.

import { BlobServiceClient } from "@azure/storage-blob";
import { config } from "../../config/env.js";
import { logger } from "../../logger/index.js";
import { AppError } from "../../middleware/errorHandler.js";

// Maximum time allowed for a single upload before we abort and let the worker
// retry. 30 seconds is generous for a WebP thumbnail (rarely exceeds a few
// hundred kilobytes) but short enough to surface a hung connection promptly.
const UPLOAD_TIMEOUT_MS = 30_000;

export class AzureBlobAdapter {
	constructor() {
		if (!config.AZURE_STORAGE_CONNECTION_STRING) {
			throw new AppError(
				"AZURE_STORAGE_CONNECTION_STRING is required when STORAGE_ADAPTER=azure. " +
					"Add it to your .env.azure file or Azure App Service application settings.",
				500,
			);
		}
		if (!config.AZURE_STORAGE_CONTAINER) {
			throw new AppError(
				"AZURE_STORAGE_CONTAINER is required when STORAGE_ADAPTER=azure. " +
					"Add it to your .env.azure file or Azure App Service application settings.",
				500,
			);
		}

		this.client = BlobServiceClient.fromConnectionString(config.AZURE_STORAGE_CONNECTION_STRING);
		this.container = this.client.getContainerClient(config.AZURE_STORAGE_CONTAINER);

		logger.info({ container: config.AZURE_STORAGE_CONTAINER }, "AzureBlobAdapter initialised");
	}

	// Uploads a compressed WebP buffer to Azure Blob Storage.
	//
	// An AbortController drives the timeout. The controller's signal is passed
	// to uploadData() so Azure's SDK cancels the in-flight HTTP request (not just
	// the JS-side promise). The timer is cleared in a finally block so it doesn't
	// keep the event loop alive if the upload finishes before the deadline.
	async upload(buffer, listingId, filename) {
		const blobPath = `listings/${listingId}/${filename}`;
		const blockBlobClient = this.container.getBlockBlobClient(blobPath);

		const controller = new AbortController();
		const timer = setTimeout(() => {
			controller.abort();
		}, UPLOAD_TIMEOUT_MS);

		try {
			await blockBlobClient.uploadData(buffer, {
				abortSignal: controller.signal,
				blobHTTPHeaders: {
					blobContentType: "image/webp",
					blobCacheControl: "public, max-age=31536000, immutable",
				},
			});

			const url = blockBlobClient.url;
			logger.debug({ blobPath, url }, "AzureBlobAdapter: blob uploaded");
			return url;
		} catch (err) {
			// AbortController fires a DOMException with name "AbortError".
			if (err.name === "AbortError") {
				logger.error({ blobPath, timeoutMs: UPLOAD_TIMEOUT_MS }, "AzureBlobAdapter: upload timed out");
				throw new AppError(`Photo upload timed out after ${UPLOAD_TIMEOUT_MS / 1000}s — please try again`, 504);
			}
			logger.error({ err, blobPath }, "AzureBlobAdapter: upload failed");
			throw new AppError("Failed to upload photo to Azure Blob Storage — try again shortly", 502);
		} finally {
			// Clear the timer whether the upload succeeded, failed, or timed out so
			// the handle does not keep the Node.js event loop alive unnecessarily.
			clearTimeout(timer);
		}
	}

	// Deletes a blob from Azure Blob Storage given its full HTTPS URL.
	//
	// Before extracting the blob path we strip any query-string or fragment from
	// the URL. Azure Blob Storage URLs returned by blockBlobClient.url are pure
	// paths, but in practice the stored URL might carry a SAS token
	// (?sv=2021-06-08&...) added by a CDN layer or a previous code version.
	// Without stripping, containerPrefix.indexOf() still matches (the container
	// name is in the path portion), but the sliced blobPath would be
	// "listings/id/file.webp?sv=..." which doesn't match any real blob name.
	async delete(url) {
		// Strip query string and fragment to obtain the pure path-only URL.
		// Using the WHATWG URL API is safer than splitting on '?' because it
		// handles edge cases like encoded query characters correctly.
		let pathOnlyUrl = url;
		try {
			const parsed = new URL(url);
			// Reconstruct origin + pathname — drop search and hash entirely.
			pathOnlyUrl = `${parsed.origin}${parsed.pathname}`;
		} catch {
			// If url is somehow not a valid URL (e.g. a relative path in tests),
			// fall through with the original string; the containerPrefix check below
			// will handle it gracefully.
		}

		const containerPrefix = `/${config.AZURE_STORAGE_CONTAINER}/`;
		const containerIndex = pathOnlyUrl.indexOf(containerPrefix);

		if (containerIndex === -1) {
			logger.warn({ url }, "AzureBlobAdapter: could not extract blob path from URL — skipping delete");
			return;
		}

		const blobPath = pathOnlyUrl.slice(containerIndex + containerPrefix.length);
		const blockBlobClient = this.container.getBlockBlobClient(blobPath);

		try {
			await blockBlobClient.deleteIfExists();
			logger.debug({ blobPath }, "AzureBlobAdapter: blob deleted");
		} catch (err) {
			logger.error({ err, blobPath }, "AzureBlobAdapter: delete failed");
			throw new AppError("Failed to delete photo from Azure Blob Storage", 502);
		}
	}
}
