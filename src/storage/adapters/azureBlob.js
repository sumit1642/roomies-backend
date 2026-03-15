// src/storage/adapters/azureBlob.js
//
// Azure Blob Storage adapter — production implementation.
//
// This adapter is selected when STORAGE_ADAPTER=azure in your env file.
// It stores compressed WebP photos in Azure Blob Storage under the path:
//   listings/{listingId}/{filename}
//
// The interface is identical to LocalDiskAdapter:
//   upload(buffer, listingId, filename) → public HTTPS URL string
//   delete(url)                         → void
//
// Nothing outside this file needs to change when switching from local to Azure.
// The storage/index.js selector and every caller (photo.service.js,
// mediaProcessor.js) only ever call upload() and delete() — they never know
// which adapter is active.
//
// PREREQUISITES:
//   npm install @azure/storage-blob
//
// REQUIRED ENV VARS (add to .env.azure, then to Azure App Service settings):
//   AZURE_STORAGE_CONNECTION_STRING — full connection string from Azure portal
//   AZURE_STORAGE_CONTAINER         — blob container name (e.g. "roomies-uploads")
//
// HOW TO GET YOUR CONNECTION STRING:
//   Azure Portal → Storage Account → Security + networking → Access keys
//   Copy "Connection string" under key1. It looks like:
//   DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net

import { BlobServiceClient } from "@azure/storage-blob";
import { config } from "../../config/env.js";
import { logger } from "../../logger/index.js";
import { AppError } from "../../middleware/errorHandler.js";

export class AzureBlobAdapter {
	constructor() {
		// Fail loudly at startup if credentials are missing when this adapter is
		// selected. This mirrors the Zod env validation philosophy — it is far
		// better to crash immediately with a clear message than to boot successfully
		// and fail silently on the first photo upload hours later.
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

		// BlobServiceClient is the top-level entry point for all Blob Storage
		// operations. fromConnectionString() parses the full Azure connection string
		// and configures authentication, endpoint, and protocol automatically.
		// This client is stateless and safe to share across all upload/delete calls.
		this.client = BlobServiceClient.fromConnectionString(config.AZURE_STORAGE_CONNECTION_STRING);

		// A container is Azure's equivalent of a top-level "bucket" or folder.
		// We get a reference to our specific container here rather than in each
		// method call — the reference is cheap and reusing it avoids redundant
		// string parsing on every operation.
		this.container = this.client.getContainerClient(config.AZURE_STORAGE_CONTAINER);

		logger.info({ container: config.AZURE_STORAGE_CONTAINER }, "AzureBlobAdapter initialised");
	}

	// Uploads a compressed WebP buffer to Azure Blob Storage.
	//
	// The blob path mirrors the LocalDiskAdapter directory structure:
	//   listings/{listingId}/{filename}
	// This makes it straightforward to understand which listing a blob belongs
	// to just by looking at the path in the Azure portal.
	//
	// Returns the full public HTTPS URL that gets written to listing_photos.photo_url.
	// Format: https://{account}.blob.core.windows.net/{container}/listings/{listingId}/{filename}
	//
	// Setting blobContentType to 'image/webp' is critical — without it Azure
	// serves the file as 'application/octet-stream' and browsers will download
	// the file rather than displaying it as an image.
	async upload(buffer, listingId, filename) {
		const blobPath = `listings/${listingId}/${filename}`;
		const blockBlobClient = this.container.getBlockBlobClient(blobPath);

		try {
			await blockBlobClient.uploadData(buffer, {
				blobHTTPHeaders: {
					blobContentType: "image/webp",
					// Cache-Control tells CDNs and browsers they can cache the image
					// for up to 1 year. Photos are content-addressed by UUID filename
					// so a new photo never collides with an old URL — safe to cache
					// aggressively.
					blobCacheControl: "public, max-age=31536000, immutable",
				},
			});

			// blockBlobClient.url is the canonical public URL Azure assigns to this blob.
			// It includes the account name, container, and blob path — everything needed
			// to serve the image directly from Blob Storage or through Azure CDN.
			const url = blockBlobClient.url;

			logger.debug({ blobPath, url }, "AzureBlobAdapter: blob uploaded");
			return url;
		} catch (err) {
			logger.error({ err, blobPath }, "AzureBlobAdapter: upload failed");
			throw new AppError("Failed to upload photo to Azure Blob Storage — try again shortly", 502);
		}
	}

	// Deletes a blob from Azure Blob Storage given its full HTTPS URL.
	//
	// We extract the blob path from the URL rather than accepting a path directly
	// because the rest of the codebase stores and passes the full URL (as written
	// to listing_photos.photo_url). This keeps the interface consistent with
	// LocalDiskAdapter.delete(url).
	//
	// deleteIfExists() is intentional — it mirrors the ENOENT-swallowing behaviour
	// in LocalDiskAdapter. If the blob is already gone (e.g. manual deletion via
	// the Azure portal, or a previous partially-failed cleanup), this is a silent
	// success rather than an error. The desired end state — "file does not exist"
	// — is already true, so there is nothing to fail.
	async delete(url) {
		// Extract the blob path from the full Azure URL.
		//
		// Full URL format:
		//   https://{account}.blob.core.windows.net/{container}/listings/{id}/{file}
		//
		// We need just:
		//   listings/{id}/{file}
		//
		// Strategy: split on "/{containerName}/" and take everything after it.
		// This is robust against account names that might share substrings with
		// the container name.
		const containerPrefix = `/${config.AZURE_STORAGE_CONTAINER}/`;
		const containerIndex = url.indexOf(containerPrefix);

		if (containerIndex === -1) {
			// URL does not contain the expected container — this should never happen
			// in normal operation but log a warning rather than crashing. The blob
			// may have already been deleted or the URL is from a different storage
			// account (e.g. a stale row from a previous configuration).
			logger.warn({ url }, "AzureBlobAdapter: could not extract blob path from URL — skipping delete");
			return;
		}

		const blobPath = url.slice(containerIndex + containerPrefix.length);
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
