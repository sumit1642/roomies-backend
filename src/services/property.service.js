// src/services/property.service.js

import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";
import { assertPgOwnerVerified as assertOwnerVerified } from "../db/utils/pgOwner.js";

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

// Location fields that, when changed on a property, must cascade to all linked
// pg_room and hostel_bed listings so proximity search and city filters stay consistent.
const LOCATION_CASCADE_MAP = {
	city: "city",
	address_line: "address_line",
	locality: "locality",
	landmark: "landmark",
	pincode: "pincode",
	latitude: "latitude",
	longitude: "longitude",
};

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
// Location field changes cascade to all linked pg_room and hostel_bed listings
// within the same transaction to keep city/address/coordinates consistent.
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

	const changedLocationColumns = setClauses
		.map((clause) => clause.split(" = ")[0].trim())
		.filter((col) => col in LOCATION_CASCADE_MAP);

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

		if (changedLocationColumns.length > 0) {
			const { rows: freshRows } = await client.query(
				`SELECT ${changedLocationColumns.join(", ")}
         FROM properties
         WHERE property_id = $1`,
				[propertyId],
			);

			if (freshRows.length) {
				const fresh = freshRows[0];

				const listingSetClauses = changedLocationColumns.map((col, i) => `${col} = $${i + 2}`);
				const listingValues = changedLocationColumns.map((col) => fresh[col]);

				const { rowCount: listingUpdateCount } = await client.query(
					`UPDATE listings
           SET ${listingSetClauses.join(", ")}
           WHERE property_id = $1
             AND listing_type IN ('pg_room', 'hostel_bed')
             AND deleted_at IS NULL`,
					[propertyId, ...listingValues],
				);

				if (listingUpdateCount > 0) {
					logger.info(
						{
							propertyId,
							ownerId,
							listingUpdateCount,
							cascadedColumns: changedLocationColumns,
						},
						"Property location change cascaded to linked listings",
					);
				}
			}
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
// Locks the property row then all its non-deleted listing rows to prevent a
// TOCTOU race where a concurrent status change could create an active listing
// after the check but before the soft-delete commits.
//
// The active listing guard includes (expires_at IS NULL OR expires_at > NOW())
// so expired listings — which can never be reactivated from 'expired' status —
// do not falsely block property deletion.
export const deleteProperty = async (ownerId, propertyId) => {
	await assertOwnerVerified(ownerId);

	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		// Step 1: lock the property row.
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

		// Step 2: lock all non-deleted listing rows for this property.
		await client.query(
			`SELECT listing_id
       FROM listings
       WHERE property_id = $1
         AND deleted_at  IS NULL
       FOR UPDATE`,
			[propertyId],
		);

		// Step 3: check for non-expired active listings under the lock.
		// Expired listings (status = 'expired' or expires_at in the past) are
		// terminal and can never be reactivated, so they do not block deletion.
		const { rows: activeListingRows } = await client.query(
			`SELECT 1
       FROM listings
       WHERE property_id = $1
         AND status      = 'active'
         AND (expires_at IS NULL OR expires_at > NOW())
         AND deleted_at  IS NULL
       LIMIT 1`,
			[propertyId],
		);

		if (activeListingRows.length) {
			throw new AppError("Deactivate or remove all active listings before deleting this property", 409);
		}

		// Step 4: soft-delete the property.
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
