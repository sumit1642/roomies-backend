// src/storage/index.js
//
// Storage service singleton.
//
// This file is the single point of adapter selection for the entire application.
// It reads STORAGE_ADAPTER from the environment once at module load time, creates
// the correct adapter instance, and exports it as `storageService`. Every other
// file in the project that needs to store or delete a file imports from here.
//
// STORAGE_ADAPTER=local  → LocalDiskAdapter  (development)
// STORAGE_ADAPTER=azure  → AzureBlobAdapter  (production — currently a stub)
//
// The consuming code looks like this everywhere:
//   import { storageService } from '../storage/index.js'
//   const url = await storageService.upload(buffer, listingId, filename)
//   await storageService.delete(url)
//
// There are zero if (STORAGE_ADAPTER === '...') checks outside this file.
// Swapping to a new adapter in the future means touching only this file and
// writing the new adapter class — nothing else changes.

import { LocalDiskAdapter } from "./adapters/localDisk.js";
import { AzureBlobAdapter } from "./adapters/azureBlob.js";
import { logger } from "../logger/index.js";

const adapter = process.env.STORAGE_ADAPTER ?? "local";

let storageService;

if (adapter === "azure") {
	storageService = new AzureBlobAdapter();
	logger.info("Storage adapter: Azure Blob (stub)");
} else {
	// Default to local disk for any unrecognised value, not just 'local'.
	// This makes local development the safe fallback — a misconfigured
	// STORAGE_ADAPTER never silently picks Azure.
	if (adapter !== "local") {
		logger.warn({ adapter }, `Unrecognised STORAGE_ADAPTER value — falling back to LocalDiskAdapter`);
	}
	storageService = new LocalDiskAdapter();
	logger.info("Storage adapter: Local disk");
}

export { storageService };
