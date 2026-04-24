

 
import { pool } from "../client.js";
import { AppError } from "../../middleware/errorHandler.js";
 














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
