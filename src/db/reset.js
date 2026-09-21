import pg from "pg";
import dotenv from "dotenv";

const LOCAL_ENV_FILE = ".env.local";
const MIGRATION_LOCK_NAMESPACE = 1_947_234_821;
const MIGRATION_LOCK_KEY = 1;

if (process.env.ENV_FILE !== LOCAL_ENV_FILE) {
	console.error(`❌  db:down may only run with ENV_FILE=${LOCAL_ENV_FILE}.`);
	console.error("    This command destroys the local database schema; it never targets deployed environments.");
	process.exit(1);
}

dotenv.config({ path: LOCAL_ENV_FILE });

if (!process.env.DATABASE_URL) {
	console.error("❌  DATABASE_URL is not set. Cannot reset the local database.");
	process.exit(1);
}

if (process.env.NODE_ENV === "production") {
	console.error("❌  Refusing to reset a production database.");
	process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

const run = async () => {
	try {
		await client.connect();
		console.log("✅  Connected to local database");
		console.log("⏳  Waiting for the database migration lock...");
		await client.query("SELECT pg_advisory_lock($1, $2)", [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_KEY]);
		console.log("✅  Database migration lock acquired");

		// Dropping public removes application tables, functions, types, and the
		// PostGIS extensions installed by migration 001. Recreating it leaves the
		// database empty, so `npm run db:up` can build the schema from migrations
		// exactly as it does for a fresh test database.
		await client.query("BEGIN");
		await client.query("DROP SCHEMA public CASCADE");
		await client.query("CREATE SCHEMA public");
		await client.query("COMMIT");

		console.log("\n✅  Local database reset. Run `npm run db:up` to apply all migrations.\n");
	} catch (err) {
		try {
			await client.query("ROLLBACK");
		} catch (_) {}
		console.error("❌  Local database reset failed.");
		console.error(`Error: ${err.message}`);
		process.exitCode = 1;
	} finally {
		try {
			await client.query("SELECT pg_advisory_unlock($1, $2)", [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_KEY]);
		} catch (_) {}
		await client.end().catch(() => {});
	}
};

run().catch((err) => {
	console.error("Unexpected reset error:", err);
	process.exit(1);
});
