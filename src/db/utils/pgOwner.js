// src/db/utils/pgOwner.js
//
// Shared database utilities for PG owner data.
//
// Why this file exists:
// Both property.service.js and listing.service.js need to verify that a PG owner
// is verified before allowing any write operation. Originally this lived as a
// private function inside property.service.js. That worked fine until listing
// CRUD needed the same check — importing from property.service.js would create
// a coupling between two peer service files, and if either later imported the
// other for any reason, it would become a circular dependency.
//
// The project convention (established in Phase 1) is that stable, reused queries
// that are called from more than one place live in src/db/utils/, not in service
// files. This file follows that convention. Neither property.service.js nor
// listing.service.js imports the other — both import this utility independently.

import { pool } from "../client.js";
import { AppError } from "../../middleware/errorHandler.js";

// Asserts that the user identified by `userId` has a non-deleted PG owner profile
// with verification_status = 'verified'. Throws AppError on any failure:
//   404 — no pg_owner_profiles row exists for this user (should not happen if
//          authorize('pg_owner') middleware ran first, but guards against data
//          integrity issues like a manually deleted profile row)
//   403 — profile exists but status is unverified, pending, or rejected
//
// Returns void on success. The caller proceeds without needing to inspect a
// return value — if this function returns without throwing, the owner is verified.
//
// The `client` parameter defaults to the shared pool. Callers that need to run
// this check inside a transaction pass their checked-out client. In practice
// neither service currently calls this inside a transaction (the verification
// check precedes the transaction), but the parameter makes the function
// consistent with every other utility in this directory.
export const assertPgOwnerVerified = async (userId, client = pool) => {
	const { rows } = await client.query(
		`SELECT verification_status
     FROM pg_owner_profiles
     WHERE user_id    = $1
       AND deleted_at IS NULL`,
		[userId],
	);

	if (!rows.length) {
		throw new AppError("PG owner profile not found", 404);
	}

	if (rows[0].verification_status !== "verified") {
		throw new AppError("Your account must be verified before you can manage properties or listings", 403);
	}
};
