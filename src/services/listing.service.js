// src/services/listing.service.js

import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";
import { assertPgOwnerVerified } from "../db/utils/pgOwner.js";
import { scoreListingsForUser } from "../db/utils/compatibility.js";
import { expirePendingRequestsForListing } from "./interest.service.js";
import { EXPIRED_LISTING_MESSAGE, UNAVAILABLE_LISTING_MESSAGE } from "./listingLifecycle.js";
import { dedupePreferencesByKey } from "../config/preferences.js";

const PROPERTY_OWNED_LOCATION_FIELDS = new Set([
	"addressLine",
	"city",
	"locality",
	"landmark",
	"pincode",
	"latitude",
	"longitude",
]);

const toRupees = (listing) => {
	if (!listing) return null;
	return {
		...listing,
		rentPerMonth: listing.rent_per_month / 100,
		depositAmount: listing.deposit_amount / 100,
		rent_per_month: undefined,
		deposit_amount: undefined,
	};
};

const rentDeviationPct = (rentPaise, p50Paise) => {
	if (p50Paise == null || p50Paise === 0) return null;
	return Math.round(((rentPaise - p50Paise) / p50Paise) * 100);
};
// Helper that converts paise rent-index fields to rupees for the JSON response.
const formatRentIndex = (row) => {
	if (row.ri_p50 == null) return null;
	return {
		p25: Math.round(row.ri_p25 / 100),
		p50: Math.round(row.ri_p50 / 100),
		p75: Math.round(row.ri_p75 / 100),
		sampleCount: row.ri_sample_count,
		resolution: row.ri_resolution, // 'locality' | 'city' | null
	};
};

const bulkInsertListingAmenities = async (client, listingId, amenityIds) => {
	if (!amenityIds.length) return;
	const placeholders = amenityIds.map((_, i) => `($1, $${i + 2})`).join(", ");
	await client.query(`INSERT INTO listing_amenities (listing_id, amenity_id) VALUES ${placeholders}`, [
		listingId,
		...amenityIds,
	]);
};

