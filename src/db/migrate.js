import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import pg from "pg";
import dotenv from "dotenv";

const envFile = process.env.ENV_FILE;
if (envFile) {
	dotenv.config({ path: envFile });
} else {
	dotenv.config({ path: ".env.local" });
	dotenv.config({ path: ".env" });
}

if (!process.env.DATABASE_URL) {
	console.error("❌  DATABASE_URL is not set. Cannot run migrations.");
	console.error("    Set ENV_FILE=.env.local (or .env.azure) before running.");
	process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

const args = process.argv.slice(2);
const argSet = new Set(args);
const DRY_RUN = argSet.has("--dry-run");
const STATUS_ONLY = argSet.has("--status");

// --rollback <filename> — roll back exactly one migration, and only if it is
// the most recently applied one. Rollback is intentionally NOT a general
// "roll back N migrations" tool: out-of-order rollback against a shared
// schema_migrations history is how you corrupt that history. If you need to
// roll back further, call --rollback repeatedly, most-recent-first, checking
// --status between calls.
const rollbackFlagIndex = args.indexOf("--rollback");
const ROLLBACK_TARGET = rollbackFlagIndex !== -1 ? args[rollbackFlagIndex + 1] : null;

if (rollbackFlagIndex !== -1 && !ROLLBACK_TARGET) {
	console.error("❌  --rollback requires a filename argument, e.g.:");
	console.error('    node src/db/migrate.js --rollback "003: profile_photo_url_pg_owner_profiles.sql"');
	process.exit(1);
}

// Suffix convention for migrations that must NOT run inside a transaction
// block — CREATE INDEX CONCURRENTLY, DROP INDEX CONCURRENTLY, and similar
// statements are rejected outright by Postgres if wrapped in BEGIN/COMMIT
// ("ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction block").
// These files run in autocommit mode instead. Keep them small and focused —
// ideally a single CONCURRENTLY statement per file — since a failure here
// needs manual inspection (see the catch block below) rather than a clean
// automatic rollback.
const CONCURRENT_SUFFIX = ".concurrent.sql";
// Matching down-migration suffix for rollback support (see --rollback below).
const DOWN_SUFFIX = ".down.sql";

const sha256 = (content) => crypto.createHash("sha256").update(content, "utf8").digest("hex");

const pad = (str, width) => str.toString().padEnd(width);

const ENSURE_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    VARCHAR(255) PRIMARY KEY,
    checksum    VARCHAR(64)  NOT NULL,
    applied_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
`;

// Derives the down-migration filename for a given up-migration filename.
// Convention: "NNN: description.sql" -> "NNN: description.down.sql"
//             "NNNb_description.concurrent.sql" -> "NNNb_description.concurrent.down.sql"
// i.e. the down file always ends in ".down.sql", inserted right before the
// final ".sql".
const toDownFilename = (upFilename) => {
	if (!upFilename.endsWith(".sql")) return null;
	return upFilename.slice(0, -".sql".length) + DOWN_SUFFIX;
};

const runRollback = async (client, filename) => {
	console.log(`\nRolling back: ${filename}\n`);

	// 1. Confirm this migration is actually applied.
	const { rows: appliedRows } = await client.query(
		`SELECT filename, checksum, applied_at FROM schema_migrations ORDER BY filename`,
	);

	const target = appliedRows.find((r) => r.filename === filename);
	if (!target) {
		console.error(`❌  "${filename}" is not recorded as applied in schema_migrations. Nothing to roll back.`);
		process.exit(1);
	}

	// 2. Confirm it is the MOST RECENTLY APPLIED migration (by applied_at,
	// falling back to filename order if timestamps tie). Rolling back a
	// migration that isn't the latest would leave schema_migrations claiming
	// a later migration is applied on top of schema state that migration
	// never actually saw — silently corrupting the tracking table's meaning.
	const mostRecent = [...appliedRows].sort(
		(a, b) => b.applied_at - a.applied_at || b.filename.localeCompare(a.filename),
	)[0];

	if (mostRecent.filename !== filename) {
		console.error(
			`❌  "${filename}" is not the most recently applied migration.\n` +
				`    Most recent is: "${mostRecent.filename}" (applied ${mostRecent.applied_at.toISOString()}).\n` +
				`    Roll back migrations one at a time, most-recent-first, to keep\n` +
				`    schema_migrations consistent with actual schema state.`,
		);
		process.exit(1);
	}

	// 3. Locate and read the down file.
	const downFilename = toDownFilename(filename);
	if (!downFilename) {
		console.error(`❌  "${filename}" does not end in .sql — cannot derive a down-migration filename.`);
		process.exit(1);
	}

	const downFilePath = path.join(MIGRATIONS_DIR, downFilename);
	let downContent;
	try {
		downContent = await fs.readFile(downFilePath, "utf8");
	} catch (err) {
		console.error(`❌  No down-migration file found at: ${downFilePath}`);
		console.error(
			`    Not every migration has (or safely can have) a down file — see the\n` +
				`    header comment in the up-migration for whether this one is reversible.\n` +
				`    If it isn't, the only rollback path is a point-in-time restore.`,
		);
		process.exit(1);
	}

	const isConcurrentDown = filename.includes(CONCURRENT_SUFFIX);

	if (DRY_RUN) {
		console.log(`ℹ️   --dry-run set. Would execute:\n`);
		console.log(downContent);
		console.log(`\nThen DELETE FROM schema_migrations WHERE filename = '${filename}'`);
		return;
	}

	try {
		if (isConcurrentDown) {
			await client.query(downContent);
			await client.query(`DELETE FROM schema_migrations WHERE filename = $1`, [filename]);
		} else {
			await client.query("BEGIN");
			await client.query(downContent);
			await client.query(`DELETE FROM schema_migrations WHERE filename = $1`, [filename]);
			await client.query("COMMIT");
		}
		console.log(`✅  Rolled back: ${filename}\n`);
	} catch (err) {
		if (!isConcurrentDown) {
			try {
				await client.query("ROLLBACK");
			} catch (_) {}
		}
		console.error(`❌  Rollback failed for ${filename}`);
		console.error(`Error: ${err.message}`);
		if (isConcurrentDown) {
			console.error(
				"\n⚠️  This was a non-transactional rollback (DROP INDEX CONCURRENTLY or similar).\n" +
					"   Check for a partially-dropped or invalid index before retrying:\n" +
					"      SELECT indexrelid::regclass FROM pg_index WHERE indisvalid = false;\n",
			);
		} else {
			console.error("\nDatabase has been left in a clean state (transaction rolled back).");
		}
		process.exit(1);
	}
};

