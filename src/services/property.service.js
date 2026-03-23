// src/services/property.service.js

import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";
import { assertPgOwnerVerified as assertOwnerVerified } from "../db/utils/pgOwner.js";

// ─── Amenity bulk-insert helper ───────────────────────────────────────────────
const bulkInsertAmenities = async (client, propertyId, amenityIds) => {
	if (!amenityIds.length) return;
	const placeholders = amenityIds.map((_, i) => `($1, $${i + 2})`).join(", ");
	const values = [propertyId, ...amenityIds];
	await client.query(
		`INSERT INTO property_amenities (property_id, amenity_id)
     VALUES ${placeholders}`,
		values,
	);
};

// ─── Response shape helpers ───────────────────────────────────────────────────
const fetchPropertyWithAmenities = async (propertyId, client = pool) => {
	const { rows } = await client.query(
		`SELECT
      p.property_id,
      p.owner_id,
      p.property_name,
      p.description,
      p.property_type,
      p.address_line,
      p.city,
      p.locality,
      p.landmark,
      p.pincode,
      p.latitude,
      p.longitude,
      p.house_rules,
      p.total_rooms,
      p.status,
      p.average_rating,
      p.rating_count,
      p.created_at,
      p.updated_at,
      COALESCE(
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'amenityId',  a.amenity_id,
            'name',       a.name,
            'category',   a.category,
            'iconName',   a.icon_name
          )
          ORDER BY a.category, a.name
        ) FILTER (WHERE a.amenity_id IS NOT NULL),
        '[]'
      ) AS amenities
    FROM properties p
    LEFT JOIN property_amenities pa ON pa.property_id = p.property_id
    LEFT JOIN amenities a           ON a.amenity_id   = pa.amenity_id
    WHERE p.property_id = $1
      AND p.deleted_at IS NULL
    GROUP BY p.property_id`,
		[propertyId],
	);
	return rows[0] ?? null;
};

// ─── Create property ──────────────────────────────────────────────────────────
export const createProperty = async (ownerId, body) => {
	await assertOwnerVerified(ownerId);

	const {
		propertyName,
		description,
		propertyType,
		addressLine,
		city,
		locality,
		landmark,
		pincode,
		latitude,
		longitude,
		houseRules,
		totalRooms,
		amenityIds,
	} = body;

	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		const { rows } = await client.query(
			`INSERT INTO properties (
        owner_id, property_name, description, property_type,
        address_line, city, locality, landmark, pincode,
        latitude, longitude, house_rules, total_rooms
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING property_id`,
			[
				ownerId,
				propertyName,
				description ?? null,
				propertyType,
				addressLine,
				city,
				locality ?? null,
				landmark ?? null,
				pincode ?? null,
				latitude ?? null,
				longitude ?? null,
				houseRules ?? null,
				totalRooms ?? null,
			],
		);

		const propertyId = rows[0].property_id;
		await bulkInsertAmenities(client, propertyId, amenityIds);

		await client.query("COMMIT");

		logger.info({ ownerId, propertyId, amenityCount: amenityIds.length }, "Property created");

		const property = await fetchPropertyWithAmenities(propertyId);
		return property;
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
};

// ─── Get property ─────────────────────────────────────────────────────────────
export const getProperty = async (propertyId) => {
	const property = await fetchPropertyWithAmenities(propertyId);
	if (!property) {
		throw new AppError("Property not found", 404);
	}
	return property;
};

// ─── List properties ──────────────────────────────────────────────────────────
export const listProperties = async (ownerId, { cursorTime, cursorId, limit = 20 }) => {
	const hasCursor = cursorTime !== undefined && cursorId !== undefined;
	const params = [ownerId, limit + 1];
	let cursorClause = "";

	if (hasCursor) {
		params.push(cursorTime, cursorId);
		cursorClause = `AND (p.created_at < $3 OR (p.created_at = $3 AND p.property_id > $4::uuid))`;
	}

	const { rows } = await pool.query(
		`SELECT
      p.property_id,
      p.property_name,
      p.property_type,
      p.city,
      p.locality,
      p.status,
      p.average_rating,
      p.rating_count,
      p.created_at,
      p.updated_at,
      (
        SELECT COUNT(*)::int
        FROM property_amenities pa
        WHERE pa.property_id = p.property_id
      ) AS amenity_count,
      (
        SELECT COUNT(*)::int
        FROM listings l
        WHERE l.property_id = p.property_id
          AND l.status = 'active'
          AND l.expires_at > NOW()
          AND l.deleted_at IS NULL
      ) AS active_listing_count
    FROM properties p
    WHERE p.owner_id = $1
      AND p.deleted_at IS NULL
      ${cursorClause}
    ORDER BY p.created_at DESC, p.property_id ASC
    LIMIT $2`,
		params,
	);

	const hasNextPage = rows.length > limit;
	const items = hasNextPage ? rows.slice(0, limit) : rows;

	const nextCursor =
		hasNextPage ?
			{
				cursorTime: items[items.length - 1].created_at.toISOString(),
				cursorId: items[items.length - 1].property_id,
			}
		:	null;

	return { items, nextCursor };
};

