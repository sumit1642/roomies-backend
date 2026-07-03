// src/db/seeds/pincodes.js
//
// One-time / rarely-rerun ETL: reads AllIndiaPincodeDataSet.csv and populates
// the `pincodes` reference table (migration 012). Not part of the request
// path — no runtime dependency on the CSV file after this has been run.
//
// Usage:
//   ENV_FILE=.env.local node src/db/seeds/pincodes.js /path/to/AllIndiaPincodeDataSet.csv
//   (also wired as `npm run seed:pincodes -- /path/to/AllIndiaPincodeDataSet.csv`)
//
// See PRD_proximity_search_v2.md (v3), §5.2, for the full algorithm spec and
// the real dataset numbers this was validated against (165,627 rows,
// 19,586 unique pincodes). This file implements that spec directly; the
// resolution functions are exported separately so they can be unit-tested
// against fixtures without touching a real database or CSV.

import fs from "fs";
import readline from "readline";
import "../../config/env.js";
import { pool } from "../client.js";
import { logger } from "../../logger/index.js";

// ── India's bounding box, matching the migration's CHECK constraints and
// profile_pincodes.py so the seed script's own validation is consistent
// with what the DB will accept. ─────────────────────────────────────────────
const INDIA_LAT_MIN = 6.0;
const INDIA_LAT_MAX = 38.0;
const INDIA_LNG_MIN = 68.0;
const INDIA_LNG_MAX = 98.0;

const inIndiaBounds = (lat, lng) =>
	Number.isFinite(lat) &&
	Number.isFinite(lng) &&
	lat >= INDIA_LAT_MIN &&
	lat <= INDIA_LAT_MAX &&
	lng >= INDIA_LNG_MIN &&
	lng <= INDIA_LNG_MAX;

// ── Tier vocabulary, per PRD §5.2 ───────────────────────────────────────────
// Tier 0 (highest): officetype === 'HO', or officename ends in H.O/HO/G.P.O/GPO
// Tier 1:           officename ends in S.O/SO
// Tier 2:           officename ends in B.O/BO, or officetype === 'BO' with no suffix match
// Tier 3 (unranked): anything else
//
// Patterns are case-insensitive and tolerant of a stray leading/trailing
// space, matching real samples seen in the data (e.g. " NDC Lucknow Chowk Ho").
const HO_GPO_SUFFIX_RE = /\b(h\.?o\.?|g\.?p\.?o\.?)\s*$/i;
const SO_SUFFIX_RE = /\bs\.?o\.?\s*$/i;
const BO_SUFFIX_RE = /\bb\.?o\.?\s*$/i;

export const getTier = (officetype, officename) => {
	const name = (officename ?? "").trim();
	const type = (officetype ?? "").trim().toUpperCase();

	if (type === "HO" || HO_GPO_SUFFIX_RE.test(name)) return 0;
	if (SO_SUFFIX_RE.test(name)) return 1;
	if (BO_SUFFIX_RE.test(name) || type === "BO") return 2;
	return 3;
};

// ── Swap detection/correction, per PRD §5.2 step 2a ─────────────────────────
// Returns { latitude, longitude, swapped, usable }:
//   - If the pair as given is in-bounds: use as-is, swapped=false, usable=true.
//   - Else if swapping lat/lng lands in-bounds: use swapped, swapped=true, usable=true.
//   - Else: unusable (true garbage — e.g. (0,0) placeholders, or values with
//     no plausible correction). usable=false.
export const resolveCoordinate = (rawLat, rawLng) => {
	const lat = Number(rawLat);
	const lng = Number(rawLng);

	if (inIndiaBounds(lat, lng)) {
		return { latitude: lat, longitude: lng, swapped: false, usable: true };
	}
	if (inIndiaBounds(lng, lat)) {
		return { latitude: lng, longitude: lat, swapped: true, usable: true };
	}
	return { latitude: null, longitude: null, swapped: false, usable: false };
};

