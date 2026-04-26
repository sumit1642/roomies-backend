// src/cron/savedSearchAlert.js

import cron from "node-cron";
import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { enqueueNotification } from "../workers/notificationQueue.js";

const SCHEDULE = process.env.CRON_SAVED_SEARCH_ALERT ?? "0 8 * * *";

const buildWhereClause = (filters, params) => {
	const clauses = [`l.status = 'active'`, `l.deleted_at IS NULL`, `l.expires_at > NOW()`];
	let p = params.length + 1;

	if (filters.city) {
		const escaped = filters.city.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
		clauses.push(`LOWER(l.city) LIKE LOWER($${p}) ESCAPE '\\'`);
		params.push(`${escaped}%`);
		p++;
	}
	if (filters.minRent !== undefined) {
		clauses.push(`l.rent_per_month >= $${p}`);
		params.push(filters.minRent * 100);
		p++;
	}
	if (filters.maxRent !== undefined) {
		clauses.push(`l.rent_per_month <= $${p}`);
		params.push(filters.maxRent * 100);
		p++;
	}
	if (filters.roomType) {
		clauses.push(`l.room_type = $${p}::room_type_enum`);
		params.push(filters.roomType);
		p++;
	}
	if (filters.bedType) {
		clauses.push(`l.bed_type = $${p}::bed_type_enum`);
		params.push(filters.bedType);
		p++;
	}
	if (filters.preferredGender) {
		clauses.push(`(l.preferred_gender = $${p}::gender_enum OR l.preferred_gender IS NULL)`);
		params.push(filters.preferredGender);
		p++;
	}
	if (filters.listingType) {
		clauses.push(`l.listing_type = $${p}::listing_type_enum`);
		params.push(filters.listingType);
		p++;
	}
	if (filters.availableFrom) {
		clauses.push(`l.available_from <= $${p}`);
		params.push(filters.availableFrom);
		p++;
	}
	if (filters.amenityIds?.length) {
		const ids = [...new Set(filters.amenityIds)];
		clauses.push(
			`EXISTS (
        SELECT 1 FROM listing_amenities la
        WHERE la.listing_id = l.listing_id
          AND la.amenity_id = ANY($${p}::uuid[])
        GROUP BY la.listing_id
        HAVING COUNT(DISTINCT la.amenity_id) = $${p + 1}
      )`,
		);
		params.push(ids, ids.length);
		p += 2;
	}

	return clauses;
};

const runSavedSearchAlert = async () => {
	const startedAt = Date.now();
	logger.info("cron:savedSearchAlert — starting run");

	const { rows: searches } = await pool.query(
		`SELECT search_id, user_id, filters, last_alerted_at
     FROM saved_searches
     WHERE deleted_at IS NULL`,
	);

	if (!searches.length) {
		logger.debug({ durationMs: Date.now() - startedAt }, "cron:savedSearchAlert — no saved searches");
		return;
	}

	let alerted = 0;

	for (const search of searches) {
		try {
			const filters = search.filters ?? {};
			const params = [search.last_alerted_at ?? new Date(0)];
			const clauses = buildWhereClause(filters, params);
			clauses.push(`l.created_at > $1`);

			const { rows: newListings } = await pool.query(
				`SELECT l.listing_id FROM listings l
         LEFT JOIN properties p ON p.property_id = l.property_id AND p.deleted_at IS NULL
         WHERE ${clauses.join(" AND ")}
         LIMIT 1`,
				params,
			);

			if (!newListings.length) continue;

			await pool.query(`UPDATE saved_searches SET last_alerted_at = NOW() WHERE search_id = $1`, [
				search.search_id,
			]);

			enqueueNotification({
				recipientId: search.user_id,
				type: "saved_search_alert",
				entityType: "saved_search",
				entityId: search.search_id,
			});

			alerted++;
		} catch (err) {
			logger.error({ err, searchId: search.search_id }, "cron:savedSearchAlert — failed to process search");
		}
	}

	logger.info(
		{ alerted, total: searches.length, durationMs: Date.now() - startedAt },
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
