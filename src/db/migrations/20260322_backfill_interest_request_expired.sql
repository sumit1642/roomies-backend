-- One-time migration for system-driven interest-request expirations.
--
-- Why this exists:
--   `expirePendingRequestsForListing(...)` historically auto-transitioned
--   pending rows to `withdrawn`, which is a user-driven status. The helper now
--   uses `expired` so listing shutdown / accept-flow cleanup is represented as
--   a system-driven terminal state instead.
--
-- What this script does:
--   1. Ensures `request_status_enum` contains `expired`.
--   2. Shows a conservative candidate set of rows that were *likely* auto-
--      transitioned by the helper.
--   3. Backfills only those candidate rows from `withdrawn` -> `expired`.
--
-- Heuristic caveat:
--   Historical data cannot distinguish every auto-expiration from a genuine
--   user withdrawal with perfect certainty. This script intentionally limits
--   the update to rows that line up with a listing terminal transition
--   (deleted/filled/deactivated/expired) or with another request on the same
--   listing being accepted at nearly the same time.

ALTER TYPE request_status_enum ADD VALUE IF NOT EXISTS 'expired';

WITH candidate_rows AS (
	SELECT ir.request_id
	FROM interest_requests ir
	JOIN listings l
		ON l.listing_id = ir.listing_id
	WHERE ir.status = 'withdrawn'::request_status_enum
	  AND ir.deleted_at IS NULL
	  AND (
		(
			(l.deleted_at IS NOT NULL OR l.status IN ('filled', 'deactivated', 'expired'))
			AND ir.updated_at BETWEEN COALESCE(l.deleted_at, l.updated_at) - INTERVAL '5 seconds'
			                    AND COALESCE(l.deleted_at, l.updated_at) + INTERVAL '5 seconds'
		)
		OR EXISTS (
			SELECT 1
			FROM interest_requests accepted_ir
			WHERE accepted_ir.listing_id = ir.listing_id
			  AND accepted_ir.status = 'accepted'::request_status_enum
			  AND accepted_ir.deleted_at IS NULL
			  AND accepted_ir.request_id <> ir.request_id
			  AND ir.updated_at BETWEEN accepted_ir.updated_at - INTERVAL '5 seconds'
			                      AND accepted_ir.updated_at + INTERVAL '5 seconds'
		)
	  )
)
SELECT COUNT(*) AS candidate_count
FROM candidate_rows;

WITH candidate_rows AS (
	SELECT ir.request_id
	FROM interest_requests ir
	JOIN listings l
		ON l.listing_id = ir.listing_id
	WHERE ir.status = 'withdrawn'::request_status_enum
	  AND ir.deleted_at IS NULL
	  AND (
		(
			(l.deleted_at IS NOT NULL OR l.status IN ('filled', 'deactivated', 'expired'))
			AND ir.updated_at BETWEEN COALESCE(l.deleted_at, l.updated_at) - INTERVAL '5 seconds'
			                    AND COALESCE(l.deleted_at, l.updated_at) + INTERVAL '5 seconds'
		)
		OR EXISTS (
			SELECT 1
			FROM interest_requests accepted_ir
			WHERE accepted_ir.listing_id = ir.listing_id
			  AND accepted_ir.status = 'accepted'::request_status_enum
			  AND accepted_ir.deleted_at IS NULL
			  AND accepted_ir.request_id <> ir.request_id
			  AND ir.updated_at BETWEEN accepted_ir.updated_at - INTERVAL '5 seconds'
			                      AND accepted_ir.updated_at + INTERVAL '5 seconds'
		)
	  )
)
UPDATE interest_requests ir
SET status = 'expired'::request_status_enum,
	updated_at = NOW()
FROM candidate_rows c
WHERE ir.request_id = c.request_id;