const bulkInsertListingPreferences = async (client, listingId, preferences) => {
	if (!preferences.length) return;
	const canonicalPreferences = dedupePreferencesByKey(preferences);
	if (!canonicalPreferences.length) return;

	const placeholders = canonicalPreferences.map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`).join(", ");
	const values = [
		listingId,
		...canonicalPreferences.flatMap(({ preferenceKey, preferenceValue }) => [preferenceKey, preferenceValue]),
	];
	await client.query(
		`INSERT INTO listing_preferences (listing_id, preference_key, preference_value)
     VALUES ${placeholders}`,
		values,
	);
};

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

      u.average_rating   AS poster_rating,
      u.rating_count     AS poster_rating_count,
      COALESCE(sp.full_name, pop.owner_full_name) AS poster_name,

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

      COALESCE(
        JSON_AGG(
          DISTINCT JSONB_BUILD_OBJECT(
            'preferenceKey',   lp.preference_key,
            'preferenceValue', lp.preference_value
          )
        ) FILTER (WHERE lp.preference_id IS NOT NULL),
        '[]'
      ) AS preferences,

      (
        SELECT COALESCE(
          JSON_AGG(
            JSONB_BUILD_OBJECT(
              'photoId',      ph.photo_id,
              'photoUrl',     ph.photo_url,
              'isCover',      ph.is_cover,
              'displayOrder', ph.display_order
            ) ORDER BY ph.display_order ASC, ph.photo_id ASC
          ),
          '[]'
        )
        FROM listing_photos ph
        WHERE ph.listing_id = l.listing_id
          AND ph.deleted_at IS NULL
          AND ph.photo_url NOT LIKE 'processing:%'
      ) AS photos,

      CASE WHEN p.property_id IS NOT NULL THEN
        JSONB_BUILD_OBJECT(
          'propertyId',    p.property_id,
          'propertyName',  p.property_name,
          'propertyType',  p.property_type,
          'addressLine',   p.address_line,
          'city',          p.city,
          'locality',      p.locality,
          'latitude',      p.latitude,
          'longitude',     p.longitude,
          'houseRules',    p.house_rules,
          'averageRating', p.average_rating,
          'ratingCount',   p.rating_count
        )
      ELSE NULL END AS property,

      -- Rent index (locality-level preferred, city-wide fallback)
      COALESCE(ri_loc.p25,          ri_city.p25)          AS ri_p25,
      COALESCE(ri_loc.p50,          ri_city.p50)          AS ri_p50,
      COALESCE(ri_loc.p75,          ri_city.p75)          AS ri_p75,
      COALESCE(ri_loc.sample_count, ri_city.sample_count) AS ri_sample_count,
      CASE
        WHEN ri_loc.rent_index_id  IS NOT NULL THEN 'locality'
        WHEN ri_city.rent_index_id IS NOT NULL THEN 'city'
        ELSE NULL
      END AS ri_resolution

    FROM listings l
    JOIN users u ON u.user_id = l.posted_by
    LEFT JOIN student_profiles sp   ON sp.user_id   = l.posted_by AND sp.deleted_at IS NULL
    LEFT JOIN pg_owner_profiles pop ON pop.user_id  = l.posted_by AND pop.deleted_at IS NULL
    LEFT JOIN listing_amenities la  ON la.listing_id = l.listing_id
    LEFT JOIN amenities a           ON a.amenity_id  = la.amenity_id
    LEFT JOIN listing_preferences lp ON lp.listing_id = l.listing_id
    LEFT JOIN properties p          ON p.property_id  = l.property_id AND p.deleted_at IS NULL
    LEFT JOIN rent_index ri_loc
      ON ri_loc.city      = l.city
     AND ri_loc.locality  = NULLIF(LOWER(TRIM(COALESCE(l.locality, ''))), '')
     AND ri_loc.room_type = l.room_type
    LEFT JOIN rent_index ri_city
      ON ri_city.city      = l.city
     AND ri_city.locality  IS NULL
     AND ri_city.room_type = l.room_type
    WHERE l.listing_id = $1
      AND l.deleted_at IS NULL
    GROUP BY
      l.listing_id, u.average_rating, u.rating_count,
      sp.full_name, pop.owner_full_name, p.property_id,
      p.property_name, p.property_type, p.address_line, p.city,
      p.locality, p.latitude, p.longitude, p.house_rules,
      p.average_rating, p.rating_count,
      ri_loc.p25, ri_loc.p50, ri_loc.p75, ri_loc.sample_count, ri_loc.rent_index_id,
      ri_city.p25, ri_city.p50, ri_city.p75, ri_city.sample_count, ri_city.rent_index_id`,
		[listingId],
	);

	return rows[0] ?? null;
};

