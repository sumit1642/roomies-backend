// src/storage/index.js
// Fix: reads STORAGE_ADAPTER from Zod-validated config instead of process.env directly,
// ensuring the value is validated at startup and misconfiguration throws rather than silently falling back.

import { LocalDiskAdapter } from "./adapters/localDisk.js";
import { AzureBlobAdapter } from "./adapters/azureBlob.js";
import { logger } from "../logger/index.js";
import { config } from "../config/env.js";

const adapter = config.STORAGE_ADAPTER;

let storageService;

if (adapter === "azure") {
	storageService = new AzureBlobAdapter();
	logger.info("Storage adapter: Azure Blob");
} else {
	storageService = new LocalDiskAdapter();
	logger.info("Storage adapter: Local disk");
}

export { storageService };
