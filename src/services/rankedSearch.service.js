// src/services/rankedSearch.service.js
//
// ─── RANKED LISTING SEARCH ────────────────────────────────────────────────────
//
// Problem with the existing searchListings: compatibility scoring happens in JS
// *after* the SQL query returns. This means you can only sort the current page,
// not across all matching listings — pagination is semantically broken for
// ranked results (page 2 starts from the wrong place).
//
// This service fixes that by computing every score component as a SQL expression
// inside a CTE, so the final ORDER BY rank_score DESC runs at the database level
// and the keyset cursor carries the rank_score itself.
//
// ─── THREE-LAYER PREFERENCE STACK ────────────────────────────────────────────
//
// Layer A — preferenceOverrides (request-time, highest priority)
//   Temporary checkbox selections from the current search call.
//   Never written to the DB (persistPreferences=false by default).
//
// Layer B — stored user_preferences (middle priority)
//   The user's saved profile preferences from prior sessions.
//
// Layer C — no preferences (cold-start fallback)
//   Both A and B are empty. Compatibility weight drops to 0 and distance/
//   rating/freshness carry the full weight.
//
// effectivePrefs = { ...storedPrefs, ...requestOverrides }
//   Override keys win; stored fills the gaps.
//
// ─── SCORING FORMULA ─────────────────────────────────────────────────────────
//
// rank_score = w1*compat + w2*rating + w3*freshness + w4*distance
//
// All components normalised to [0, 1]:
//   compat      = matched_pairs / total_effective_pref_keys   (0 when no prefs)
//   rating      = COALESCE(avg_rating, 0) / 5.0
//   freshness   = exp(-age_days / 14)                         (half-life ~10d)
//   distanceScore = 1 - LEAST(dist_m / radius_m, 1)          (1.0 = at origin)
//
// Weight sets (sum to 1.0):
//   with prefs + geo:    w1=0.45  w2=0.20  w3=0.15  w4=0.20
//   with prefs no geo:   w1=0.55  w2=0.25  w3=0.20  w4=0.00
//   cold-start + geo:    w1=0.00  w2=0.35  w3=0.25  w4=0.40
//   cold-start no geo:   w1=0.00  w2=0.55  w3=0.45  w4=0.00
//
// ─── PAGINATION ──────────────────────────────────────────────────────────────
//
// Cursor: { cursorRankScore, cursorId }
// ORDER BY rank_score DESC, listing_id ASC
//
// The tiebreaker (listing_id ASC) is stable because UUIDs never change.
// rank_score can tie across listings (especially when compat=0 for many), so
// the secondary sort is essential for gap-free pagination.

import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";

// ─── Weight sets ──────────────────────────────────────────────────────────────

const WEIGHTS = {
	withPrefsGeo: { compat: 0.45, rating: 0.2, freshness: 0.15, distance: 0.2 },
	withPrefsNoGeo: { compat: 0.55, rating: 0.25, freshness: 0.2, distance: 0.0 },
	coldStartGeo: { compat: 0.0, rating: 0.35, freshness: 0.25, distance: 0.4 },
	coldStartNoGeo: { compat: 0.0, rating: 0.55, freshness: 0.45, distance: 0.0 },
};

const selectWeights = (hasPrefs, hasGeo) => {
	if (hasPrefs && hasGeo) return WEIGHTS.withPrefsGeo;
	if (hasPrefs && !hasGeo) return WEIGHTS.withPrefsNoGeo;
	if (!hasPrefs && hasGeo) return WEIGHTS.coldStartGeo;
	return WEIGHTS.coldStartNoGeo;
};

// ─── Resolve effective preferences ───────────────────────────────────────────
//
// Fetches the user's stored preferences, then merges in any request-time
// overrides (override wins on the same key). Returns an array of
// { preference_key, preference_value } objects ready for a VALUES clause.

const resolveEffectivePrefs = async (userId, overrides = []) => {
	const { rows: storedRows } = await pool.query(
		`SELECT preference_key, preference_value
     FROM user_preferences
     WHERE user_id = $1`,
		[userId],
	);

	// Build a map; request-time overrides replace stored values for the same key.
	const prefMap = new Map(storedRows.map((r) => [r.preference_key, r.preference_value]));
	for (const { preferenceKey, preferenceValue } of overrides) {
		prefMap.set(preferenceKey, preferenceValue);
	}

	return Array.from(prefMap.entries()).map(([k, v]) => ({
		preference_key: k,
		preference_value: v,
	}));
};