export const createListing = async (posterId, posterRoles, body) => {
	const isPgOwner = posterRoles.includes("pg_owner");
	const isStudent = posterRoles.includes("student");

	if ((body.listingType === "pg_room" || body.listingType === "hostel_bed") && !isPgOwner) {
		throw new AppError("Only verified PG owners can create pg_room or hostel_bed listings", 403);
	}
	if (body.listingType === "student_room" && !isStudent) {
		throw new AppError("Only students can create student_room listings", 403);
	}

	let propertyCity = null;
	if (isPgOwner && body.listingType !== "student_room") {
		await assertPgOwnerVerified(posterId);

		const { rows: propRows } = await pool.query(
			`SELECT city
       FROM properties
       WHERE property_id = $1
         AND owner_id    = $2
         AND deleted_at IS NULL`,
			[body.propertyId, posterId],
		);
		if (!propRows.length) {
			throw new AppError("Property not found or does not belong to you", 404);
		}
		propertyCity = propRows[0].city;
	}

	const rentPaise = body.rentPerMonth * 100;
	const depositPaise = body.depositAmount * 100;

	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		const propertyId = body.listingType === "student_room" ? null : body.propertyId;
		const city = body.listingType === "student_room" ? body.city : propertyCity;

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
        $1, $2, $3::listing_type_enum, $4, $5, $6, $7, $8, $9, $10::room_type_enum,
        $11::bed_type_enum, $12, $13::gender_enum,
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
				body.listingType === "student_room" ? body.addressLine : null,
				city,
				body.listingType === "student_room" ? (body.locality ?? null) : null,
				body.listingType === "student_room" ? (body.landmark ?? null) : null,
				body.listingType === "student_room" ? (body.pincode ?? null) : null,
				body.listingType === "student_room" ? (body.latitude ?? null) : null,
				body.listingType === "student_room" ? (body.longitude ?? null) : null,
			],
		);

		const listingId = rows[0].listing_id;

		await bulkInsertListingAmenities(client, listingId, body.amenityIds ?? []);
		await bulkInsertListingPreferences(client, listingId, body.preferences ?? []);

		await client.query("COMMIT");

		logger.info(
			{
				posterId,
				listingId,
				listingType: body.listingType,
				amenityCount: (body.amenityIds ?? []).length,
				preferenceCount: (body.preferences ?? []).length,
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

export const getListing = async (listingId) => {
	const listing = await fetchListingDetail(listingId);
	if (!listing) throw new AppError("Listing not found", 404);

	// Increment view count fire-and-forget
	void pool
		.query(`UPDATE listings SET views_count = views_count + 1 WHERE listing_id = $1`, [listingId])
		.catch((err) => {
			logger.warn({ err, listingId }, "Failed to increment listing view count");
		});

	const converted = toRupees(listing);

	return {
		...converted,
		rentDeviation: rentDeviationPct(listing.rent_per_month, listing.ri_p50),
		rentIndex: formatRentIndex(listing),
	};
};

export const searchListings = async (userId, filters) => {
	const {
		sortBy = "recent",
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
		amenityIds = [],
		cursorTime,
		cursorId,
		limit = 20,
	} = filters;

	const clauses = [`l.status = 'active'`, `l.deleted_at IS NULL`, `l.expires_at > NOW()`];
	const params = [];
	let p = 1;

	if (lat !== undefined && lng !== undefined) {
		clauses.push(
			`ST_DWithin(
        COALESCE(l.location, p.location)::geography,
        ST_SetSRID(ST_MakePoint($${p + 1}, $${p}), 4326)::geography,
        $${p + 2}
      )`,
		);
		params.push(lat, lng, radius);
		p += 3;
	}

	if (city !== undefined) {
		const escapedCity = city.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
		clauses.push(`LOWER(l.city) LIKE LOWER($${p}) ESCAPE '\\'`);
		params.push(`${escapedCity}%`);
		p++;
	}

	if (minRent !== undefined) {
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
		clauses.push(`l.room_type = $${p}::room_type_enum`);
		params.push(roomType);
		p++;
	}

	if (bedType !== undefined) {
		clauses.push(`l.bed_type = $${p}::bed_type_enum`);
		params.push(bedType);
		p++;
	}

	if (preferredGender !== undefined) {
		clauses.push(`(l.preferred_gender = $${p}::gender_enum OR l.preferred_gender IS NULL)`);
		params.push(preferredGender);
		p++;
	}

	if (listingType !== undefined) {
		clauses.push(`l.listing_type = $${p}::listing_type_enum`);
		params.push(listingType);
		p++;
	}

	if (availableFrom !== undefined) {
		clauses.push(`l.available_from <= $${p}`);
		params.push(availableFrom);
		p++;
	}

	if (amenityIds.length > 0) {
		const uniqueAmenityIds = [...new Set(amenityIds)];
		clauses.push(
			`EXISTS (
        SELECT 1
        FROM listing_amenities la_f
        WHERE la_f.listing_id = l.listing_id
          AND la_f.amenity_id = ANY($${p}::uuid[])
        GROUP BY la_f.listing_id
        HAVING COUNT(DISTINCT la_f.amenity_id) = $${p + 1}
      )`,
		);
		params.push(uniqueAmenityIds, uniqueAmenityIds.length);
		p += 2;
	}

	const hasCursor = cursorTime !== undefined && cursorId !== undefined;
	if (hasCursor && sortBy === "recent") {
		clauses.push(`(l.created_at < $${p} OR (l.created_at = $${p} AND l.listing_id > $${p + 1}::uuid))`);
		params.push(cursorTime, cursorId);
		p += 2;
	}

	params.push(limit + 1);
	const limitParam = p;

	// ── CHANGED: added rent_index LEFT JOINs and ri_p50 / ri_resolution columns ──
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
          AND ph.photo_url NOT LIKE 'processing:%'
        LIMIT 1
      ) AS cover_photo_url,
      -- Rent index (locality-level preferred, city-wide fallback)
      COALESCE(ri_loc.p50,  ri_city.p50)  AS ri_p50,
      CASE
        WHEN ri_loc.rent_index_id  IS NOT NULL THEN 'locality'
        WHEN ri_city.rent_index_id IS NOT NULL THEN 'city'
        ELSE NULL
      END AS ri_resolution
    FROM listings l
    JOIN users u ON u.user_id = l.posted_by
    LEFT JOIN properties p ON p.property_id = l.property_id AND p.deleted_at IS NULL
    LEFT JOIN rent_index ri_loc
      ON ri_loc.city      = l.city
     AND ri_loc.locality  = NULLIF(LOWER(TRIM(COALESCE(l.locality, ''))), '')
     AND ri_loc.room_type = l.room_type
    LEFT JOIN rent_index ri_city
      ON ri_city.city      = l.city
     AND ri_city.locality  IS NULL
     AND ri_city.room_type = l.room_type
    WHERE ${clauses.join(" AND ")}
    ORDER BY l.created_at DESC, l.listing_id ASC
    LIMIT $${limitParam}`,
		params,
	);
	// ── END CHANGED section ───────────────────────────────────────────────────

	const hasNextPage = rows.length > limit;
	const items = hasNextPage ? rows.slice(0, limit) : rows;

	let scoreMap = {};
	let userHasPreferences = false;
	let listingPreferenceCounts = new Map();

	if (userId !== null) {
		const listingIds = items.map((r) => r.listing_id);
		scoreMap = await scoreListingsForUser(userId, listingIds);

		const { rows: preferenceRows } = await pool.query(
			`SELECT EXISTS (
        SELECT 1 FROM user_preferences WHERE user_id = $1
      ) AS has_preferences`,
			[userId],
		);
		userHasPreferences = preferenceRows[0]?.has_preferences === true;

		if (listingIds.length) {
			const { rows: listingPreferenceRows } = await pool.query(
				`SELECT listing_id, COUNT(*)::int AS preference_count
         FROM listing_preferences
         WHERE listing_id = ANY($1::uuid[])
         GROUP BY listing_id`,
				[listingIds],
			);

			listingPreferenceCounts = new Map(
				listingPreferenceRows.map((row) => [row.listing_id, Number(row.preference_count)]),
			);
		}
	}

	// ── CHANGED: added rentDeviation to each enriched item ───────────────────
	const enrichedItems = items.map((row) => ({
		...row,
		rentPerMonth: row.rent_per_month / 100,
		depositAmount: row.deposit_amount / 100,
		rent_per_month: undefined,
		deposit_amount: undefined,
		compatibilityScore: userId !== null ? (scoreMap[row.listing_id] ?? 0) : 0,
		compatibilityAvailable:
			userId !== null && userHasPreferences && (listingPreferenceCounts.get(row.listing_id) ?? 0) > 0,
		// New: rent deviation as a percentage relative to local median
		rentDeviation: rentDeviationPct(row.rent_per_month, row.ri_p50),
		ri_p50: undefined,
		ri_resolution: undefined,
	}));
	// ── END CHANGED section ───────────────────────────────────────────────────

	if (sortBy === "compatibility") {
		enrichedItems.sort((a, b) => b.compatibilityScore - a.compatibilityScore);
		return { items: enrichedItems, nextCursor: null };
	}

	const nextCursor =
		hasNextPage ?
			{
				cursorTime: items[items.length - 1].created_at.toISOString(),
				cursorId: items[items.length - 1].listing_id,
			}
		:	null;

	return { items: enrichedItems, nextCursor };
};

export const updateListing = async (posterId, listingId, body) => {
	const columnMap = {
		title: "title",
		description: "description",
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

	const enumCasts = {
		room_type: "::room_type_enum",
		bed_type: "::bed_type_enum",
		preferred_gender: "::gender_enum",
	};

	const setClauses = [];
	const values = [];
	let paramIndex = 1;

	for (const [key, column] of Object.entries(columnMap)) {
		if (body[key] !== undefined) {
			const cast = enumCasts[column] ?? "";
			setClauses.push(`${column} = $${paramIndex}${cast}`);
			values.push(body[key]);
			paramIndex++;
		}
	}

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

		const { rows: typeRows } = await client.query(
			`SELECT listing_type
       FROM listings
       WHERE listing_id = $1
         AND posted_by  = $2
         AND deleted_at IS NULL
       FOR UPDATE`,
			[listingId, posterId],
		);

		if (!typeRows.length) {
			throw new AppError("Listing not found", 404);
		}

		const listingType = typeRows[0].listing_type;
		const isPropertyLinked = listingType === "pg_room" || listingType === "hostel_bed";

		if (isPropertyLinked) {
			const forbiddenFields = Object.keys(body).filter((key) => PROPERTY_OWNED_LOCATION_FIELDS.has(key));
			if (forbiddenFields.length > 0) {
				throw new AppError(
					`Location fields (${forbiddenFields.join(", ")}) cannot be updated on a ${listingType} listing — ` +
						`they are inherited from the parent property. Update the property's address instead.`,
					422,
				);
			}
		}

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

