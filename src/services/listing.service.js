// src/services/listing.service.js
//
// ─── THE PAISE RULE ───────────────────────────────────────────────────────────
//
// rent_per_month and deposit_amount are stored in PAISE (smallest INR unit)
// in the database. 1 rupee = 100 paise. Rs 8,500/month → stored as 850,000.
//
// This file is the ONLY place where the conversion happens:
//   write path:  rupees × 100  before any INSERT or UPDATE
//   read path:   paise  ÷ 100  after any SELECT, before returning to caller
//
// Never convert in validators (they see rupees from the client).
// Never convert in controllers (they see the service's rupee output).
// Never convert in SQL expressions (keeps DB and app concerns separated).
// ─────────────────────────────────────────────────────────────────────────────

import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";
import { assertPgOwnerVerified } from "../db/utils/pgOwner.js";
import { findListingsNearPoint } from "../db/utils/spatial.js";
import { scoreListingsForUser } from "../db/utils/compatibility.js";

// ─── Private helpers ──────────────────────────────────────────────────────────

// Converts a raw DB row's paise fields to rupees for the API response.
// Called on every row before it leaves this service.
const toRupees = (listing) => {
	if (!listing) return null;
	return {
		...listing,
		rentPerMonth: listing.rent_per_month / 100,
		depositAmount: listing.deposit_amount / 100,
		// Drop the snake_case originals — the response uses camelCase
		rent_per_month: undefined,
		deposit_amount: undefined,
	};
};

// Bulk-inserts amenity links for a listing inside an open transaction.
// Identical pattern to bulkInsertAmenities in property.service.js but operates
// on listing_amenities instead of property_amenities. Not shared between files
// to avoid cross-service coupling — the function is small enough to tolerate
// the duplication.
const bulkInsertListingAmenities = async (client, listingId, amenityIds) => {
	if (!amenityIds.length) return;
	const placeholders = amenityIds.map((_, i) => `($1, $${i + 2})`).join(", ");
	await client.query(`INSERT INTO listing_amenities (listing_id, amenity_id) VALUES ${placeholders}`, [
		listingId,
		...amenityIds,
	]);
};

