





































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


const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const STATUS_ONLY = args.has("--status");



const sha256 = (content) => crypto.createHash("sha256").update(content, "utf8").digest("hex");

const pad = (str, width) => str.toString().padEnd(width);




const ENSURE_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    VARCHAR(255) PRIMARY KEY,
    checksum    VARCHAR(64)  NOT NULL,
    applied_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
`;



const run = async () => {
	const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

	try {
		await client.connect();
		console.log("✅  Connected to database");

		
		await client.query(ENSURE_MIGRATIONS_TABLE);

		
		const { rows: appliedRows } = await client.query(
			`SELECT filename, checksum FROM schema_migrations ORDER BY filename`,
		);
		const applied = new Map(appliedRows.map((r) => [r.filename, r.checksum]));

		
		
		let files;
		try {
			const entries = await fs.readdir(MIGRATIONS_DIR);
			files = entries.filter((f) => f.endsWith(".sql")).sort(); 
		} catch (err) {
			console.error(`❌  Cannot read migrations directory: ${MIGRATIONS_DIR}`);
			console.error(`    Make sure the migrations/ folder exists at the project root.`);
			process.exit(1);
		}

		if (files.length === 0) {
			console.log("ℹ️   No migration files found in migrations/");
			return;
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

		
		for (const file of pending) {
			const filePath = path.join(MIGRATIONS_DIR, file);
			const content = await fs.readFile(filePath, "utf8");
			const checksum = sha256(content);

			process.stdout.write(`  Applying ${file} ... `);

			try {
				
				
				
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
				
				try {
					await client.query("ROLLBACK");
				} catch (_) {
					
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
