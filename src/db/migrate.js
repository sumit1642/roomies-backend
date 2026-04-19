// src/db/migrate.js
//
// Minimal, dependency-free migration runner for Roomies.
//
// Design philosophy:
//   This runner deliberately avoids any migration framework (Flyway, Liquibase,
//   node-pg-migrate) to keep the stack lean. The implementation is ~100 lines
//   and does exactly what a migration runner needs to do: track which migrations
//   have been applied, apply pending ones in order, and never apply the same
//   migration twice. No magic, no abstractions, no new dependencies.
//
// How it works:
//   1. Creates a schema_migrations table in your database on first run.
//   2. Reads all *.sql files from the migrations/ directory, sorted by filename.
//      The naming convention 001_, 002_, 003_ guarantees stable alphabetical
//      ordering which equals chronological ordering.
//   3. Compares the file list against already-applied migrations in the DB.
//   4. Runs each pending migration inside its own transaction. If a migration
//      fails, the transaction rolls back and the runner exits with a non-zero
//      code — the database is left in a clean, pre-migration state.
//   5. On success, records the migration filename + checksum in schema_migrations.
//
// Checksum guard:
//   Each migration file's SHA-256 checksum is stored when it is first applied.
//   On subsequent runs, if an already-applied migration's file has been modified
//   on disk, the runner logs a warning and exits. This protects against the
//   common mistake of editing a previously-applied migration instead of creating
//   a new one — a habit that causes schema drift across environments.
//
// Usage:
//   node src/db/migrate.js               ← apply pending migrations
//   node src/db/migrate.js --dry-run     ← show what would run, apply nothing
//   node src/db/migrate.js --status      ← list applied/pending migration status
//
// In CI/CD:
//   Add "node src/db/migrate.js" as a pre-deployment step. It is safe to run
//   on every deploy because already-applied migrations are skipped.

import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import pg from "pg";
import dotenv from "dotenv";

// ─── Bootstrap env ────────────────────────────────────────────────────────────
// The runner is invoked directly (not through app.js), so we load env vars
// manually. ENV_FILE follows the same convention as the main app.
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

// ─── Paths ────────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

// ─── Parse CLI flags ─────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const STATUS_ONLY = args.has("--status");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sha256 = (content) => crypto.createHash("sha256").update(content, "utf8").digest("hex");

const pad = (str, width) => str.toString().padEnd(width);

// ─── Migration tracking table ─────────────────────────────────────────────────
// Created automatically on first run. Deliberately simple — no framework
// metadata, just the filename, checksum, and when it was applied.
const ENSURE_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    VARCHAR(255) PRIMARY KEY,
    checksum    VARCHAR(64)  NOT NULL,
    applied_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
`;

// ─── Main ─────────────────────────────────────────────────────────────────────

const run = async () => {
	const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

	try {
		await client.connect();
		console.log("✅  Connected to database");

		// Ensure the tracking table exists before any queries against it.
		await client.query(ENSURE_MIGRATIONS_TABLE);

		// Fetch the set of already-applied migrations and their checksums.
		const { rows: appliedRows } = await client.query(
			`SELECT filename, checksum FROM schema_migrations ORDER BY filename`,
		);
		const applied = new Map(appliedRows.map((r) => [r.filename, r.checksum]));

		// Read the migrations directory and sort files lexicographically.
		// The 001_, 002_ prefix convention guarantees chronological order.
		let files;
		try {
			const entries = await fs.readdir(MIGRATIONS_DIR);
			files = entries.filter((f) => f.endsWith(".sql")).sort(); // lexicographic = chronological with the naming convention
		} catch (err) {
			console.error(`❌  Cannot read migrations directory: ${MIGRATIONS_DIR}`);
			console.error(`    Make sure the migrations/ folder exists at the project root.`);
			process.exit(1);
		}

		if (files.length === 0) {
			console.log("ℹ️   No migration files found in migrations/");
			return;
		}

		// ── Checksum integrity check for already-applied migrations ─────────
		// If a previously-applied file has been edited on disk, warn and exit.
		// This is the most common cause of schema drift between environments.
		let checksumViolation = false;
		for (const file of files) {
			if (!applied.has(file)) continue; // Pending migration, skip for now

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

		// ── Status report ───────────────────────────────────────────────────
		if (STATUS_ONLY) {
			console.log("\nMigration status:\n");
			console.log(`${pad("File", 45)} ${pad("Status", 12)} Applied at`);
			console.log("─".repeat(80));
			for (const file of files) {
				const appliedRow = appliedRows.find((r) => r.filename === file);
				const status = appliedRow ? "✅ applied" : "⏳ pending";
				const when = appliedRow ? appliedRow.applied_at.toISOString() : "—";
				console.log(`${pad(file, 45)} ${pad(status, 12)} ${when}`);
			}
			console.log("");
			return;
		}

		// ── Apply pending migrations ─────────────────────────────────────────
		const pending = files.filter((f) => !applied.has(f));

		if (pending.length === 0) {
			console.log("✅  All migrations are already applied. Nothing to do.");
			return;
		}

		console.log(`\nFound ${pending.length} pending migration(s):\n`);
		pending.forEach((f) => console.log(`  ⏳  ${f}`));
		console.log("");

		if (DRY_RUN) {
			console.log("ℹ️   --dry-run flag set. No changes applied.");
			return;
		}

		// Apply each pending migration inside its own transaction.
		for (const file of pending) {
			const filePath = path.join(MIGRATIONS_DIR, file);
			const content = await fs.readFile(filePath, "utf8");
			const checksum = sha256(content);

			process.stdout.write(`  Applying ${file} ... `);

			try {
				// Each migration gets its own BEGIN/COMMIT so a failure in
				// migration N does not affect migrations 1..N-1 which already
				// committed. The failed migration is the one that rolls back.
				await client.query("BEGIN");
				await client.query(content);
				await client.query(
					`INSERT INTO schema_migrations (filename, checksum)
                     VALUES ($1, $2)`,
					[file, checksum],
				);
				await client.query("COMMIT");

				console.log("✅");
			} catch (err) {
				// Roll back the failed migration transaction.
				try {
					await client.query("ROLLBACK");
				} catch (_) {
					/* ignore */
				}

				console.log("❌");
				console.error(`\nMigration failed: ${file}`);
				console.error(`Error: ${err.message}`);
				console.error("\nDatabase has been left in a clean state (transaction rolled back).");
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