// Bulk-inserts preference rows for a listing inside an open transaction.
// preferences is an array of { preferenceKey, preferenceValue } objects.
// The UNIQUE (listing_id, preference_key) DB constraint handles duplicate key
// detection — a 23505 error from PostgreSQL surfaces as a 409 via the global
// error handler, with a message clear enough for the caller to understand.
const bulkInsertListingPreferences = async (client, listingId, preferences) => {
	if (!preferences.length) return;
	const placeholders = preferences.map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`).join(", ");
	const values = [
		listingId,
		...preferences.flatMap(({ preferenceKey, preferenceValue }) => [preferenceKey, preferenceValue]),
	];
	await client.query(
		`INSERT INTO listing_preferences (listing_id, preference_key, preference_value)
     VALUES ${placeholders}`,
		values,
	);
};

// Fetches a single listing with its full detail shape:
// own columns + amenities + preferences + cover photo + poster info +
// parent property info (for PG listings).
//
// Returns null if not found or soft-deleted. The caller decides whether null
// should surface as a 404 (GET by ID) or is an internal consistency error.
const fetchListingDetail = async (listingId, client = pool) => {
	const { rows } = await client.query(
		`SELECT
      l.listing_id,
      l.posted_by,
      l.property_id,
      l.listing_type,
      l.title,
      l.description,
      l.rent_per_month,
      l.deposit_amount,
      l.rent_includes_utilities,
      l.is_negotiable,
      l.room_type,
      l.bed_type,
      l.total_capacity,
      l.current_occupants,
      l.preferred_gender,
      l.available_from,
      l.available_until,
      l.address_line,
      l.city,
      l.locality,
      l.landmark,
      l.pincode,
      l.latitude,
      l.longitude,
      l.status,
      l.views_count,
      l.expires_at,
      l.created_at,
      l.updated_at,

      -- Poster's public profile (name + rating cache)
      u.average_rating   AS poster_rating,
      u.rating_count     AS poster_rating_count,
      COALESCE(sp.full_name, pop.owner_full_name) AS poster_name,

      -- Room-level amenities
      COALESCE(
        JSON_AGG(
          DISTINCT JSONB_BUILD_OBJECT(
            'amenityId', a.amenity_id,
            'name',      a.name,
            'category',  a.category,
            'iconName',  a.icon_name
          )
        ) FILTER (WHERE a.amenity_id IS NOT NULL),
        '[]'
      ) AS amenities,

      -- Listing preferences (roommate requirements)
      COALESCE(
        JSON_AGG(
          DISTINCT JSONB_BUILD_OBJECT(
            'preferenceKey',   lp.preference_key,
            'preferenceValue', lp.preference_value
          )
        ) FILTER (WHERE lp.preference_id IS NOT NULL),
        '[]'
      ) AS preferences,

      -- All photos ordered by display_order
      COALESCE(
        JSON_AGG(
          DISTINCT JSONB_BUILD_OBJECT(
            'photoId',     ph.photo_id,
            'photoUrl',    ph.photo_url,
            'isCover',     ph.is_cover,
            'displayOrder', ph.display_order
          ) ORDER BY (JSONB_BUILD_OBJECT(
            'photoId',     ph.photo_id,
            'photoUrl',    ph.photo_url,
            'isCover',     ph.is_cover,
            'displayOrder', ph.display_order
          ))
        ) FILTER (WHERE ph.photo_id IS NOT NULL),
        '[]'
      ) AS photos,

      -- Parent property (non-null for PG listings only)
      CASE WHEN p.property_id IS NOT NULL THEN
        JSONB_BUILD_OBJECT(
          'propertyId',   p.property_id,
          'propertyName', p.property_name,
          'propertyType', p.property_type,
          'addressLine',  p.address_line,
          'city',         p.city,
          'locality',     p.locality,
          'latitude',     p.latitude,
          'longitude',    p.longitude,
          'houseRules',   p.house_rules,
          'averageRating', p.average_rating,
          'ratingCount',   p.rating_count
        )
      ELSE NULL END AS property

    FROM listings l
    JOIN users u ON u.user_id = l.posted_by
    LEFT JOIN student_profiles sp  ON sp.user_id  = l.posted_by AND sp.deleted_at IS NULL
    LEFT JOIN pg_owner_profiles pop ON pop.user_id = l.posted_by AND pop.deleted_at IS NULL
    LEFT JOIN listing_amenities la ON la.listing_id = l.listing_id
    LEFT JOIN amenities a          ON a.amenity_id  = la.amenity_id
    LEFT JOIN listing_preferences lp ON lp.listing_id = l.listing_id
    LEFT JOIN listing_photos ph    ON ph.listing_id = l.listing_id AND ph.deleted_at IS NULL
    LEFT JOIN properties p         ON p.property_id = l.property_id AND p.deleted_at IS NULL
    WHERE l.listing_id = $1
      AND l.deleted_at IS NULL
    GROUP BY
      l.listing_id, u.average_rating, u.rating_count,
      sp.full_name, pop.owner_full_name, p.property_id,
      p.property_name, p.property_type, p.address_line, p.city,
      p.locality, p.latitude, p.longitude, p.house_rules,
      p.average_rating, p.rating_count`,
		[listingId],
	);

	return rows[0] ?? null;
};

// ─── Create listing ───────────────────────────────────────────────────────────

export const createListing = async (posterId, posterRoles, body) => {
	const isPgOwner = posterRoles.includes("pg_owner");
	const isStudent = posterRoles.includes("student");

	// Enforce the right actor for the right listing type
	if ((body.listingType === "pg_room" || body.listingType === "hostel_bed") && !isPgOwner) {
		throw new AppError("Only verified PG owners can create pg_room or hostel_bed listings", 403);
	}
	if (body.listingType === "student_room" && !isStudent) {
		throw new AppError("Only students can create student_room listings", 403);
	}

	// PG owner path: verify account + verify property ownership
	if (isPgOwner && body.listingType !== "student_room") {
		await assertPgOwnerVerified(posterId);

		const { rows: propRows } = await pool.query(
			`SELECT 1
       FROM properties
       WHERE property_id = $1
         AND owner_id    = $2
         AND deleted_at IS NULL`,
			[body.propertyId, posterId],
		);
		if (!propRows.length) {
			throw new AppError("Property not found or does not belong to you", 404);
		}
	}

	// ── Paise conversion ──────────────────────────────────────────────────────
	// Multiply here, once, before the INSERT. Never touches validators or controller.
	const rentPaise = body.rentPerMonth * 100;
	const depositPaise = body.depositAmount * 100;

	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		// For student listings, property_id is hardcoded NULL regardless of what
		// the request body contains. The validator already rejects propertyId on
		// student_room requests, but this is a belt-and-suspenders guarantee.
		const propertyId = body.listingType === "student_room" ? null : body.propertyId;

		// expires_at is ALWAYS set server-side. Never from the request body.
		// Using the interval expression directly in SQL ensures the timestamp is
		// computed at the exact moment the row is written — not moments before
		// due to JavaScript processing latency.
		const { rows } = await client.query(
			`INSERT INTO listings (
        posted_by,
        property_id,
        listing_type,
        title,
        description,
        rent_per_month,
        deposit_amount,
        rent_includes_utilities,
        is_negotiable,
        room_type,
        bed_type,
        total_capacity,
        preferred_gender,
        available_from,
        available_until,
        address_line,
        city,
        locality,
        landmark,
        pincode,
        latitude,
        longitude,
        expires_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18, $19, $20, $21, $22,
        NOW() + INTERVAL '60 days'
      )
      RETURNING listing_id`,
			[
				posterId,
				propertyId,
				body.listingType,
				body.title,
				body.description ?? null,
				rentPaise,
				depositPaise,
				body.rentIncludesUtilities,
				body.isNegotiable,
				body.roomType,
				body.bedType ?? null,
				body.totalCapacity,
				body.preferredGender ?? null,
				body.availableFrom,
				body.availableUntil ?? null,
				// Address fields: populated for student listings, null for PG listings
				body.listingType === "student_room" ? body.addressLine : null,
				body.listingType === "student_room" ? body.city : null,
				body.listingType === "student_room" ? (body.locality ?? null) : null,
				body.listingType === "student_room" ? (body.landmark ?? null) : null,
				body.listingType === "student_room" ? (body.pincode ?? null) : null,
				body.listingType === "student_room" ? (body.latitude ?? null) : null,
				body.listingType === "student_room" ? (body.longitude ?? null) : null,
			],
		);

		const listingId = rows[0].listing_id;

		// All three child-table inserts are in the same transaction as the parent.
		// Any FK violation (invalid amenity_id → 23503) rolls back the listing too.
		await bulkInsertListingAmenities(client, listingId, body.amenityIds);
		await bulkInsertListingPreferences(client, listingId, body.preferences);

		await client.query("COMMIT");

		logger.info(
			{
				posterId,
				listingId,
				listingType: body.listingType,
				amenityCount: body.amenityIds.length,
				preferenceCount: body.preferences.length,
			},
			"Listing created",
		);

		const listing = await fetchListingDetail(listingId);
		return toRupees(listing);
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
};

// ─── Get listing ──────────────────────────────────────────────────────────────

export const getListing = async (listingId) => {
	const listing = await fetchListingDetail(listingId);
	if (!listing) throw new AppError("Listing not found", 404);

	// Increment views_count asynchronously — fire and forget.
	// We do NOT await this. View counts are analytics, not transactional data.
	// A failed increment is invisible to the user and not worth blocking the
	// response for. The pool.query() call returns a Promise — we intentionally
	// let it float without catching it; any error goes to the pool's error event,
	// which is already handled by the logger in db/client.js.
	pool.query(`UPDATE listings SET views_count = views_count + 1 WHERE listing_id = $1`, [listingId]);

	return toRupees(listing);
};

// ─── Search listings ──────────────────────────────────────────────────────────

export const searchListings = async (userId, filters) => {
	const {
		city,
		minRent,
		maxRent,
		roomType,
		bedType,
		preferredGender,
		listingType,
		availableFrom,
		lat,
		lng,
		radius,
		amenityIds,
		cursorTime,
		cursorId,
		limit,
	} = filters;

	// ── Step 1: Proximity pre-filter ──────────────────────────────────────────
	// If coordinates were provided, run the PostGIS spatial query first to get
	// the set of listing IDs that fall within the radius. These IDs are then
	// added as an AND filter on the main query. Running proximity as a pre-filter
	// rather than a JOIN on the main query keeps the query planner's job simpler
	// and lets the GiST index do its work in isolation.
	let proximityIds = null;
	if (lat !== undefined && lng !== undefined) {
		proximityIds = await findListingsNearPoint(lat, lng, radius);
		// If proximity returns zero results, the main query will also return zero.
		// Short-circuit immediately rather than running a no-op main query.
		if (!proximityIds.length) {
			return { items: [], nextCursor: null };
		}
	}

	// ── Step 2: Dynamic WHERE clause construction ─────────────────────────────
	// Start with the baseline conditions that are always present.
	// Every additional filter appends a clause and its value into params[].
	// This produces a single parameterised query that the planner can optimise
	// with composite index scans — never multiple queries merged in JavaScript.
	const clauses = [
		`l.status = 'active'`,
		`l.deleted_at IS NULL`,
		`l.expires_at > NOW()`, // Exclude listings that have auto-expired
	];
	const params = [];
	let p = 1; // Tracks the current $N position

	if (city !== undefined) {
		clauses.push(`l.city ILIKE $${p}`);
		params.push(`%${city}%`);
		p++;
	}

	if (minRent !== undefined) {
		// Convert rupees → paise for the comparison. The DB stores paise.
		clauses.push(`l.rent_per_month >= $${p}`);
		params.push(minRent * 100);
		p++;
	}

	if (maxRent !== undefined) {
		clauses.push(`l.rent_per_month <= $${p}`);
		params.push(maxRent * 100);
		p++;
	}

	if (roomType !== undefined) {
		clauses.push(`l.room_type = $${p}`);
		params.push(roomType);
		p++;
	}

	if (bedType !== undefined) {
		clauses.push(`l.bed_type = $${p}`);
		params.push(bedType);
		p++;
	}

	if (preferredGender !== undefined) {
		// (preferred_gender = X OR preferred_gender IS NULL) returns listings that
		// explicitly accept this gender AND listings open to all genders.
		clauses.push(`(l.preferred_gender = $${p} OR l.preferred_gender IS NULL)`);
		params.push(preferredGender);
		p++;
	}

	if (listingType !== undefined) {
		clauses.push(`l.listing_type = $${p}`);
		params.push(listingType);
		p++;
	}

	if (availableFrom !== undefined) {
		// Listings available on or before the requested move-in date
		clauses.push(`l.available_from <= $${p}`);
		params.push(availableFrom);
		p++;
	}

	if (proximityIds !== null) {
		// ANY($N::uuid[]) is a single typed parameter regardless of array size —
		// more robust than building a dynamic IN ($1, $2, $3, ...) clause.
		clauses.push(`l.listing_id = ANY($${p}::uuid[])`);
		params.push(proximityIds);
		p++;
	}

	// Amenity filter: one EXISTS subquery per requested amenity (AND semantics).
	// Each subquery independently checks that this listing has this specific amenity.
	// Correct AND behaviour: listing must have ALL requested amenities, not just one.
	for (const amenityId of amenityIds) {
		clauses.push(
			`EXISTS (
        SELECT 1 FROM listing_amenities la_f
        WHERE la_f.listing_id = l.listing_id
          AND la_f.amenity_id = $${p}
      )`,
		);
		params.push(amenityId);
		p++;
	}

	// Keyset cursor: newest-first (created_at DESC, listing_id ASC)
	const hasCursor = cursorTime !== undefined && cursorId !== undefined;
	if (hasCursor) {
		clauses.push(`(l.created_at < $${p} OR (l.created_at = $${p} AND l.listing_id > $${p + 1}::uuid))`);
		params.push(cursorTime, cursorId);
		p += 2;
	}

	// Limit + 1 for next-page detection
	params.push(limit + 1);
	const limitParam = p;

	// ── Step 3: Main search query ─────────────────────────────────────────────
	// The cover_photo_url subquery avoids a JOIN + GROUP BY — it fetches the
	// single cover photo URL as a scalar subquery per row.
	//
	// average_rating comes from the property for PG listings, from the poster
	// (users table) for student listings. COALESCE handles the NULL property_id
	// case elegantly — when property_id IS NULL (student listing), p.average_rating
	// is NULL, and COALESCE falls through to u.average_rating.
	const { rows } = await pool.query(
		`SELECT
      l.listing_id,
      l.posted_by,
      l.property_id,
      l.listing_type,
      l.title,
      l.city,
      l.locality,
      l.rent_per_month,
      l.deposit_amount,
      l.room_type,
      l.preferred_gender,
      l.available_from,
      l.status,
      l.created_at,
      COALESCE(p.property_name, NULL) AS property_name,
      COALESCE(p.average_rating, u.average_rating) AS average_rating,
      (
        SELECT ph.photo_url
        FROM listing_photos ph
        WHERE ph.listing_id = l.listing_id
          AND ph.is_cover   = TRUE
          AND ph.deleted_at IS NULL
        LIMIT 1
      ) AS cover_photo_url
    FROM listings l
    JOIN users u ON u.user_id = l.posted_by
    LEFT JOIN properties p ON p.property_id = l.property_id AND p.deleted_at IS NULL
    WHERE ${clauses.join(" AND ")}
    ORDER BY l.created_at DESC, l.listing_id ASC
    LIMIT $${limitParam}`,
		params,
	);

	const hasNextPage = rows.length > limit;
	const items = hasNextPage ? rows.slice(0, limit) : rows;

	// ── Step 4: Compatibility scoring ─────────────────────────────────────────
	// Run after the main query — operates only on the page of results, never
	// on the full result set. Bounded by limit (max 100) so this is always fast.
	const listingIds = items.map((r) => r.listing_id);
	const scoreMap = await scoreListingsForUser(userId, listingIds);

	// ── Step 5: Assemble response ─────────────────────────────────────────────
	const enrichedItems = items.map((row) => ({
		...row,
		rentPerMonth: row.rent_per_month / 100,
		depositAmount: row.deposit_amount / 100,
		rent_per_month: undefined,
		deposit_amount: undefined,
		compatibilityScore: scoreMap[row.listing_id] ?? 0,
	}));

	const nextCursor =
		hasNextPage ?
			{
				cursorTime: items[items.length - 1].created_at.toISOString(),
				cursorId: items[items.length - 1].listing_id,
			}
		:	null;

	return { items: enrichedItems, nextCursor };
};

// ─── Update listing ───────────────────────────────────────────────────────────

export const updateListing = async (posterId, listingId, body) => {
	const columnMap = {
		title: "title",
		description: "description",
		// rent and deposit handled separately (need paise conversion)
		rentIncludesUtilities: "rent_includes_utilities",
		isNegotiable: "is_negotiable",
		roomType: "room_type",
		bedType: "bed_type",
		totalCapacity: "total_capacity",
		preferredGender: "preferred_gender",
		availableFrom: "available_from",
		availableUntil: "available_until",
		addressLine: "address_line",
		city: "city",
		locality: "locality",
		landmark: "landmark",
		pincode: "pincode",
		latitude: "latitude",
		longitude: "longitude",
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

	// Paise conversion for monetary fields
	if (body.rentPerMonth !== undefined) {
		setClauses.push(`rent_per_month = $${paramIndex}`);
		values.push(body.rentPerMonth * 100);
		paramIndex++;
	}
	if (body.depositAmount !== undefined) {
		setClauses.push(`deposit_amount = $${paramIndex}`);
		values.push(body.depositAmount * 100);
		paramIndex++;
	}

	const updateAmenities = body.amenityIds !== undefined;
	const updatePreferences = body.preferences !== undefined;

	if (!setClauses.length && !updateAmenities && !updatePreferences) {
		throw new AppError("No valid fields provided for update", 400);
	}

	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		if (setClauses.length) {
			values.push(listingId, posterId);
			const { rowCount } = await client.query(
				`UPDATE listings
         SET ${setClauses.join(", ")}
         WHERE listing_id = $${paramIndex}
           AND posted_by  = $${paramIndex + 1}
           AND deleted_at IS NULL`,
				values,
			);
			if (rowCount === 0) throw new AppError("Listing not found", 404);
		} else {
			// No scalar fields — still need to verify ownership before touching
			// child tables
			const { rows } = await client.query(
				`SELECT 1 FROM listings
         WHERE listing_id = $1
           AND posted_by  = $2
           AND deleted_at IS NULL`,
				[listingId, posterId],
			);
			if (!rows.length) throw new AppError("Listing not found", 404);
		}

		if (updateAmenities) {
			await client.query(`DELETE FROM listing_amenities WHERE listing_id = $1`, [listingId]);
			await bulkInsertListingAmenities(client, listingId, body.amenityIds);
		}

		if (updatePreferences) {
			await client.query(`DELETE FROM listing_preferences WHERE listing_id = $1`, [listingId]);
			await bulkInsertListingPreferences(client, listingId, body.preferences);
		}

		await client.query("COMMIT");
		logger.info({ posterId, listingId }, "Listing updated");

		const listing = await fetchListingDetail(listingId);
		return toRupees(listing);
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
};

// ─── Delete listing (soft) ────────────────────────────────────────────────────

export const deleteListing = async (posterId, listingId) => {
	// Gate: cannot soft-delete a listing that has open interest requests.
	// Deleting while requests are pending leaves the sender with an orphaned
	// request they cannot act on, and the poster would receive no more
	// notifications for it. Require the poster to decline all pending requests
	// first — this is a deliberate UX choice that forces communication.
	const { rows: requestRows } = await pool.query(
		`SELECT 1
     FROM interest_requests
     WHERE listing_id = $1
       AND status IN ('pending', 'accepted')
       AND deleted_at IS NULL
     LIMIT 1`,
		[listingId],
	);

	if (requestRows.length) {
		throw new AppError("Decline or withdraw all active interest requests before deleting this listing", 409);
	}

	const { rowCount } = await pool.query(
		`UPDATE listings
     SET deleted_at = NOW()
     WHERE listing_id = $1
       AND posted_by  = $2
       AND deleted_at IS NULL`,
		[listingId, posterId],
	);

	if (rowCount === 0) throw new AppError("Listing not found", 404);

	logger.info({ posterId, listingId }, "Listing soft-deleted");
	return { listingId, deleted: true };
};

// ─── Listing preferences (standalone) ────────────────────────────────────────

export const getListingPreferences = async (listingId) => {
	// Verify the listing exists (any authenticated user can read preferences)
	const { rows: listingCheck } = await pool.query(
		`SELECT 1 FROM listings WHERE listing_id = $1 AND deleted_at IS NULL`,
		[listingId],
	);
	if (!listingCheck.length) throw new AppError("Listing not found", 404);

	const { rows } = await pool.query(
		`SELECT preference_key AS "preferenceKey", preference_value AS "preferenceValue"
     FROM listing_preferences
     WHERE listing_id = $1
     ORDER BY preference_key`,
		[listingId],
	);
	return rows;
};

export const updateListingPreferences = async (posterId, listingId, preferences) => {
	// Ownership check embedded in query
	const { rows: ownerCheck } = await pool.query(
		`SELECT 1 FROM listings
     WHERE listing_id = $1 AND posted_by = $2 AND deleted_at IS NULL`,
		[listingId, posterId],
	);
	if (!ownerCheck.length) throw new AppError("Listing not found", 404);

	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query(`DELETE FROM listing_preferences WHERE listing_id = $1`, [listingId]);
		await bulkInsertListingPreferences(client, listingId, preferences);
		await client.query("COMMIT");

		logger.info({ posterId, listingId }, "Listing preferences updated");
		return await getListingPreferences(listingId);
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
};

// ─── Save / unsave listing ────────────────────────────────────────────────────

export const saveListing = async (userId, listingId) => {
	// Verify the listing is active before allowing a save.
	// Saving a deactivated or expired listing creates a misleading bookmark.
	const { rows: listingCheck } = await pool.query(
		`SELECT 1 FROM listings
     WHERE listing_id = $1
       AND status     = 'active'
       AND deleted_at IS NULL`,
		[listingId],
	);
	if (!listingCheck.length) {
		throw new AppError("Listing not found or no longer active", 404);
	}

	// UPSERT handles three cases in one atomic operation:
	//   1. Fresh save: row doesn't exist → INSERT
	//   2. Already saved: row exists with deleted_at IS NULL → DO UPDATE is a
	//      no-op because saved_at stays the same (idempotent)
	//   3. Re-save after unsave: row exists with deleted_at NOT NULL → clear
	//      deleted_at and refresh saved_at
	//
	// This single statement replaces what would otherwise be a SELECT + branch
	// + INSERT or UPDATE — three round-trips with a TOCTOU race window.
	await pool.query(
		`INSERT INTO saved_listings (user_id, listing_id, saved_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id, listing_id)
     DO UPDATE SET deleted_at = NULL, saved_at = NOW()`,
		[userId, listingId],
	);

	logger.info({ userId, listingId }, "Listing saved");
	return { listingId, saved: true };
};

export const unsaveListing = async (userId, listingId) => {
	const { rowCount } = await pool.query(
		`UPDATE saved_listings
     SET deleted_at = NOW()
     WHERE user_id    = $1
       AND listing_id = $2
       AND deleted_at IS NULL`,
		[userId, listingId],
	);

	// rowCount === 0 means either never saved or already unsaved — both map to
	// a no-op rather than a 404 so unsave is idempotent from the client's perspective.
	logger.info({ userId, listingId }, "Listing unsaved");
	return { listingId, saved: false };
};

export const getSavedListings = async (userId, { cursorTime, cursorId, limit = 20 }) => {
	const hasCursor = cursorTime !== undefined && cursorId !== undefined;
	const params = [userId, limit + 1];
	let cursorClause = "";

	if (hasCursor) {
		params.push(cursorTime, cursorId);
		// Newest-saved-first: (saved_at DESC, listing_id ASC)
		cursorClause = `AND (sl.saved_at < $3 OR (sl.saved_at = $3 AND sl.listing_id > $4::uuid))`;
	}

	// Silently omit listings that have since expired, been filled, or been
	// deactivated. The client never sees an error about stale saves — the listing
	// simply disappears from the feed. This is the correct UX: a saved listing
	// that is no longer available should not pollute the student's shortlist.
	const { rows } = await pool.query(
		`SELECT
      l.listing_id,
      l.listing_type,
      l.title,
      l.city,
      l.locality,
      l.rent_per_month,
      l.deposit_amount,
      l.room_type,
      l.preferred_gender,
      l.available_from,
      l.status,
      sl.saved_at,
      COALESCE(p.property_name, NULL)     AS property_name,
      COALESCE(p.average_rating, u.average_rating) AS average_rating,
      (
        SELECT ph.photo_url
        FROM listing_photos ph
        WHERE ph.listing_id = l.listing_id
          AND ph.is_cover   = TRUE
          AND ph.deleted_at IS NULL
        LIMIT 1
      ) AS cover_photo_url
    FROM saved_listings sl
    JOIN listings l  ON l.listing_id  = sl.listing_id
    JOIN users u     ON u.user_id     = l.posted_by
    LEFT JOIN properties p ON p.property_id = l.property_id AND p.deleted_at IS NULL
    WHERE sl.user_id    = $1
      AND sl.deleted_at IS NULL
      AND l.status      = 'active'
      AND l.deleted_at  IS NULL
      ${cursorClause}
    ORDER BY sl.saved_at DESC, l.listing_id ASC
    LIMIT $2`,
		params,
	);

	const hasNextPage = rows.length > limit;
	const items = hasNextPage ? rows.slice(0, limit) : rows;

	const mappedItems = items.map((row) => ({
		...row,
		rentPerMonth: row.rent_per_month / 100,
		depositAmount: row.deposit_amount / 100,
		rent_per_month: undefined,
		deposit_amount: undefined,
	}));

	const nextCursor =
		hasNextPage ?
			{
				cursorTime: items[items.length - 1].saved_at.toISOString(),
				cursorId: items[items.length - 1].listing_id,
			}
		:	null;

	return { items: mappedItems, nextCursor };
};
