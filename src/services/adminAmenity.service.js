// ─── NEW FILE: src/services/adminAmenity.service.js ────────────────────────
//
// Admin-only write path for the amenities reference table. Previously the
// only way to add/edit/remove an amenity was seeds/amenities.js (a one-time
// ETL script, ON CONFLICT DO NOTHING — not an edit path) or direct SQL.
//
// name is UNIQUE (migration 001: `name VARCHAR(100) NOT NULL UNIQUE`) —
// both create and update catch 23505 and surface a 409, matching the
// convention already used in institution.service.js for its own unique
// email_domain constraint.
//
// Delete: amenities is referenced by property_amenities and
// listing_amenities via `amenity_id UUID NOT NULL REFERENCES amenities
// (amenity_id) ON DELETE RESTRICT` (migration 001) — deleting an
// in-use amenity raises Postgres error 23503, which we catch and turn into
// a 409 rather than letting it fall through to errorHandler.js's generic
// foreign-key-violation branch (which returns a correct but non-specific
// message). We check first here so the response can say *why*, not just that
// it failed.

import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";

const toCamelCase = (row) => ({
	amenityId: row.amenity_id,
	name: row.name,
	category: row.category,
	iconName: row.icon_name,
	createdAt: row.created_at,
	updatedAt: row.updated_at,
});

export const createAmenity = async (adminUserId, { name, category, iconName }) => {
	let rows;
	try {
		({ rows } = await pool.query(
			`INSERT INTO amenities (name, category, icon_name)
       VALUES ($1, $2::amenity_category_enum, $3)
       RETURNING amenity_id, name, category, icon_name, created_at, updated_at`,
			[name, category, iconName ?? null],
		));
	} catch (err) {
		if (err.code === "23505") {
			throw new AppError(`An amenity named '${name}' already exists`, 409);
		}
		throw err;
	}

	const amenity = rows[0];

	logger.info(
		{ adminUserId, amenityId: amenity.amenity_id, name, action: "amenity.create" },
		"Admin created amenity",
	);

	return toCamelCase(amenity);
};

export const updateAmenity = async (adminUserId, amenityId, updates) => {
	const columnMap = {
		name: "name",
		category: "category",
		iconName: "icon_name",
	};

	const enumCasts = {
		category: "::amenity_category_enum",
	};

	const setClauses = [];
	const values = [];
	let p = 1;

	for (const [key, column] of Object.entries(columnMap)) {
		if (updates[key] !== undefined) {
			const cast = enumCasts[column] ?? "";
			setClauses.push(`${column} = $${p}${cast}`);
			values.push(updates[key]);
			p++;
		}
	}

	if (!setClauses.length) {
		throw new AppError("No valid fields provided for update", 400);
	}

	values.push(amenityId);

	let rows;
	try {
		({ rows } = await pool.query(
			`UPDATE amenities
       SET ${setClauses.join(", ")}, updated_at = NOW()
       WHERE amenity_id = $${p}
       RETURNING amenity_id, name, category, icon_name, created_at, updated_at`,
			values,
		));
	} catch (err) {
		if (err.code === "23505") {
			throw new AppError(`An amenity named '${updates.name}' already exists`, 409);
		}
		throw err;
	}

	if (!rows.length) {
		throw new AppError("Amenity not found", 404);
	}

	logger.info({ adminUserId, amenityId, action: "amenity.update" }, "Admin updated amenity");

	return toCamelCase(rows[0]);
};

export const deleteAmenity = async (adminUserId, amenityId) => {
	try {
		const { rowCount } = await pool.query(`DELETE FROM amenities WHERE amenity_id = $1`, [amenityId]);

		if (rowCount === 0) {
			throw new AppError("Amenity not found", 404);
		}
	} catch (err) {
		if (err.code === "23503") {
			throw new AppError(
				"This amenity is currently attached to one or more properties or listings and cannot be deleted. " +
					"Remove it from all properties/listings first.",
				409,
			);
		}
		throw err;
	}

	logger.info({ adminUserId, amenityId, action: "amenity.delete" }, "Admin deleted amenity");

	return { amenityId, deleted: true };
};
