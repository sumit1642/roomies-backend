// src/db/utils/pgOwner.js
//
 
import { pool } from "../client.js";
import { AppError } from "../../middleware/errorHandler.js";
 
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
