// src/cron/expiryWarning.js
//
// Scheduled maintenance job: send advance expiry warnings to posters whose
// active listings will expire within the next 7 days.
//
// ─── DESIGN NOTES ────────────────────────────────────────────────────────────
//
// Warning window: we notify posters when their listing will expire within 7
// days. This gives them enough lead time to renew.
//
// Idempotency: the NOT EXISTS subquery checks for a listing_expiring notification
// in the last 24 hours, preventing duplicate messages per listing per day.
//
// Concurrent-runner guard: even with the NOT EXISTS check, two concurrent cron
// runners can both read the candidate set before either commits a notification —
// the classic TOCTOU race. We prevent this with a TRANSACTION-SCOPED advisory
// lock (`pg_try_advisory_xact_lock`).
//
// WHY TRANSACTION-SCOPED AND NOT SESSION-SCOPED:
// pg_try_advisory_lock is session-scoped — it is tied to the PostgreSQL backend
// connection, NOT the transaction. node-postgres pools connections: when
// client.release() is called, the backend process keeps running and keeps
// holding any session-level advisory lock it acquired. On the very next cron
// tick, pg may check out the same pooled backend, pg_try_advisory_lock returns
// true again (same session already holds it), but OTHER backends still see the
// lock as held — giving false mutual exclusion across pool clients.
//
// pg_try_advisory_xact_lock is transaction-scoped: it is released automatically
// at COMMIT or ROLLBACK, regardless of how the transaction ends. There is no
// risk of the lock persisting across pool reuse, no need for explicit unlock,
// and cleanup is guaranteed even if the process crashes mid-transaction
// (PostgreSQL releases it when the backend reconnects or the session drops).
//
// The advisory lock key (7001) is an arbitrary stable integer chosen to avoid
// collision with any other advisory lock used in this codebase. Document it
// here: 7001 = expiryWarning cron.
//
// Observability: logs the number of warnings sent on each run.

import cron from "node-cron";
import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { enqueueNotification } from "../workers/notificationQueue.js";

const SCHEDULE = process.env.CRON_EXPIRY_WARNING ?? "0 1 * * *";
const WARNING_WINDOW_DAYS = 7;
const ADVISORY_LOCK_KEY = 7001; // stable key: 7001 = expiryWarning cron

const runExpiryWarning = async () => {
	const startedAt = Date.now();
	logger.info("cron:expiryWarning — starting run");

	const client = await pool.connect();
	try {
		// Begin the transaction BEFORE acquiring the lock.
		// pg_try_advisory_xact_lock REQUIRES an active transaction — it is bound
		// to the transaction lifecycle and released automatically on COMMIT or
		// ROLLBACK. This is the correct alternative to the session-scoped
		// pg_try_advisory_lock which persists across pool reuse.
		await client.query("BEGIN");

		const { rows: lockRows } = await client.query("SELECT pg_try_advisory_xact_lock($1) AS acquired", [
			ADVISORY_LOCK_KEY,
		]);

		if (!lockRows[0].acquired) {
			// Another runner holds the lock. ROLLBACK ends the transaction cleanly;
			// the (unacquired) lock is automatically released.
			await client.query("ROLLBACK");
			logger.info(
				{ durationMs: Date.now() - startedAt },
				"cron:expiryWarning — advisory lock not acquired (another runner is active); skipping this tick",
			);
			return;
		}

		// Find all active listings expiring within the warning window that have NOT
		// already received a listing_expiring notification in the last 24 hours.
		//
		// WARNING_WINDOW_DAYS is passed as a parameter via make_interval() rather
		// than interpolated into SQL text. This is the correct approach because:
		//   1. Safety: even though WARNING_WINDOW_DAYS is a hardcoded integer today,
		//      using a parameter is the right habit if it ever becomes env-derived.
		//   2. Plan stability: PostgreSQL receives the same query text on every run
		//      and can reuse a cached query plan.
		//   3. Correctness: make_interval(days => $1) is more explicit than
		//      ($1 || ' days')::interval and avoids any ambiguity with the cast.
		const { rows } = await client.query(
			`SELECT l.listing_id, l.posted_by, l.expires_at
       FROM listings l
       WHERE l.status     = 'active'
         AND l.deleted_at IS NULL
         AND l.expires_at  > NOW()
         AND l.expires_at  <= NOW() + make_interval(days => $1)
         AND NOT EXISTS (
           SELECT 1 FROM notifications n
           WHERE n.entity_id         = l.listing_id
             AND n.entity_type       = 'listing'
             AND n.notification_type = 'listing_expiring'
             AND n.created_at        > NOW() - INTERVAL '24 hours'
             AND n.deleted_at        IS NULL
         )`,
			[WARNING_WINDOW_DAYS],
		);

		// COMMIT releases the transaction-scoped advisory lock automatically.
		// Notification enqueueing happens AFTER commit so a Redis failure cannot
		// cause a rollback of what is already committed DB state.
		await client.query("COMMIT");

		if (rows.length > 0) {
			for (const row of rows) {
				enqueueNotification({
					recipientId: row.posted_by,
					type: "listing_expiring",
					entityType: "listing",
					entityId: row.listing_id,
				});
			}

			logger.info(
				{
					warningSent: rows.length,
					durationMs: Date.now() - startedAt,
				},
				"cron:expiryWarning — expiry warnings enqueued",
			);
		} else {
			logger.debug({ durationMs: Date.now() - startedAt }, "cron:expiryWarning — no listings approaching expiry");
		}
	} catch (err) {
		// ROLLBACK releases the transaction-scoped advisory lock if it was acquired.
		// If the lock was never acquired, ROLLBACK is still safe to call — it is
		// idempotent and will not error on an already-rolled-back transaction.
		try {
			await client.query("ROLLBACK");
		} catch (rollbackErr) {
			logger.error({ rollbackErr }, "cron:expiryWarning — rollback failed");
		}
		logger.error({ err, durationMs: Date.now() - startedAt }, "cron:expiryWarning — run failed");
	} finally {
		// No pg_advisory_unlock call needed — the transaction ending handles
		// the lock release automatically. Simply return the client to the pool.
		client.release();
	}
};

export const registerExpiryWarningCron = () => {
	const task = cron.schedule(SCHEDULE, () => {
		runExpiryWarning().catch((err) => {
			logger.error({ err }, "cron:expiryWarning — unhandled error in job runner");
		});
	});

	logger.info({ schedule: SCHEDULE }, "cron:expiryWarning — registered");
	return task;
};
