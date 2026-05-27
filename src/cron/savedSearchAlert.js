// src/cron/savedSearchAlert.js

import cron from "node-cron";
import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { enqueueNotificationsBulk } from "../workers/notificationQueue.js";

const SCHEDULE = process.env.CRON_SAVED_SEARCH_ALERT ?? "0 8 * * *";

const toPositiveInt = (value, fallback) => {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? n : fallback;
};

const SEARCH_BATCH_SIZE = toPositiveInt(process.env.SAVED_SEARCH_ALERT_BATCH_SIZE, 500);
const NOTIFICATION_CHUNK_SIZE = toPositiveInt(process.env.SAVED_SEARCH_ALERT_NOTIFICATION_CHUNK_SIZE, 100);

const chunk = (items, size) => {
	const chunks = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
};

const fetchMatchedSearches = async (cursorId) => {
	const queryStartedAt = Date.now();
	const { rows } = await pool.query(
		`WITH search_batch AS (
       SELECT search_id, user_id, filters, last_alerted_at
       FROM saved_searches
       WHERE deleted_at IS NULL
         AND ($1::uuid IS NULL OR search_id > $1::uuid)
       ORDER BY search_id ASC
       LIMIT $2
     ),
     candidate_listings AS (
       SELECT l.*
       FROM listings l
       WHERE l.status = 'active'
         AND l.deleted_at IS NULL
         AND l.expires_at > NOW()
         AND EXISTS (SELECT 1 FROM search_batch)
         AND l.created_at > (
           SELECT COALESCE(MIN(last_alerted_at), 'epoch'::timestamptz)
           FROM search_batch
         )
     ),
     matched_searches AS (
       SELECT DISTINCT s.search_id, s.user_id
       FROM search_batch s
       JOIN candidate_listings l
         ON l.created_at > COALESCE(s.last_alerted_at, 'epoch'::timestamptz)
       WHERE
         (
           NOT (s.filters ? 'city')
           OR LOWER(l.city) LIKE LOWER(
             REPLACE(REPLACE(REPLACE(s.filters->>'city', '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'
           ) ESCAPE '\\'
         )
         AND (NOT (s.filters ? 'minRent') OR l.rent_per_month >= ((s.filters->>'minRent')::numeric * 100)::int)
         AND (NOT (s.filters ? 'maxRent') OR l.rent_per_month <= ((s.filters->>'maxRent')::numeric * 100)::int)
         AND (NOT (s.filters ? 'roomType') OR l.room_type::text = s.filters->>'roomType')
         AND (NOT (s.filters ? 'bedType') OR l.bed_type::text = s.filters->>'bedType')
         AND (
           NOT (s.filters ? 'preferredGender')
           OR l.preferred_gender::text = s.filters->>'preferredGender'
           OR l.preferred_gender IS NULL
         )
         AND (NOT (s.filters ? 'listingType') OR l.listing_type::text = s.filters->>'listingType')
         AND (NOT (s.filters ? 'availableFrom') OR l.available_from <= (s.filters->>'availableFrom')::date)
         AND (
           NOT (s.filters ? 'amenityIds')
           OR jsonb_array_length(s.filters->'amenityIds') = 0
           OR EXISTS (
             SELECT 1
             FROM listing_amenities la
             WHERE la.listing_id = l.listing_id
               AND la.amenity_id = ANY(
                 ARRAY(
                   SELECT jsonb_array_elements_text(s.filters->'amenityIds')::uuid
                 )
               )
             GROUP BY la.listing_id
             HAVING COUNT(DISTINCT la.amenity_id) = jsonb_array_length(s.filters->'amenityIds')
           )
         )
     ),
     batch_meta AS (
       SELECT
         (SELECT search_id FROM search_batch ORDER BY search_id DESC LIMIT 1) AS batch_cursor_id,
         (SELECT COUNT(*)::int FROM search_batch) AS batch_count
     )
     SELECT
       bm.batch_cursor_id,
       bm.batch_count,
       ms.search_id,
       ms.user_id
     FROM batch_meta bm
     LEFT JOIN matched_searches ms ON TRUE
     ORDER BY ms.search_id ASC`,
		[cursorId, SEARCH_BATCH_SIZE],
	);

	return { rows, queryDurationMs: Date.now() - queryStartedAt };
};

const markSearchesAlerted = async (searchIds) => {
	if (!searchIds.length) return 0;

	const { rowCount } = await pool.query(
		`UPDATE saved_searches
     SET last_alerted_at = NOW()
     WHERE search_id = ANY($1::uuid[])
       AND deleted_at IS NULL`,
		[searchIds],
	);

	return rowCount;
};

export const runSavedSearchAlert = async () => {
	const startedAt = Date.now();
	logger.info("cron:savedSearchAlert — starting run");

	let cursorId = null;
	let scanned = 0;
	let matched = 0;
	let enqueued = 0;
	let updated = 0;
	let queryDurationMs = 0;

	while (true) {
		const { rows, queryDurationMs: batchQueryDurationMs } = await fetchMatchedSearches(cursorId);
		queryDurationMs += batchQueryDurationMs;

		const batchCursorId = rows[0]?.batch_cursor_id ?? null;
		const batchCount = Number(rows[0]?.batch_count ?? 0);
		scanned += batchCount;

		const notifications = rows
			.filter((row) => row.search_id)
			.map((row) => ({
				recipientId: row.user_id,
				type: "saved_search_alert",
				entityType: "saved_search",
				entityId: row.search_id,
			}));

		matched += notifications.length;

		for (const notificationChunk of chunk(notifications, NOTIFICATION_CHUNK_SIZE)) {
			enqueued += await enqueueNotificationsBulk(notificationChunk);
		}

		const batchUpdated = await markSearchesAlerted(notifications.map((notification) => notification.entityId));
		updated += batchUpdated;

		logger.debug(
			{
				batchCount,
				batchMatched: notifications.length,
				batchUpdated,
				batchQueryDurationMs,
				cursorId: batchCursorId,
			},
			"cron:savedSearchAlert — batch processed",
		);

		if (batchCount < SEARCH_BATCH_SIZE || batchCursorId === null) break;
		cursorId = batchCursorId;
	}

	logger.info(
		{
			scanned,
			matched,
			enqueued,
			updated,
			queryDurationMs,
			durationMs: Date.now() - startedAt,
		},
		"cron:savedSearchAlert — run complete",
	);
};

export const registerSavedSearchAlertCron = () => {
	const task = cron.schedule(SCHEDULE, () => {
		runSavedSearchAlert().catch((err) => {
			logger.error({ err }, "cron:savedSearchAlert — unhandled error");
		});
	});

	logger.info({ schedule: SCHEDULE }, "cron:savedSearchAlert — registered");
	return task;
};
