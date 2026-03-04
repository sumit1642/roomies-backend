// src/db/seeds/amenities.js
//
// Idempotent amenity seed script. Run once per environment after schema setup.
//
// Usage:
//   npm run seed:amenities
//
// Safe to re-run — ON CONFLICT (name) DO NOTHING means existing rows are never
// touched. Only new entries in the AMENITIES array below produce inserts.
// Previously seeded rows with manually-edited icon_name or category values in
// the DB will not be overwritten.
//
// When adding new amenities: append to the array below and re-run. Do not
// remove entries that already exist in production — soft-delete them via the
// admin panel instead. Hard-deleting from this array and re-running does nothing
// to the DB (ON CONFLICT DO NOTHING, not DELETE + INSERT).
//
// icon_name convention: kebab-case strings matching Lucide icon names where
// possible (https://lucide.dev/icons/). The frontend maps these directly to
// React components. If no Lucide icon exists, use a descriptive kebab-case
// string and document it here.
//   wifi             → Lucide: Wifi
//   power-backup     → Lucide: BatteryCharging
//   water-supply     → Lucide: Droplets
//   piped-gas        → Lucide: Flame
//   laundry          → Lucide: WashingMachine
//   housekeeping     → Lucide: Sparkles
//   cctv             → Lucide: Camera
//   security-guard   → Lucide: Shield
//   gated-entry      → Lucide: DoorClosed
//   biometric-access → Lucide: Fingerprint
//   fire-safety      → Lucide: FireExtinguisher (custom — not in Lucide core)
//   air-conditioning → Lucide: AirVent
//   ceiling-fan      → Lucide: Wind
//   attached-bathroom→ Lucide: Bath
//   furnished        → Lucide: Sofa
//   gym              → Lucide: Dumbbell
//   common-room      → Lucide: Users
//   parking          → Lucide: ParkingSquare
//   rooftop          → Lucide: Building2

import "../../../src/config/env.js"; // Zod env validation runs at import
import { pool } from "../client.js";
import { logger } from "../../logger/index.js";

// ─── Amenity definitions ──────────────────────────────────────────────────────
//
// Three categories match the amenity_category_enum in the schema exactly:
//   utility  — infrastructure a resident depends on daily
//   safety   — physical security of the building and residents
//   comfort  — quality-of-life additions beyond the basics
//
// Ordering within each group is display order — the frontend renders amenities
// in the order they appear in this array (after the DB returns them ORDER BY name,
// the seed order has no effect on retrieval, but the grouping here documents intent).

const AMENITIES = [
	// ── Utility ──────────────────────────────────────────────────────────────
	{ name: "WiFi", category: "utility", icon_name: "wifi" },
	{ name: "Power Backup", category: "utility", icon_name: "power-backup" },
	{ name: "24-Hour Water Supply", category: "utility", icon_name: "water-supply" },
	{ name: "Piped Gas", category: "utility", icon_name: "piped-gas" },
	{ name: "Laundry", category: "utility", icon_name: "laundry" },
	{ name: "Housekeeping", category: "utility", icon_name: "housekeeping" },

	// ── Safety ────────────────────────────────────────────────────────────────
	{ name: "CCTV Surveillance", category: "safety", icon_name: "cctv" },
	{ name: "Security Guard", category: "safety", icon_name: "security-guard" },
	{ name: "Gated Entry", category: "safety", icon_name: "gated-entry" },
	{ name: "Biometric / Key-Card Access", category: "safety", icon_name: "biometric-access" },
	{ name: "Fire Safety Equipment", category: "safety", icon_name: "fire-safety" },

	// ── Comfort ───────────────────────────────────────────────────────────────
	{ name: "Air Conditioning", category: "comfort", icon_name: "air-conditioning" },
	{ name: "Ceiling Fan", category: "comfort", icon_name: "ceiling-fan" },
	{ name: "Attached Bathroom", category: "comfort", icon_name: "attached-bathroom" },
	{ name: "Furnished Room", category: "comfort", icon_name: "furnished" },
	{ name: "Gym", category: "comfort", icon_name: "gym" },
	{ name: "Common Room / Lounge", category: "comfort", icon_name: "common-room" },
	{ name: "Parking", category: "comfort", icon_name: "parking" },
	{ name: "Rooftop / Terrace", category: "comfort", icon_name: "rooftop" },
];

const seed = async () => {
	logger.info(`Seeding ${AMENITIES.length} amenities…`);

	// Build a multi-row VALUES clause: ($1, $2, $3), ($4, $5, $6), ...
	// A single INSERT with multiple value tuples is far more efficient than
	// N individual INSERT statements — one round-trip to the DB instead of N.
	const placeholders = AMENITIES.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(", ");

	const values = AMENITIES.flatMap(({ name, category, icon_name }) => [name, category, icon_name]);

	// ON CONFLICT (name) DO NOTHING — name has a UNIQUE constraint in the schema.
	// rowCount reflects only the rows that were actually inserted, not the total
	// attempted, so it tells us exactly how many new amenities were added this run.
	const result = await pool.query(
		`INSERT INTO amenities (name, category, icon_name)
     VALUES ${placeholders}
     ON CONFLICT (name) DO NOTHING`,
		values,
	);

	const inserted = result.rowCount;
	const skipped = AMENITIES.length - inserted;

	logger.info({ inserted, skipped }, "Amenity seed complete");
};

// ─── Run ──────────────────────────────────────────────────────────────────────
//
// pool.end() must be called explicitly — the script would otherwise hang
// indefinitely with open idle connections after the query completes, because
// the pg pool keeps connections alive waiting for future queries.
seed()
	.catch((err) => {
		logger.error({ err }, "Amenity seed failed");
		process.exit(1);
	})
	.finally(() => pool.end());