const run = async () => {
	const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

	try {
		await client.connect();
		console.log("✅  Connected to database");

		await client.query(ENSURE_MIGRATIONS_TABLE);

		if (ROLLBACK_TARGET) {
			await runRollback(client, ROLLBACK_TARGET);
			return;
		}

		const { rows: appliedRows } = await client.query(
			`SELECT filename, checksum, applied_at FROM schema_migrations ORDER BY filename`,
		);
		const applied = new Map(appliedRows.map((r) => [r.filename, r.checksum]));

		let files;
		try {
			const entries = await fs.readdir(MIGRATIONS_DIR);
			files = entries
				.filter((f) => f.toLowerCase().endsWith(".sql"))
				.filter((f) => !f.toLowerCase().endsWith(DOWN_SUFFIX))
				.sort();
		} catch (err) {
			console.error(`❌  Cannot read migrations directory: ${MIGRATIONS_DIR}`);
			console.error(`    Make sure the migrations/ folder exists at the project root.`);
			process.exit(1);
		}

		if (files.length === 0) {
			console.log("ℹ️   No migration files found in migrations/");
			return;
		}

		// Sanity guard: every .sql file in this directory is expected to match
		// the "NNN[...].sql" migration-number convention. A stray reference
		// dump or editor scratch file here would otherwise be silently picked
		// up as a real pending migration and executed — this happened once
		// already (roomies.sql). Fail loudly instead of running it.
		const MIGRATION_FILENAME_RE = /^\d{3}[a-z]?[:_ ]/i;
		const suspicious = files.filter((f) => !MIGRATION_FILENAME_RE.test(f));
		if (suspicious.length > 0) {
			console.error(`❌  Found file(s) in migrations/ that don't match the migration naming convention:`);
			suspicious.forEach((f) => console.error(`    ${f}`));
			console.error(
				`    Expected filenames to start with a 3-digit number (e.g. "016_description.sql").\n` +
					`    If this is intentional reference material, move it out of migrations/.\n` +
					`    If it's a real migration with a naming typo, fix the filename and re-run.`,
			);
			process.exit(1);
		}

		let checksumViolation = false;
		for (const file of files) {
			if (!applied.has(file)) continue;

			const filePath = path.join(MIGRATIONS_DIR, file);
			const content = await fs.readFile(filePath, "utf8");
			const currentChecksum = sha256(content);
			const storedChecksum = applied.get(file);

			if (currentChecksum !== storedChecksum) {
				console.error(`❌  CHECKSUM MISMATCH: ${file}`);
				console.error(`    Stored:  ${storedChecksum}`);
				console.error(`    Current: ${currentChecksum}`);
				console.error(`    This migration was already applied but the file has been modified.`);
				console.error(`    Create a new migration file instead of editing an applied one.`);
				checksumViolation = true;
			}
		}
		if (checksumViolation) process.exit(1);

		if (STATUS_ONLY) {
			console.log("\nMigration status:\n");
			console.log(`${pad("File", 55)} ${pad("Status", 12)} ${pad("Mode", 16)} Applied at`);
			console.log("─".repeat(100));
			for (const file of files) {
				const appliedRow = appliedRows.find((r) => r.filename === file);
				const status = appliedRow ? "✅ applied" : "⏳ pending";
				const mode = file.endsWith(CONCURRENT_SUFFIX) ? "non-transactional" : "transactional";
				const when = appliedRow ? appliedRow.applied_at.toISOString() : "—";
				console.log(`${pad(file, 55)} ${pad(status, 12)} ${pad(mode, 16)} ${when}`);
			}
			console.log("");
			return;
		}

		const pending = files.filter((f) => !applied.has(f));

		if (pending.length === 0) {
			console.log("✅  All migrations are already applied. Nothing to do.");
			return;
		}

		console.log(`\nFound ${pending.length} pending migration(s):\n`);
		pending.forEach((f) => {
			const tag = f.endsWith(CONCURRENT_SUFFIX) ? "  [non-transactional]" : "";
			console.log(`  ⏳  ${f}${tag}`);
		});
		console.log("");

		if (DRY_RUN) {
			console.log("ℹ️   --dry-run flag set. No changes applied.");
			return;
		}

		for (const file of pending) {
			const filePath = path.join(MIGRATIONS_DIR, file);
			const content = await fs.readFile(filePath, "utf8");
			const checksum = sha256(content);
			const isConcurrent = file.endsWith(CONCURRENT_SUFFIX);

			process.stdout.write(`  Applying ${file}${isConcurrent ? " (non-transactional)" : ""} ... `);

			try {
				if (isConcurrent) {
					// CONCURRENTLY statements cannot run inside a transaction block —
					// Postgres rejects them outright. Run in autocommit mode instead.
					// The bookkeeping insert below is a separate, tiny implicit
					// transaction of its own; if the process dies between the DDL
					// succeeding and this insert running, the migration IS applied
					// but NOT recorded — the next run will try to re-apply it. That
					// is safe here specifically because every .concurrent.sql file in
					// this codebase uses IF NOT EXISTS / IF EXISTS, making a retry a
					// no-op rather than a duplicate-object error. Keep that invariant
					// for every future .concurrent.sql file.
					await client.query(content);
					await client.query(
						`INSERT INTO schema_migrations (filename, checksum)
                         VALUES ($1, $2)`,
						[file, checksum],
					);
				} else {
					await client.query("BEGIN");
					await client.query(content);
					await client.query(
						`INSERT INTO schema_migrations (filename, checksum)
                         VALUES ($1, $2)`,
						[file, checksum],
					);
					await client.query("COMMIT");
				}

				console.log("✅");
			} catch (err) {
				if (!isConcurrent) {
					try {
						await client.query("ROLLBACK");
					} catch (_) {}
				}

				console.log("❌");
				console.error(`\nMigration failed: ${file}`);
				console.error(`Error: ${err.message}`);

				if (isConcurrent) {
					console.error(
						"\n⚠️  This was a non-transactional (.concurrent.sql) migration.\n" +
							"   CREATE INDEX CONCURRENTLY / DROP INDEX CONCURRENTLY do not roll back\n" +
							"   automatically on failure — a failed build can leave an INVALID index\n" +
							"   sitting in the catalog (taking up space, used by nothing). Before retrying:\n\n" +
							"   1. Check for invalid indexes:\n" +
							"      SELECT indexrelid::regclass AS index, indrelid::regclass AS table\n" +
							"      FROM pg_index WHERE indisvalid = false;\n\n" +
							"   2. Drop any found, CONCURRENTLY, to avoid a blocking lock:\n" +
							"      DROP INDEX CONCURRENTLY IF EXISTS <index_name>;\n\n" +
							"   3. Re-run this migration script. The file uses IF NOT EXISTS / IF EXISTS\n" +
							"      and is safe to retry once any invalid index is cleared.\n",
					);
				} else {
					console.error("\nDatabase has been left in a clean state (transaction rolled back).");
				}
				console.error("Fix the migration file and re-run.");
				process.exit(1);
			}
		}

		console.log(`\n✅  ${pending.length} migration(s) applied successfully.\n`);
	} finally {
		await client.end();
	}
};

run().catch((err) => {
	console.error("Unexpected error:", err);
	process.exit(1);
});