export const deleteListing = async (posterId, listingId) => {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		const { rowCount } = await client.query(
			`UPDATE listings
       SET deleted_at = NOW()
       WHERE listing_id = $1
         AND posted_by  = $2
         AND deleted_at IS NULL`,
			[listingId, posterId],
		);

		if (rowCount === 0) {
			throw new AppError("Listing not found", 404);
		}

		await expirePendingRequestsForListing(listingId, client);

		await client.query("COMMIT");
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}

	logger.info({ posterId, listingId }, "Listing soft-deleted");
	return { listingId, deleted: true };
};

const ALLOWED_STATUS_TRANSITIONS = {
	active: ["filled", "deactivated"],
	deactivated: ["active"],
	filled: ["active"],
};

export const updateListingStatus = async (posterId, listingId, newStatus) => {
	const { rows: listingRows } = await pool.query(
		`SELECT status, expires_at, (expires_at <= NOW()) AS is_expired
     FROM listings
     WHERE listing_id = $1
       AND posted_by  = $2
       AND deleted_at IS NULL`,
		[listingId, posterId],
	);

	if (!listingRows.length) {
		throw new AppError("Listing not found", 404);
	}

	const currentStatus = listingRows[0].status;

	if (newStatus === "active" && listingRows[0].is_expired) {
		throw new AppError(EXPIRED_LISTING_MESSAGE, 422);
	}

	const allowed = ALLOWED_STATUS_TRANSITIONS[currentStatus] ?? [];

	if (!allowed.includes(newStatus)) {
		throw new AppError(`Cannot change listing status from '${currentStatus}' to '${newStatus}'`, 422);
	}

	const deactivating = newStatus === "filled" || newStatus === "deactivated";
	const reactivatingFromFilled = currentStatus === "filled" && newStatus === "active";

	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		const occupancyReset = reactivatingFromFilled ? `, current_occupants = 0` : "";

		const { rows: updatedRows } = await client.query(
			`UPDATE listings l
       SET status     = $1::listing_status_enum,
           filled_at  = CASE WHEN $1::listing_status_enum = 'filled'::listing_status_enum THEN NOW() ELSE l.filled_at END
           ${occupancyReset}
       WHERE l.listing_id = $2
         AND l.posted_by  = $3
         AND l.status     = $4::listing_status_enum
         AND l.deleted_at IS NULL
         AND ($1::listing_status_enum <> 'active'::listing_status_enum OR l.expires_at > NOW())
         AND (
           $1::listing_status_enum <> 'active'::listing_status_enum
           OR l.property_id IS NULL
           OR EXISTS (
             SELECT 1
             FROM properties p
             WHERE p.property_id = l.property_id
               AND p.deleted_at IS NULL
           )
         )
       RETURNING l.listing_id, l.status`,
			[newStatus, listingId, posterId, currentStatus],
		);

		if (!updatedRows.length) {
			const { rows: currentRows } = await client.query(
				`SELECT status, expires_at
         FROM listings
         WHERE listing_id = $1
           AND posted_by  = $2
           AND deleted_at IS NULL`,
				[listingId, posterId],
			);

			if (!currentRows.length) {
				throw new AppError("Listing not found", 404);
			}

			const currentRow = currentRows[0];
			const isNowExpired =
				currentRow.expires_at ? new Date(currentRow.expires_at).getTime() <= Date.now() : false;

			if (newStatus === "active" && isNowExpired) {
				throw new AppError(EXPIRED_LISTING_MESSAGE, 422);
			}

			if (currentRow.status !== currentStatus) {
				throw new AppError("Listing status has already changed — please refresh", 409);
			}

			throw new AppError("Listing status update could not be applied — please refresh", 409);
		}

		if (deactivating) {
			await expirePendingRequestsForListing(listingId, client);
		}

		await client.query("COMMIT");
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}

	logger.info(
		{
			posterId,
			listingId,
			from: currentStatus,
			to: newStatus,
			...(reactivatingFromFilled && { occupancyReset: true }),
		},
		"Listing status updated",
	);
	return { listingId, status: newStatus };
};

