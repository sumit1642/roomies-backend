








































import "../../../src/config/env.js"; 
import { pool } from "../client.js";
import { logger } from "../../logger/index.js";












const AMENITIES = [
	
	{ name: "WiFi", category: "utility", icon_name: "wifi" },
	{ name: "Power Backup", category: "utility", icon_name: "power-backup" },
	{ name: "24-Hour Water Supply", category: "utility", icon_name: "water-supply" },
	{ name: "Piped Gas", category: "utility", icon_name: "piped-gas" },
	{ name: "Laundry", category: "utility", icon_name: "laundry" },
	{ name: "Housekeeping", category: "utility", icon_name: "housekeeping" },

	
	{ name: "CCTV Surveillance", category: "safety", icon_name: "cctv" },
	{ name: "Security Guard", category: "safety", icon_name: "security-guard" },
	{ name: "Gated Entry", category: "safety", icon_name: "gated-entry" },
	{ name: "Biometric / Key-Card Access", category: "safety", icon_name: "biometric-access" },
	{ name: "Fire Safety Equipment", category: "safety", icon_name: "fire-safety" },

	
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

	
	
	
	const placeholders = AMENITIES.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(", ");

	const values = AMENITIES.flatMap(({ name, category, icon_name }) => [name, category, icon_name]);

	
	
	
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






seed()
	.catch((err) => {
		logger.error({ err }, "Amenity seed failed");
		process.exit(1);
	})
	.finally(() => pool.end());
