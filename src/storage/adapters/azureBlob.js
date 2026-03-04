// src/storage/adapters/azureBlob.js
//
// Azure Blob Storage adapter — STUB for this phase.
//
// The interface is complete and correct. The implementation is deferred to the
// deployment phase when Azure credentials are available and the Blob Storage
// container has been provisioned.
//
// Why build the stub now?
// Having this file in place means the rest of the codebase — the photo service,
// the worker, and any future caller — is written purely against the interface:
//   storageService.upload(buffer, listingId, filename) → url
//   storageService.delete(url)
//
// No if (STORAGE_ADAPTER === 'azure') conditionals exist anywhere else.
// When Azure integration is ready, only this file changes. Nothing else touches.
//
// When implementing for real:
//   1. npm install @azure/storage-blob
//   2. Add AZURE_STORAGE_ACCOUNT, AZURE_STORAGE_KEY, AZURE_STORAGE_CONTAINER
//      to src/config/env.js Zod schema and to .env.azure
//   3. Replace the throw below with:
//        const { BlobServiceClient } = await import('@azure/storage-blob')
//        this.client = BlobServiceClient.fromConnectionString(connectionString)
//        this.container = this.client.getContainerClient(containerName)
//   4. upload(): use this.container.getBlockBlobClient(blobPath).uploadData(buffer)
//      Returns: `https://${account}.blob.core.windows.net/${container}/${blobPath}`
//   5. delete(): use this.container.getBlockBlobClient(blobPath).deleteIfExists()
//
// The returned URL format for Azure would be:
//   https://{account}.blob.core.windows.net/{container}/listings/{listingId}/{filename}
// This full HTTPS URL is what gets written to listing_photos.photo_url in prod.

import { AppError } from "../../middleware/errorHandler.js";

export class AzureBlobAdapter {
	constructor() {
		// No-op constructor — Azure SDK client initialised in upload() on first call
		// (or here once credentials are available).
	}

	// eslint-disable-next-line no-unused-vars
	async upload(buffer, listingId, filename) {
		throw new AppError("Azure Blob Storage is not yet configured — set STORAGE_ADAPTER=local for development", 501);
	}

	// eslint-disable-next-line no-unused-vars
	async delete(url) {
		throw new AppError("Azure Blob Storage is not yet configured — set STORAGE_ADAPTER=local for development", 501);
	}
}