export const getListingPreferences = async (listingId) => {
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

export const saveListing = async (userId, listingId) => {
	const { rows: listingCheck } = await pool.query(
		`SELECT 1 FROM listings
     WHERE listing_id = $1
       AND status     = 'active'
       AND expires_at > NOW()
       AND deleted_at IS NULL`,
		[listingId],
	);
	if (!listingCheck.length) {
		const { rows: availabilityRows } = await pool.query(
			`SELECT status, expires_at, (expires_at <= NOW()) AS is_expired
       FROM listings
       WHERE listing_id = $1
         AND deleted_at IS NULL`,
			[listingId],
		);

		if (!availabilityRows.length) {
			throw new AppError("Listing not found", 404);
		}

		const listing = availabilityRows[0];
		if (listing.is_expired) {
			throw new AppError(EXPIRED_LISTING_MESSAGE, 422);
		}

		throw new AppError(UNAVAILABLE_LISTING_MESSAGE, 422);
	}

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

	logger.info({ userId, listingId }, "Listing unsaved");
	return { listingId, saved: false };
};

export const getSavedListings = async (userId, { cursorTime, cursorId, limit = 20 }) => {
	const hasCursor = cursorTime !== undefined && cursorId !== undefined;
	const params = [userId, limit + 1];
	let cursorClause = "";

	if (hasCursor) {
		params.push(cursorTime, cursorId);
		cursorClause = `AND (sl.saved_at < $3 OR (sl.saved_at = $3 AND sl.listing_id > $4::uuid))`;
	}

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
          AND ph.photo_url NOT LIKE 'processing:%'
        LIMIT 1
      ) AS cover_photo_url
    FROM saved_listings sl
    JOIN listings l  ON l.listing_id  = sl.listing_id
    JOIN users u     ON u.user_id     = l.posted_by
    LEFT JOIN properties p ON p.property_id = l.property_id AND p.deleted_at IS NULL
    WHERE sl.user_id    = $1
      AND sl.deleted_at IS NULL
      AND l.status      = 'active'
      AND l.expires_at  > NOW()
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