// ─── Update property ──────────────────────────────────────────────────────────
export const updateProperty = async (ownerId, propertyId, body) => {
	await assertOwnerVerified(ownerId);

	const columnMap = {
		propertyName: "property_name",
		description: "description",
		propertyType: "property_type",
		addressLine: "address_line",
		city: "city",
		locality: "locality",
		landmark: "landmark",
		pincode: "pincode",
		latitude: "latitude",
		longitude: "longitude",
		houseRules: "house_rules",
		totalRooms: "total_rooms",
	};

	const setClauses = [];
	const values = [];
	let paramIndex = 1;

	for (const [key, column] of Object.entries(columnMap)) {
		if (body[key] !== undefined) {
			setClauses.push(`${column} = $${paramIndex}`);
			values.push(body[key]);
			paramIndex++;
		}
	}

	const updateAmenities = body.amenityIds !== undefined;

	if (!setClauses.length && !updateAmenities) {
		throw new AppError("No valid fields provided for update", 400);
	}

	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		if (setClauses.length) {
			values.push(propertyId, ownerId);
			const { rowCount } = await client.query(
				`UPDATE properties
         SET ${setClauses.join(", ")}
         WHERE property_id = $${paramIndex}
           AND owner_id    = $${paramIndex + 1}
           AND deleted_at IS NULL`,
				values,
			);

			if (rowCount === 0) {
				throw new AppError("Property not found", 404);
			}
		} else {
			const { rows } = await client.query(
				`SELECT 1 FROM properties
         WHERE property_id = $1
           AND owner_id    = $2
           AND deleted_at IS NULL`,
				[propertyId, ownerId],
			);
			if (!rows.length) {
				throw new AppError("Property not found", 404);
			}
		}

		if (updateAmenities) {
			await client.query(`DELETE FROM property_amenities WHERE property_id = $1`, [propertyId]);
			await bulkInsertAmenities(client, propertyId, body.amenityIds);
		}

		await client.query("COMMIT");

		logger.info({ ownerId, propertyId }, "Property updated");

		const property = await fetchPropertyWithAmenities(propertyId);
		return property;
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
};

// ─── Delete property (soft) ───────────────────────────────────────────────────
//
// Concurrency strategy:
//   1. Lock the property row (FOR UPDATE) — prevents concurrent deletes.
//   2. Lock ALL non-deleted listings for this property (FOR UPDATE) — prevents
//      a concurrent listing status-change from slipping between our active-listing
//      check and the property soft-delete. Without locking the listing rows, the
//      following race is possible:
//        T1 (us):       SELECT active listings → 0 rows
//        T2 (other):    UPDATE listing SET status='active' → succeeds
//        T1 (us):       UPDATE properties SET deleted_at = NOW() → also succeeds
//      Result: a live 'active' listing pointing at a soft-deleted property.
//      Holding a row-level lock on all listings blocks T2 until T1 commits,
//      closing the race entirely.
export const deleteProperty = async (ownerId, propertyId) => {
	await assertOwnerVerified(ownerId);

	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		// Step 1: Lock the property row itself.
		const { rows: propertyRows } = await client.query(
			`SELECT property_id
       FROM properties
       WHERE property_id = $1
         AND owner_id    = $2
         AND deleted_at IS NULL
       FOR UPDATE`,
			[propertyId, ownerId],
		);

		if (!propertyRows.length) {
			throw new AppError("Property not found", 404);
		}

		// Step 2: Lock every non-deleted listing for this property.
		// We lock the full set (not just active ones) so a concurrent transition
		// from any non-active status to 'active' is also blocked.
		await client.query(
			`SELECT listing_id
       FROM listings
       WHERE property_id = $1
         AND deleted_at  IS NULL
       FOR UPDATE`,
			[propertyId],
		);

		// Step 3: Now that we hold locks on all relevant rows, safely check whether
		// any listing is currently active. No other transaction can change listing
		// status while we hold these locks.
		const { rows: activeListingRows } = await client.query(
			`SELECT 1
       FROM listings
       WHERE property_id = $1
         AND status      = 'active'
         AND deleted_at  IS NULL
       LIMIT 1`,
			[propertyId],
		);

		if (activeListingRows.length) {
			throw new AppError("Deactivate or remove all active listings before deleting this property", 409);
		}

		// Step 4: Soft-delete the property.
		await client.query(
			`UPDATE properties
       SET deleted_at = NOW()
       WHERE property_id = $1`,
			[propertyId],
		);

		await client.query("COMMIT");
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}

	logger.info({ ownerId, propertyId }, "Property soft-deleted");

	return { propertyId, deleted: true };
};
