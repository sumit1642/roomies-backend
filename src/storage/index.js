// src/storage/index.js
// Fixed: reads STORAGE_ADAPTER from config (Zod-validated) instead of process.env directly.

import { LocalDiskAdapter } from "./adapters/localDisk.js";
import { AzureBlobAdapter } from "./adapters/azureBlob.js";
import { logger } from "../logger/index.js";
import { config } from "../config/env.js";

const adapter = config.STORAGE_ADAPTER;

let storageService;

if (adapter === "azure") {
	storageService = new AzureBlobAdapter();
	logger.info("Storage adapter: Azure Blob (stub)");
} else {
	storageService = new LocalDiskAdapter();
	logger.info("Storage adapter: Local disk");
}

export { storageService };