// ── Per-pincode resolution: given all raw rows for one pincode, pick the
// centroid per PRD §5.2. Exported standalone so it can be unit tested
// against small fixtures independent of CSV parsing or DB access. ──────────
export const resolvePincode = (pincode, rawRows) => {
	const resolvedRows = rawRows.map((row) => ({
		...row,
		coord: resolveCoordinate(row.latitude, row.longitude),
		tier: getTier(row.officetype, row.officename),
	}));

	const anySwapCorrected = resolvedRows.some((r) => r.coord.usable && r.coord.swapped);
	const usableRows = resolvedRows.filter((r) => r.coord.usable);

	if (usableRows.length === 0) {
		return { excluded: true, officeCount: rawRows.length };
	}

	const bestTier = Math.min(...usableRows.map((r) => r.tier));
	const topTierRows = usableRows.filter((r) => r.tier === bestTier);

	// "priority" only if a real (non-fallback) tier signal actually narrowed
	// the candidate set below the full usable pool for this pincode — matches
	// the dry-run logic already validated in profile_pincodes.py, so the
	// production seed and the profiling script agree on what counts as
	// "resolved via priority" vs "averaged".
	const resolution = bestTier < 3 && topTierRows.length < usableRows.length ? "priority" : "averaged";

	const avgLat = topTierRows.reduce((sum, r) => sum + r.coord.latitude, 0) / topTierRows.length;
	const avgLng = topTierRows.reduce((sum, r) => sum + r.coord.longitude, 0) / topTierRows.length;

	// Representative city/district/state: prefer the highest-tier row's own
	// naming (most likely to be a recognizable place name — e.g. a Head
	// Office town name — rather than an arbitrary branch office in a
	// scattered rural group).
	const representative = topTierRows[0];

	return {
		excluded: false,
		latitude: Number(avgLat.toFixed(7)),
		longitude: Number(avgLng.toFixed(7)),
		city: representative.officename?.trim() || representative.district?.trim() || pincode,
		district: representative.district?.trim() || null,
		state: representative.statename?.trim(),
		officeCount: rawRows.length,
		resolution,
		swapCorrected: anySwapCorrected,
	};
};

// ── CSV streaming parser ─────────────────────────────────────────────────────
// Deliberately not pulling in a CSV library: the file is well-formed
// (confirmed via profile_pincodes.py — 100% valid 6-digit pincodes, known
// fixed column set), and streaming line-by-line keeps memory flat for a
// 23MB / 165k-row file without adding a new dependency for a one-time script.
const EXPECTED_HEADER = [
	"circlename",
	"regionname",
	"divisionname",
	"officename",
	"pincode",
	"officetype",
	"delivery",
	"district",
	"statename",
	"latitude",
	"longitude",
];

// Minimal CSV line splitter tolerant of quoted fields containing commas.
// The known columns in this dataset are simple (no embedded newlines), so a
// regex-based split is sufficient and avoids a full CSV-parsing dependency.
const splitCsvLine = (line) => {
	const fields = [];
	let current = "";
	let inQuotes = false;

	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === '"') {
			inQuotes = !inQuotes;
		} else if (char === "," && !inQuotes) {
			fields.push(current);
			current = "";
		} else {
			current += char;
		}
	}
	fields.push(current);
	return fields.map((f) => f.trim().replace(/^"|"$/g, ""));
};

const readCsvRows = async (csvPath) => {
	const fileStream = fs.createReadStream(csvPath, { encoding: "utf8" });
	const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

	let header = null;
	const rowsByPincode = new Map();
	let totalRows = 0;

	for await (const line of rl) {
		if (!line.trim()) continue;

		if (!header) {
			header = splitCsvLine(line).map((h) => h.trim().toLowerCase());
			const missing = EXPECTED_HEADER.filter((col) => !header.includes(col));
			if (missing.length) {
				throw new Error(
					`pincodes.js: CSV header is missing expected columns: ${missing.join(", ")}. ` +
						`Found columns: ${header.join(", ")}`,
				);
			}
			continue;
		}

		const fields = splitCsvLine(line);
		const row = {};
		header.forEach((col, idx) => {
			row[col] = fields[idx] ?? "";
		});

		const pincode = row.pincode.trim();
		if (!/^\d{6}$/.test(pincode)) {
			// Matches profile_pincodes.py's format check; real dataset had 0
			// such rows, but guard against a future CSV revision introducing them.
			logger.warn({ pincode, line: totalRows + 2 }, "pincodes.js: skipping row with malformed pincode");
			continue;
		}

		if (!rowsByPincode.has(pincode)) {
			rowsByPincode.set(pincode, []);
		}
		rowsByPincode.get(pincode).push({
			officename: row.officename,
			officetype: row.officetype,
			district: row.district,
			statename: row.statename,
			latitude: row.latitude === "" ? null : Number(row.latitude),
			longitude: row.longitude === "" ? null : Number(row.longitude),
		});

		totalRows++;
	}

	return { rowsByPincode, totalRows };
};

// ── Bulk insert, following the same VALUES-placeholder batching pattern as
// src/db/seeds/amenities.js. Batched to keep any single INSERT statement's
// parameter count reasonable across ~19.5k rows. ────────────────────────────
const INSERT_BATCH_SIZE = 1000;
const COLUMNS_PER_ROW = 8; // pincode, city, district, state, latitude, longitude, office_count, resolution, swap_corrected -> see below (9 actually)