// ─── Build the compatibility CTE fragment ────────────────────────────────────
//
// When effectivePrefs is non-empty, we inject a VALUES-based temp table and
// join it against listing_preferences. When empty (cold-start), we return a
// constant-zero expression so the query stays a single statement.
//
// Returns { cteSql, compatExpr, extraParams, nextParamIndex }
//   cteSql       — optional CTE clause to prepend
//   compatExpr   — SQL expression that produces a float in [0,1] for each listing
//   extraParams  — array of parameter values for the VALUES rows
//   nextParamIndex — the next $N to use after these params

const buildCompatFragment = (effectivePrefs, baseParamIndex) => {
	if (effectivePrefs.length === 0) {
		return {
			cteSql: "",
			compatExpr: "0.0",
			extraParams: [],
			nextParamIndex: baseParamIndex,
		};
	}

	const totalKeys = effectivePrefs.length;

	// Build VALUES rows: ($k1, $v1), ($k2, $v2), ...
	const valueRows = effectivePrefs.map((_, i) => {
		const ki = baseParamIndex + i * 2;
		const vi = ki + 1;
		return `($${ki}::text, $${vi}::text)`;
	});
	const extraParams = effectivePrefs.flatMap((p) => [p.preference_key, p.preference_value]);

	const nextParamIndex = baseParamIndex + extraParams.length;

	// The CTE makes the effective pref set addressable by name in the main query.
	const cteSql = `
  effective_prefs(pref_key, pref_val) AS (
    VALUES ${valueRows.join(", ")}
  ),`;

	// For each listing, count how many (key, value) pairs match the effective set,
	// then divide by total_keys to normalise to [0,1].
	const compatExpr = `
    COALESCE(
      (
        SELECT COUNT(*)::float / ${totalKeys}
        FROM listing_preferences lp_inner
        JOIN effective_prefs ep
          ON ep.pref_key = lp_inner.preference_key
         AND ep.pref_val = lp_inner.preference_value
        WHERE lp_inner.listing_id = l.listing_id
      ),
      0.0
    )`;

	return { cteSql, compatExpr, extraParams, nextParamIndex };
};

// ─── Main ranked search function ─────────────────────────────────────────────

