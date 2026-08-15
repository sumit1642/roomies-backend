// src/db/seeds/seedGuard.js
//
// Shared safety gate for seed scripts. Seed scripts perform bulk
// inserts/upserts (amenities.js: ~18 rows ON CONFLICT DO NOTHING;
// pincodes.js: ~19.5k rows ON CONFLICT DO UPDATE) directly against whatever
// DATABASE_URL the process resolves via ENV_FILE. Before this guard, nothing
// printed which environment was about to be written to, and there was no
// confirmation step — a mistyped or copy-pasted npm script (e.g. running
// prodAzureSeed:pincodes instead of devSeed:pincodes) would silently upsert
// production reference data with no chance to abort.
//
// This module must be imported AFTER "../../config/env.js" has already run
// (so config.DATABASE_URL / config.NODE_ENV / process.env.ENV_FILE are
// populated) and BEFORE any query against `pool` is issued.

import readline from "readline";
import { config } from "../../config/env.js";

const redactUrl = (url) => {
	try {
		const parsed = new URL(url);
		if (parsed.password) parsed.password = "****";
		if (parsed.username) parsed.username = parsed.username ? "****" : parsed.username;
		return parsed.toString();
	} catch {
		return "<unparseable DATABASE_URL>";
	}
};

const inferEnvironmentLabel = () => {
	const envFile = process.env.ENV_FILE;
	if (envFile === ".env.local" || !envFile) return "LOCAL (development)";
	if (envFile === ".env.render") return "PRODUCTION — Render";
	if (envFile === ".env.azure") return "PRODUCTION — Azure";
	if (envFile === ".env.test") return "TEST";
	return `UNKNOWN (ENV_FILE=${envFile})`;
};

const isProductionTarget = () => {
	const envFile = process.env.ENV_FILE;
	return envFile === ".env.render" || envFile === ".env.azure" || config.NODE_ENV === "production";
};

const promptYesNo = (question) =>
	new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim().toLowerCase());
		});
	});

/**
 * Prints the resolved seed target (environment label + redacted DB host) and,
 * for anything that looks like production, requires the operator to type the
 * environment's own ENV_FILE name back verbatim before proceeding.
 *
 * Non-interactive runs (CI, piped stdin) can opt in explicitly via
 * SEED_CONFIRM=yes — there is deliberately no other bypass, so a bare
 * `npm run prod*Seed:*` invoked without a TTY and without SEED_CONFIRM fails
 * closed rather than silently seeding prod.
 */
export const confirmSeedTarget = async (scriptLabel) => {
	const envLabel = inferEnvironmentLabel();
	const dbHost = (() => {
		try {
			return new URL(config.DATABASE_URL).host;
		} catch {
			return "<unparseable>";
		}
	})();

	console.log(`\n──────────────────────────────────────────────────────────`);
	console.log(` Seed script : ${scriptLabel}`);
	console.log(` Target      : ${envLabel}`);
	console.log(` DATABASE_URL: ${redactUrl(config.DATABASE_URL)}`);
	console.log(` DB host     : ${dbHost}`);
	console.log(`──────────────────────────────────────────────────────────\n`);

	if (!isProductionTarget()) {
		// Local/test targets proceed without a confirmation prompt — the whole
		// point of the guard is to slow down prod writes, not add friction to
		// the everyday dev loop.
		return;
	}

	if (process.env.SEED_CONFIRM === "yes") {
		console.log("SEED_CONFIRM=yes set — skipping interactive prompt.\n");
		return;
	}

	if (!process.stdin.isTTY) {
		console.error(
			`❌  Refusing to seed ${envLabel} non-interactively.\n` +
				`    Re-run with SEED_CONFIRM=yes if this is intentional (e.g. CI), ` +
				`or run interactively to confirm by hand.\n`,
		);
		process.exit(1);
	}

	const expected = process.env.ENV_FILE;
	const answer = await promptYesNo(
		`⚠️  This will write to ${envLabel}. Type "${expected}" to confirm, anything else to abort: `,
	);

	if (answer !== expected.toLowerCase()) {
		console.error("\n❌  Confirmation did not match — aborting. No changes were made.\n");
		process.exit(1);
	}

	console.log("\n✅  Confirmed — proceeding with seed.\n");
};