const insertBatch = async (batch) => {
	if (!batch.length) return 0;

	const placeholders = batch
		.map((_, i) => {
			const base = i * 9;
			return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
		})
		.join(", ");

	const values = batch.flatMap((row) => [
		row.pincode,
		row.city,
		row.district,
		row.state,
		row.latitude,
		row.longitude,
		row.officeCount,
		row.resolution,
		row.swapCorrected,
	]);

	const result = await pool.query(
		`INSERT INTO pincodes
       (pincode, city, district, state, latitude, longitude, office_count, resolution, swap_corrected)
     VALUES ${placeholders}
     ON CONFLICT (pincode) DO UPDATE SET
       city           = EXCLUDED.city,
       district       = EXCLUDED.district,
       state          = EXCLUDED.state,
       latitude       = EXCLUDED.latitude,
       longitude      = EXCLUDED.longitude,
       office_count   = EXCLUDED.office_count,
       resolution     = EXCLUDED.resolution,
       swap_corrected = EXCLUDED.swap_corrected`,
		values,
	);

	return result.rowCount;
};

const seed = async (csvPath) => {
	if (!csvPath) {
		console.error("Usage: node src/db/seeds/pincodes.js /path/to/AllIndiaPincodeDataSet.csv");
		process.exit(1);
	}
	if (!fs.existsSync(csvPath)) {
		console.error(`pincodes.js: file not found: ${csvPath}`);
		process.exit(1);
	}

	logger.info({ csvPath }, "pincodes.js: reading CSV");
	const { rowsByPincode, totalRows } = await readCsvRows(csvPath);
	logger.info(
		{ totalRows, uniquePincodes: rowsByPincode.size },
		"pincodes.js: CSV parsed, resolving centroids per pincode",
	);

	const toInsert = [];
	const excludedPincodes = [];
	const counts = { priority: 0, averaged: 0, excluded: 0, swapCorrected: 0 };

	// Track which states contribute the most swap-corrected rows, per PRD §8
	// ("worth a one-line note ... in case it points to a batch data-entry
	// issue"). This is diagnostic only — does not affect resolution logic.
	const swapCorrectedByState = new Map();

	for (const [pincode, rawRows] of rowsByPincode.entries()) {
		const resolved = resolvePincode(pincode, rawRows);

		if (resolved.excluded) {
			counts.excluded++;
			excludedPincodes.push(pincode);
			continue;
		}

		counts[resolved.resolution]++;
		if (resolved.swapCorrected) {
			counts.swapCorrected++;
			const state = resolved.state ?? "UNKNOWN";
			swapCorrectedByState.set(state, (swapCorrectedByState.get(state) ?? 0) + 1);
		}

		toInsert.push({
			pincode,
			city: resolved.city,
			district: resolved.district,
			state: resolved.state,
			latitude: resolved.latitude,
			longitude: resolved.longitude,
			officeCount: resolved.officeCount,
			resolution: resolved.resolution,
			swapCorrected: resolved.swapCorrected,
		});
	}

	logger.info(
		{
			toSeed: toInsert.length,
			priority: counts.priority,
			averaged: counts.averaged,
			excluded: counts.excluded,
			swapCorrected: counts.swapCorrected,
		},
		"pincodes.js: resolution complete, inserting",
	);

	let totalInserted = 0;
	for (let i = 0; i < toInsert.length; i += INSERT_BATCH_SIZE) {
		const batch = toInsert.slice(i, i + INSERT_BATCH_SIZE);
		const inserted = await insertBatch(batch);
		totalInserted += inserted;
		logger.debug({ batchStart: i, batchSize: batch.length, totalInserted }, "pincodes.js: batch inserted");
	}

	// Summary log — per PRD §9: "this is now a script with real branching
	// behavior worth a human glance at its output, not a purely mechanical
	// bulk insert."
	const topSwapStates = [...swapCorrectedByState.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

	logger.info(
		{
			totalCsvRows: totalRows,
			uniquePincodesInCsv: rowsByPincode.size,
			pincodesSeeded: totalInserted,
			resolvedViaPriority: counts.priority,
			resolvedViaAveraging: counts.averaged,
			excludedNoValidCoords: counts.excluded,
			excludedPincodeSample: excludedPincodes.slice(0, 20),
			swapCorrectedCount: counts.swapCorrected,
			swapCorrectedTopStates: Object.fromEntries(topSwapStates),
		},
		"pincodes.js: seed complete",
	);
};

const csvPathArg = process.argv[2];

seed(csvPathArg)
	.catch((err) => {
		logger.error({ err }, "pincodes.js: seed failed");
		process.exit(1);
	})
	.finally(() => pool.end());