export const rankedSearch = async (userId, filters) => {
	const {
		// Standard filters (same as searchListings)
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
		radius = 5000,
		amenityIds = [],
		// Ranking controls
		preferenceOverrides = [],
		// Pagination
		cursorRankScore,
		cursorId,
		limit = 20,
	} = filters;

	const safeLimit = Math.min(Math.max(1, limit), 100);
	const hasGeo = lat !== undefined && lng !== undefined;

	// ── 1. Resolve effective preferences ───────────────────────────────────────
	const effectivePrefs = await resolveEffectivePrefs(userId, preferenceOverrides);
	const isColdStart = effectivePrefs.length === 0;
	const hasPrefs = !isColdStart;

	// ── 2. Select weight set ───────────────────────────────────────────────────
	const weights = selectWeights(hasPrefs, hasGeo);

	// ── 3. Build SQL ───────────────────────────────────────────────────────────
	//
	// Parameters are numbered starting at 1. We allocate them in this order:
	//   a) geo params (if hasGeo): lat=$1, lng=$2, radius=$3
	//   b) effective_prefs VALUES params (key1, val1, key2, val2, ...)
	//   c) filter params (city, rent, room type, etc.)
	//   d) cursor params (if present)
	//   e) limit param

	const params = [];
	let p = 1;

	// ── 3a. Geo params ──────────────────────────────────────────────────────────
	let geoWhereClause = "";
	let distanceExpr = "0.5"; // neutral mid-value when no geo
	if (hasGeo) {
		// $p=lat, $p+1=lng, $p+2=radius
		params.push(lat, lng, radius);
		geoWhereClause = `
      AND ST_DWithin(
        COALESCE(l.location, prop.location)::geography,
        ST_SetSRID(ST_MakePoint($${p + 1}, $${p}), 4326)::geography,
        $${p + 2}
      )`;
		distanceExpr = `
      1.0 - LEAST(
        ST_Distance(
          COALESCE(l.location, prop.location)::geography,
          ST_SetSRID(ST_MakePoint($${p + 1}, $${p}), 4326)::geography
        ) / NULLIF($${p + 2}::float, 0),
        1.0
      )`;
		p += 3;
	}

	// ── 3b. Compatibility CTE ───────────────────────────────────────────────────
	const { cteSql, compatExpr, extraParams, nextParamIndex } = buildCompatFragment(effectivePrefs, p);
	params.push(...extraParams);
	p = nextParamIndex;

	// ── 3c. Filter WHERE clauses ────────────────────────────────────────────────
	const filterClauses = [`l.status    = 'active'`, `l.deleted_at IS NULL`, `l.expires_at > NOW()`];

	if (city !== undefined) {
		const escaped = city.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
		filterClauses.push(`LOWER(l.city) LIKE LOWER($${p}) ESCAPE '\\'`);
		params.push(`${escaped}%`);
		p++;
	}
	if (minRent !== undefined) {
		filterClauses.push(`l.rent_per_month >= $${p}`);
		params.push(minRent * 100);
		p++;
	}
	if (maxRent !== undefined) {
		filterClauses.push(`l.rent_per_month <= $${p}`);
		params.push(maxRent * 100);
		p++;
	}
	if (roomType !== undefined) {
		filterClauses.push(`l.room_type = $${p}`);
		params.push(roomType);
		p++;
	}
	if (bedType !== undefined) {
		filterClauses.push(`l.bed_type = $${p}`);
		params.push(bedType);
		p++;
	}
	if (preferredGender !== undefined) {
		filterClauses.push(`(l.preferred_gender = $${p} OR l.preferred_gender IS NULL)`);
		params.push(preferredGender);
		p++;
	}
	if (listingType !== undefined) {
		filterClauses.push(`l.listing_type = $${p}`);
		params.push(listingType);
		p++;
	}
	if (availableFrom !== undefined) {
		filterClauses.push(`l.available_from <= $${p}`);
		params.push(availableFrom);
		p++;
	}
	if (amenityIds.length > 0) {
		const uniqueIds = [...new Set(amenityIds)];
		filterClauses.push(`
      EXISTS (
        SELECT 1 FROM listing_amenities la_f
        WHERE la_f.listing_id = l.listing_id
          AND la_f.amenity_id = ANY($${p}::uuid[])
        GROUP BY la_f.listing_id
        HAVING COUNT(DISTINCT la_f.amenity_id) = $${p + 1}
      )`);
		params.push(uniqueIds, uniqueIds.length);
		p += 2;
	}

	// Geo filter appended here (already built above but uses the same WHERE block)
	if (hasGeo) {
		filterClauses.push(geoWhereClause.trim());
	}

	// ── 3d. Cursor clause ───────────────────────────────────────────────────────
	//
	// ORDER BY rank_score DESC, listing_id ASC
	// "Next page" means: rank_score is strictly lower than cursor, OR equal rank
	// but listing_id is strictly greater than cursor (ASC tiebreak).
	let cursorClause = "";
	if (cursorRankScore !== undefined && cursorId !== undefined) {
		cursorClause = `
      AND (
        scored.rank_score < $${p}
        OR (scored.rank_score = $${p} AND scored.listing_id > $${p + 1}::uuid)
      )`;
		params.push(cursorRankScore, cursorId);
		p += 2;
	}

	// ── 3e. Limit param ─────────────────────────────────────────────────────────
	params.push(safeLimit + 1);
	const limitParam = p;

	// ── 4. Assemble and execute the query ──────────────────────────────────────
	//
	// Structure:
	//   WITH [effective_prefs CTE if needed,]
	//        scored AS (
	//          SELECT l.*, computed_scores, rank_score
	//          FROM listings l ...
	//          WHERE <hard filters>
	//        )
	//   SELECT * FROM scored
	//   WHERE <cursor clause>
	//   ORDER BY rank_score DESC, listing_id ASC
	//   LIMIT ...

	const sql = `
    WITH
    ${cteSql}
    scored AS (
      SELECT
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
        COALESCE(prop.property_name, NULL)        AS property_name,
        COALESCE(prop.average_rating, u.average_rating) AS average_rating,
        (
          SELECT ph.photo_url
          FROM listing_photos ph
          WHERE ph.listing_id = l.listing_id
            AND ph.is_cover   = TRUE
            AND ph.deleted_at IS NULL
          LIMIT 1
        ) AS cover_photo_url,

        -- Score components (all normalised to [0,1])
        (${compatExpr})                           AS compat_score,
        COALESCE(u.average_rating, 0.0) / 5.0    AS rating_score,
        EXP(
          -EXTRACT(EPOCH FROM (NOW() - l.created_at)) / 86400.0 / 14.0
        )                                          AS freshness_score,
        (${distanceExpr})                          AS distance_score,

        -- Weighted rank (computed from the component scores above)
        (
          (${compatExpr}) * ${weights.compat}
          + COALESCE(u.average_rating, 0.0) / 5.0 * ${weights.rating}
          + EXP(
              -EXTRACT(EPOCH FROM (NOW() - l.created_at)) / 86400.0 / 14.0
            ) * ${weights.freshness}
          + (${distanceExpr}) * ${weights.distance}
        )                                          AS rank_score

      FROM listings l
      JOIN users u
        ON u.user_id = l.posted_by
       AND u.deleted_at IS NULL
      LEFT JOIN properties prop
        ON prop.property_id = l.property_id
       AND prop.deleted_at IS NULL
      WHERE ${filterClauses.join(" AND ")}
    )
    SELECT *
    FROM scored
    WHERE 1=1
    ${cursorClause}
    ORDER BY rank_score DESC, listing_id ASC
    LIMIT $${limitParam}
  `;

	const { rows } = await pool.query(sql, params);

	// ── 5. Shape the response ───────────────────────────────────────────────────
	const hasNextPage = rows.length > safeLimit;
	const items = hasNextPage ? rows.slice(0, safeLimit) : rows;

	const nextCursor =
		hasNextPage ?
			{
				cursorRankScore: items[items.length - 1].rank_score,
				cursorId: items[items.length - 1].listing_id,
			}
		:	null;

	logger.info(
		{
			userId,
			isColdStart,
			hasGeo,
			effectivePrefCount: effectivePrefs.length,
			overrideCount: preferenceOverrides.length,
			weights,
			resultCount: items.length,
		},
		"rankedSearch executed",
	);

	return {
		items: items.map((row) => ({
			listingId: row.listing_id,
			postedBy: row.posted_by,
			listingType: row.listing_type,
			title: row.title,
			city: row.city,
			locality: row.locality,
			rentPerMonth: row.rent_per_month / 100,
			depositAmount: row.deposit_amount / 100,
			roomType: row.room_type,
			preferredGender: row.preferred_gender,
			availableFrom: row.available_from,
			status: row.status,
			createdAt: row.created_at,
			propertyName: row.property_name,
			averageRating: row.average_rating,
			coverPhotoUrl: row.cover_photo_url,
			// Ranking output
			rankScore: parseFloat(row.rank_score),
			scoreBreakdown: {
				compat: parseFloat(row.compat_score),
				rating: parseFloat(row.rating_score),
				freshness: parseFloat(row.freshness_score),
				distance: parseFloat(row.distance_score),
			},
		})),
		nextCursor,
		searchMeta: {
			isColdStart,
			hasGeo,
			effectivePrefCount: effectivePrefs.length,
			weights,
		},
	};
};

// ─── Persist preference overrides ────────────────────────────────────────────
//
// Called when persistPreferences=true in the request body. Upserts the provided
// preferences into user_preferences, replacing any existing value for the same
// key (UNIQUE constraint on (user_id, preference_key)).
//
// This is intentionally separate from the search function so persistence is
// opt-in and auditable. A search call with persistPreferences=false (default)
// leaves the DB unchanged.

export const persistPreferenceOverrides = async (userId, overrides) => {
	if (!overrides.length) return;

	const placeholders = overrides.map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`).join(", ");
	const values = [userId, ...overrides.flatMap((o) => [o.preferenceKey, o.preferenceValue])];

	await pool.query(
		`INSERT INTO user_preferences (user_id, preference_key, preference_value)
     VALUES ${placeholders}
     ON CONFLICT (user_id, preference_key)
     DO UPDATE SET preference_value = EXCLUDED.preference_value, updated_at = NOW()`,
		values,
	);

	logger.info({ userId, count: overrides.length }, "User preferences upserted from search override");
};
