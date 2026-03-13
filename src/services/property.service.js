// src/services/property.service.js

import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";
import { assertPgOwnerVerified as assertOwnerVerified } from "../db/utils/pgOwner.js";
// assertOwnerVerified is aliased from the shared utility in src/db/utils/pgOwner.js.
// It was previously a private function defined in this file. Extracted when
// listing.service.js needed the same check — a shared import avoids duplication
// and any circular dependency between peer service files. All existing call sites
// are unchanged.

// ─── Amenity bulk-insert helper ───────────────────────────────────────────────
//
// Inserts all amenityIds for a given propertyId in a single query rather than
// N separate queries. This matters: a property with 10 amenities would cost
// 10 round-trips individually; one multi-row INSERT costs exactly one.
//
// Must be called inside an open transaction (receives a client, not pool) so
// the amenity inserts are atomic with the property INSERT or UPDATE that
// precedes them. If any amenity_id fails the FK constraint, the whole
// transaction rolls back.
//
// Called with an empty array is a no-op — the function returns immediately
// without touching the DB. This is the correct behaviour for a property
// created without amenities.
const bulkInsertAmenities = async (client, propertyId, amenityIds) => {
	if (!amenityIds.length) return;

	// Build the VALUES clause dynamically: ($1, $2), ($1, $3), ...
	// $1 is always propertyId — the same value reused across all tuples.
	// $2...$N are the amenity IDs. Using a single $1 reference for propertyId
	// across multiple tuples is valid in PostgreSQL parameterised queries.
	const placeholders = amenityIds.map((_, i) => `($1, $${i + 2})`).join(", ");
	const values = [propertyId, ...amenityIds];

	await client.query(
		`INSERT INTO property_amenities (property_id, amenity_id)
     VALUES ${placeholders}`,
		values,
	);
};

// ─── Response shape helpers ───────────────────────────────────────────────────
//
// The single-property response includes full amenity objects (name, category,
// icon_name) so the frontend can render icons without a second request.
// The list response returns a lightweight summary with only amenity count and
// active listing count — enough for a dashboard card, without over-fetching.

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
        owner_id,
        property_name,
        description,
        property_type,
        address_line,
        city,
        locality,
        landmark,
        pincode,
        latitude,
        longitude,
        house_rules,
        total_rooms
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

		// Insert amenity links inside the same transaction. If any amenity_id is
		// invalid (FK violation → err.code '23503'), the catch block rolls back
		// the property INSERT too. The global error handler converts 23503 to 409.
		await bulkInsertAmenities(client, propertyId, amenityIds);

		await client.query("COMMIT");

		logger.info({ ownerId, propertyId, amenityCount: amenityIds.length }, "Property created");

		// Fetch the full shape (with amenity objects) for the 201 response.
		// This is a separate read after the transaction commits — acceptable because
		// the write is already durable. Fetching inside the transaction would hold
		// the transaction open longer than needed for no correctness benefit.
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
//
// Any authenticated user can read any property. No ownership check, no role
// check at the service layer — those are applied (or intentionally omitted) at
// the route layer. The service is not the right place to make that call.

export const getProperty = async (propertyId) => {
	const property = await fetchPropertyWithAmenities(propertyId);
	if (!property) {
		throw new AppError("Property not found", 404);
	}
	return property;
};

// ─── List properties ──────────────────────────────────────────────────────────
//
// Returns the requesting owner's own properties only. Keyset pagination with
// compound cursor (created_at DESC, property_id ASC) — newest-first so the
// most recently added properties appear at the top of the management dashboard.
// The secondary sort on property_id (ascending) provides a stable tiebreaker
// when two properties have the same created_at timestamp.
//
// The summary shape includes amenity_count and active_listing_count as subquery
// columns so the dashboard card has the information it needs without a second
// request per property.

export const listProperties = async (ownerId, { cursorTime, cursorId, limit = 20 }) => {
	const hasCursor = cursorTime !== undefined && cursorId !== undefined;

	// limit + 1 trick: fetch one extra row to detect whether a next page exists
	// without running a separate COUNT query (which is expensive on large tables).
	const params = [ownerId, limit + 1];
	let cursorClause = "";

	if (hasCursor) {
		params.push(cursorTime, cursorId);
		// Compound cursor: (created_at DESC, property_id ASC)
		// The row value comparison `(a, b) < ($3, $4)` in descending-first order
		// translates as: "rows where created_at is strictly earlier than cursorTime,
		// OR created_at equals cursorTime AND property_id is strictly after cursorId."
		// This correctly pages through newest-first results.
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
//
// Ownership is verified by embedding `AND owner_id = $N` in the UPDATE WHERE
// clause rather than doing a separate SELECT first. This is more efficient
// (one round-trip instead of two) and race-condition-free: there is no window
// between "check ownership" and "run the update" where another request could
// change the owner.
//
// rowCount = 0 is ambiguous here — it could mean the property doesn't exist OR
// it means it exists but belongs to another owner. We deliberately return 404
// for both cases to avoid leaking information about which property IDs exist.
// An attacker probing for valid property IDs learns nothing from the 404.
//
// amenityIds in the body triggers a full-replace of the junction table: DELETE
// all existing rows for this property, then re-insert the new set. Both the
// DELETE and the INSERT run inside the same transaction as the property UPDATE
// so the amenity set is never partially applied.

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

	// amenityIds is handled separately via junction table — not a scalar column.
	// Determine now (before the transaction) whether we need to touch amenities.
	const updateAmenities = body.amenityIds !== undefined;

	if (!setClauses.length && !updateAmenities) {
		throw new AppError("No valid fields provided for update", 400);
	}

	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		// Only run the properties UPDATE if there are scalar fields to update.
		// If only amenityIds was provided, skip the UPDATE entirely — running an
		// UPDATE with an empty SET clause is a PostgreSQL syntax error.
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
				// Either doesn't exist or doesn't belong to this owner — 404 either way
				throw new AppError("Property not found", 404);
			}
		} else {
			// No scalar fields to update — still need to verify ownership before
			// touching the amenity junction table.
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
			// Full-replace: wipe current amenity associations, then insert the new set.
			// DELETE is intentionally unconditional — an empty amenityIds array means
			// "remove all amenities," which is a valid and deliberate operation.
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
// The active-listing gate and the soft-delete must be atomic. We lock the target
// property row (SELECT ... FOR UPDATE), then check for active listings and set
// deleted_at in the same transaction. This closes the race where a concurrent
// listing mutation could slip between a standalone pre-check and the delete.

export const deleteProperty = async (ownerId, propertyId) => {
	await assertOwnerVerified(ownerId);

	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		// Lock target property row to prevent concurrent mutations while we
		// verify listing state and perform the soft-delete.
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

		const { rows: listingRows } = await client.query(
			`SELECT 1
       FROM listings
       WHERE property_id = $1
         AND status      = 'active'
         AND deleted_at IS NULL
       LIMIT 1`,
			[propertyId],
		);

		if (listingRows.length) {
			throw new AppError("Deactivate or remove all active listings before deleting this property", 409);
		}

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
