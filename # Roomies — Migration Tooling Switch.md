# Roomies — Migration Tooling Switch (node-pg-migrate) & CI/CD Hardening

## Technical PRD

**Status:** Proposed **Owner:** Sumit **Created:** 2026-08-14 **Supersedes:** Phase 2 of
`roomies-infra-migration-prd.md` (golang-migrate plan) — see §0

---

## 0. Why this supersedes the golang-migrate plan

The original infra PRD (D1) chose golang-migrate for Phase 2. Revisiting that decision before any code is written:

- golang-migrate requires a **Go binary** in every environment that runs migrations (local dev, CI runner, deploy
  pipeline) — a second language toolchain for a pure-Node codebase, solely to run migrations.
- Its non-transactional-migration support is implicit (a migration file just isn't wrapped, by convention) rather than
  an explicit, documented API.
- **node-pg-migrate** solves the identical problem (non-transactional `CREATE INDEX CONCURRENTLY`, up/down pairs,
  dirty-state locking, checksum-equivalent safety) as a pure `npm` dependency, with `pgm.noTransaction()` as a
  first-class, explicit API for exactly the case that motivated the tooling switch in the first place.
- Both tools solve `CONCURRENTLY` the same fundamental way (see §3) — the constraint is Postgres's, not the tool's.
  Given that, the tool with zero new toolchain surface wins.

D8 (sequencing risk isolation) and D1's underlying motivation (native down migrations, non-transactional support) are
preserved; only the specific tool changes.

---

## 1. Test-compatibility confirmation (gating decision)

**Verified before writing this PRD, not assumed.**

- `npm test` invokes `src/db/migrate.js` as a **standalone script** via `test:migrate` — no test file, service, or
  controller imports it. Confirmed by inspecting every file under `tests/`.
- Every test (Jest suites, `resetDb()`, `pool.query()` calls throughout) depends only on the **resulting schema** —
  tables, columns, enums, triggers, indexes — never on which tool produced it.
- `jest.config.js` already excludes `src/db/migrate.js` from coverage as a "standalone CLI script, not exercised by
  supertest" — confirming zero app-code coupling.

**Conclusion: the test suite is fully agnostic to migration tooling**, provided the SQL content of every migration is
preserved unchanged (only file format/runner changes). This PRD proceeds on that basis. If this assumption is ever
violated (e.g., a future test imports `migrate.js` directly), re-verify before merging.

---

## 2. What changes, what doesn't

| Layer                                      | Before                                                     | After                                                              |
| ------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| Migration **content** (the actual DDL)     | `migrations/*.sql`, hand-numbered                          | **Unchanged** — same tables, triggers, enums, indexes              |
| Migration **file format**                  | `NNN: description.sql`, colons/spaces in names             | `{timestamp}_description.sql` or `.js`, node-pg-migrate convention |
| Migration **runner**                       | `src/db/migrate.js` (custom, transaction-wraps everything) | `node-pg-migrate` CLI                                              |
| Non-transactional (`CONCURRENTLY`) support | Manually disabled, commented out                           | `pgm.noTransaction()` — explicit, native                           |
| Down migrations                            | None                                                       | Full `up`/`down` pairs for every migration                         |
| Tracking table                             | `schema_migrations` (custom: filename + checksum)          | `pgmigrations` (node-pg-migrate's own: name + run_on)              |
| CI (`ci.yml`)                              | `npm ci` only — no test, no migration check                | Full gate: install → migrate up → migrate down → migrate up → test |
| Deploy pipeline                            | Manual `ENV_FILE=.env.azure node src/db/migrate.js`        | Automated, migrate-then-deploy gated GitHub Actions job            |
| Neon branch rehearsal                      | Not used                                                   | Documented runbook step for non-additive migrations                |

---

## 3. The `CONCURRENTLY` problem — technical ground truth

This section is intentionally explicit because it is the single most consequential correctness issue in this switch, and
the one most likely to be gotten wrong silently.

### 3.1 The Postgres facts (true regardless of tooling)

1. `CREATE INDEX CONCURRENTLY` **cannot execute inside a transaction block.** Postgres raises:
   `ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction block`.
2. A `CONCURRENTLY` build that fails or is interrupted leaves an **`INVALID` index** — visible in `\d tablename`,
   present in `pg_index` with `indisvalid = false`, consuming disk space, but unusable and not automatically cleaned up.
3. Postgres has **no way to roll back** a concurrent index build — there is no transaction to roll back. Retrying safely
   requires explicitly dropping the invalid index first.
4. A non-`CONCURRENTLY` `CREATE INDEX` takes a lock that **blocks writes** (not reads) to the target table for the full
   build duration.

### 3.2 node-pg-migrate's answer

`pgm.noTransaction()`, called at the top of a migration's `up`/`down` function, tells the runner: **do not wrap this
migration file in `BEGIN`/`COMMIT`.** This is the direct, documented fix for fact #1 above. It does **not** and cannot
fix facts #2–#4 — those are inherent to Postgres and must be handled by migration-writing discipline, every time,
regardless of tool.

### 3.3 The mandatory pattern — every `CONCURRENTLY` migration, no exceptions

```js
// migrations/{timestamp}_idx-example.js
exports.shorthands = undefined;

exports.up = (pgm) => {
	pgm.noTransaction();
	// DROP first — makes this migration safely re-runnable if a prior
	// attempt left an INVALID index (fact #2 above). Without this, a
	// retry after a partial failure errors with "relation already exists"
	// even though the existing index is unusable.
	pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS idx_example;`);
	pgm.sql(`
		CREATE INDEX CONCURRENTLY idx_example
		ON some_table (some_column)
		WHERE deleted_at IS NULL;
	`);
};

exports.down = (pgm) => {
	pgm.noTransaction();
	pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS idx_example;`);
};
```

**Non-negotiable rules for every `CONCURRENTLY` migration in this codebase, going forward:**

1. **One `CONCURRENTLY` operation per migration file.** Never combine it with other DDL in the same file — if the
   transactionless statement fails partway through a multi-statement file, the earlier statements in that same file are
   _not_ protected by a transaction either (there is none), so partial application becomes possible. Isolating to one
   statement per file makes the failure mode fully legible: either the index built, or it didn't.
2. **Always `DROP INDEX CONCURRENTLY IF EXISTS` before the `CREATE`**, even on a migration's first-ever run. Costs
   nothing when the index doesn't exist yet; is the only thing that makes retries safe.
3. **Never mix a `noTransaction()` migration with a transactional one in the same deploy step without reviewing
   lock/dependency order.** If migration N (non-transactional index build) depends on a column added in migration N-1
   (transactional), that's fine — they're still separate files, applied in order. What's disallowed is combining both
   kinds of DDL _inside one file_.
4. **After any `CONCURRENTLY` migration runs in CI or prod, verify validity** as an explicit follow-up check (see §5.3)
   — a silently-invalid index is worse than a missing one, because query plans may still reference it in some Postgres
   versions' planning paths, or it simply provides no performance benefit while looking present.
5. **Classify before writing:** does this migration touch/lock a table that will have real production rows by the time
   it runs? If yes → `CONCURRENTLY` + this pattern, always. If the table is guaranteed empty at migration time (e.g., a
   `CREATE TABLE` + index in the same initial-schema migration, before any data exists) → plain `CREATE INDEX` is
   acceptable and simpler; don't add `CONCURRENTLY` ceremony where it has no benefit.

### 3.4 Applying this to the current schema

Two existing index-creation statements are commented-out-`CONCURRENTLY` today, embedded inside `001_initial_schema`:

- `idx_listings_city_lower` on `listings`
- `idx_connections_interest_request_id` on `connections`

Both must be **extracted into their own dedicated migration files**, using the pattern in §3.3, as part of this
migration (see §6, step 4). They cannot remain embedded in the initial-schema file once that file is transactional
(which it should stay, since it's pure `CREATE TABLE`/`CREATE TYPE` with no concurrent operations).

`idx_listings_posted_by_status_city` (currently migration 009, already a standalone file) gets the same treatment —
converted to its own `noTransaction()` file rather than a plain transactional one.

---

## 4. Migration file inventory — old → new mapping

| Old file                                      | New file(s)                                    | Notes                                                            |
| --------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| `001: initial_schema.sql`                     | `0001_initial-schema.sql`                      | **Minus** the two `CONCURRENTLY` indexes — split out (see below) |
| — (split from 001)                            | `0002_idx-listings-city-lower.js`              | `noTransaction()`, per §3.3                                      |
| — (split from 001)                            | `0003_idx-connections-interest-request-id.js`  | `noTransaction()`, per §3.3                                      |
| `002: verification_event_outbox.sql`          | `0004_verification-event-outbox.sql`           | Unchanged content                                                |
| `003:profile_photo_url_pg_owner_profiles.sql` | `0005_profile-photo-url-pg-owner-profiles.sql` | Unchanged content                                                |
| `004: savedsearches.sql`                      | `0006_saved-searches.sql`                      | Unchanged content                                                |
| `005: Roommate matching support.sql`          | `0007_roommate-matching-support.sql`           | Unchanged content                                                |
| `006: Proper rent index.sql`                  | `0008_proper-rent-index.sql`                   | Unchanged content                                                |
| `007: fix_roommate_constraints.sql`           | `0009_fix-roommate-constraints.sql`            | **Lossy down** — see §7                                          |
| `008: fix_rent_index_redundant_index.sql`     | `0010_fix-rent-index-redundant-index.sql`      | Unchanged content                                                |
| `009: idx_listings_posted_by_status_city.sql` | `0011_idx-listings-posted-by-status-city.js`   | Converted to `noTransaction()`, per §3.4                         |
| `010: saved_search_cap.sql`                   | `0012_saved-search-cap.sql`                    | Unchanged content                                                |
| `011: rent_index_null_uniqueness.sql`         | `0013_rent-index-null-uniqueness.sql`          | **Lossy down** — see §7                                          |
| `012: pincodes.sql`                           | `0014_pincodes.sql`                            | Unchanged content                                                |
| `013: fix_verification_pending_trigger.sql`   | `0015_fix-verification-pending-trigger.sql`    | Unchanged content                                                |
| `014: fix_verification_rejected_reason.sql`   | `0016_fix-verification-rejected-reason.sql`    | Unchanged content                                                |
| `015_ fix_missing_srid_4326.sql`              | `0017_fix-missing-srid-4326.sql`               | Unchanged content                                                |

Zero-padded sequential integers, not timestamps — this is a solo-maintained repo with no concurrent-branch
version-collision risk, so sequential is simpler to reason about than the tool's default `Date.now()`-based naming.
node-pg-migrate accepts either; the config pins sequential (see §5.1).

Every `.sql`-content file above needs a **`down` counterpart written** (new work — none existed before). See §7 for
which ones are lossy.

---

## 5. Configuration

### 5.1 `package.json`

```json
{
	"scripts": {
		"migrate:up": "node-pg-migrate up -m migrations --tsconfig none",
		"migrate:down": "node-pg-migrate down -m migrations --tsconfig none",
		"migrate:down:all": "node-pg-migrate down -m migrations --tsconfig none 0",
		"migrate:create": "node-pg-migrate create -m migrations",
		"migrate:status": "node-pg-migrate up -m migrations --dry-run",
		"test": "npm run test:up && npm run test:migrate && npm run test:run; npm run test:down",
		"test:migrate": "cross-env ENV_FILE=.env.test dotenv -e .env.test -- node-pg-migrate up -m migrations"
	},
	"devDependencies": {
		"node-pg-migrate": "^7.x"
	}
}
```

`node-pg-migrate` reads `DATABASE_URL` from the environment directly — the existing `ENV_FILE` → `dotenv` pattern
already used by `src/config/env.js` and `src/db/migrate.js` is preserved via `dotenv-cli`'s `-e` flag, so
`ENV_FILE=.env.local npm run migrate:up`-style invocation stays available for local dev parity with the current
workflow.

### 5.2 `.node-pg-migraterc` (project-level defaults)

```json
{
	"migrations-dir": "migrations",
	"migration-file-language": "sql",
	"schema": "public",
	"migrations-schema": "public",
	"migrations-table": "pgmigrations",
	"check-order": true
}
```

`check-order: true` is the checksum-equivalent safety net your old `migrate.js` had — it refuses to apply a migration if
an earlier-numbered migration hasn't already run, catching the same class of "someone edited history" or "files applied
out of order" mistake your custom checksum check caught.

### 5.3 Post-`CONCURRENTLY`-migration validity check (CI + deploy)

Add to both the CI workflow and the deploy workflow, immediately after any migration run, as a cheap standing guard
against silently-invalid indexes (§3.3 rule 4):

```sql
-- scripts/check-invalid-indexes.sql
SELECT indexrelid::regclass AS index_name, indrelid::regclass AS table_name
FROM pg_index
WHERE indisvalid = false;
```

```yaml
- name: Verify no invalid indexes after migration
  run: |
      RESULT=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM pg_index WHERE indisvalid = false;")
      if [ "$RESULT" != "0" ]; then
        echo "❌ Found invalid indexes after migration — a CONCURRENTLY build likely failed partway."
        psql "$DATABASE_URL" -c "SELECT indexrelid::regclass, indrelid::regclass FROM pg_index WHERE indisvalid = false;"
        exit 1
      fi
```

This turns a silent, easy-to-miss failure mode into a hard CI/deploy failure.

---

## 6. Execution plan (sequenced)

1. `npm install --save-dev node-pg-migrate dotenv-cli`
2. Create `migrations-new/` alongside the existing `migrations/` (don't delete the old directory until step 9 confirms
   parity) — write all 17 new-format files per §4, preserving DDL content exactly except for the two `CONCURRENTLY`
   extractions
3. Write `down` migrations for all 17 files; mark 0009 and 0013 explicitly lossy per §7
4. Extract `idx_listings_city_lower` and `idx_connections_interest_request_id` out of `0001_initial-schema.sql` into
   `0002`/`0003` per §3.4
5. Convert `009_idx_listings_posted_by_status_city` to the `noTransaction()` `.js` form as `0011`
6. Add `.node-pg-migraterc`, update `package.json` scripts per §5
7. Local verification: fresh local Postgres+PostGIS, `npm run migrate:up` from zero, diff resulting schema
   (`pg_dump --schema-only`) against what the **old** `migrate.js` produces on a separate fresh DB — must be
   structurally identical
8. Local verification: `npm run migrate:down:all` — confirm clean revert with no errors (accepting the documented
   lossy-data caveats in §7, which are about data, not schema-revert failure)
9. Swap `migrations/` → `migrations-new/` content, delete old `src/db/migrate.js` and the old numbered files, rename
   `migrations-new/` → `migrations/`
10. Update `test:migrate` per §5.1 — run full `npm test` locally, confirm 100% suite pass (per §1's compatibility
    analysis, this should require zero test-file changes)
11. Update `.github/workflows/ci.yml` per §8
12. Add the deploy workflow per §9
13. Set GitHub branch protection rules per §10
14. Since Neon is currently empty: run `npm run migrate:up` against real Neon directly as the first real-world
    application — no cutover risk, no existing `schema_migrations` state to reconcile
15. Delete `roomies-infra-migration-prd.md`'s Phase 2 section, replace with a pointer to this document

---

## 7. Lossy migrations — explicit declaration

Per the original infra PRD's risk register, two migrations cannot be cleanly reverted without data loss. This is a
Postgres/data-model fact, not a tooling limitation — true under node-pg-migrate exactly as it was true under the
golang-migrate plan.

### `0009_fix-roommate-constraints` (was `007`)

```sql
-- down migration — ⚠️ LOSSY
-- Reverts FK cascade behavior (CASCADE → RESTRICT) and drops
-- chk_looking_has_timestamp. Cannot restore looking_updated_at values that
-- existed before the up-migration's backfill, nor rows that were
-- CASCADE-deleted under the new FK behavior while this migration was live.
-- Recovery for actual data loss: Neon point-in-time restore only.
```

### `0013_rent-index-null-uniqueness` (was `011`)

```sql
-- down migration — ⚠️ LOSSY
-- Drops the NULLS NOT DISTINCT constraint. Cannot restore the duplicate
-- city-wide rent_index rows deleted by the up-migration's deduplication step.
-- Recovery for actual data loss: Neon point-in-time restore only.
```

### `0004_verification-event-outbox` (was `002`) — enum value addition

```sql
-- down migration — LOSSY BY POSTGRES DESIGN, NOT THIS SCHEMA'S CHOICE
-- Postgres has never supported DROP VALUE on an existing enum type in any
-- transaction-safe way. This down migration is a documented no-op; reverting
-- the 'verification_pending' notification_type_enum value requires a manual
-- enum-type rebuild (CREATE new type, migrate column, DROP old type,
-- RENAME) and is out of scope for routine rollback tooling.
```

These three are flagged in code comments (as shown), in this PRD, and should be cross-referenced from
`roomies-infra-migration-prd.md`'s Section 6 (Rollback Plan) once that document is updated to point here.

---

## 8. `.github/workflows/ci.yml` — full replacement

```yaml
name: CI

on:
    push:
        branches: [tier0]
    pull_request:
        branches: [tier0]

concurrency:
    group: ci-${{ github.workflow }}-${{ github.ref }}
    cancel-in-progress: true

jobs:
    test:
        runs-on: ubuntu-latest
        services:
            postgres:
                image: postgis/postgis:16-3.4-alpine
                env:
                    POSTGRES_USER: postgres
                    POSTGRES_PASSWORD: postgres
                    POSTGRES_DB: roomies_test
                ports: ["5433:5432"]
                options: >-
                    --health-cmd "pg_isready -U postgres -d roomies_test" --health-interval 2s --health-timeout 3s
                    --health-retries 20
            redis:
                image: redis:7-alpine
                ports: ["6380:6379"]
                options: >-
                    --health-cmd "redis-cli ping" --health-interval 2s --health-timeout 3s --health-retries 20

        steps:
            - name: Checkout code
              uses: actions/checkout@v4
              with:
                  persist-credentials: false

            - name: Setup Node.js 24.15.0
              uses: actions/setup-node@v4
              with:
                  node-version: "24.15.0"
                  cache: "npm"

            - name: Install dependencies
              run: npm ci

            - name: Migrate up — proves migrations apply cleanly from zero
              run: npm run migrate:up
              env:
                  DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5433/roomies_test

            - name: Verify no invalid indexes after up
              run: |
                  RESULT=$(PGPASSWORD=postgres psql -h 127.0.0.1 -p 5433 -U postgres -d roomies_test -tAc \
                    "SELECT count(*) FROM pg_index WHERE indisvalid = false;")
                  if [ "$RESULT" != "0" ]; then
                    echo "❌ Invalid index detected after migrate:up"
                    exit 1
                  fi

            - name: Migrate down — proves reversibility
              run: npm run migrate:down:all
              env:
                  DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5433/roomies_test

            - name: Migrate up again — leaves DB in the state tests expect
              run: npm run migrate:up
              env:
                  DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5433/roomies_test

            - name: Run test suite
              run:
                  npx cross-env ENV_FILE=.env.test NODE_OPTIONS=--experimental-vm-modules node_modules/.bin/jest
                  --runInBand
```

Notes:

- The `test:up`/`test:down` docker-compose steps from the current `npm test` script are replaced by GitHub Actions'
  native `services:` containers — functionally equivalent (ephemeral Postgres+Redis, torn down automatically at job
  end), and avoids a nested-Docker-in-CI complication.
- `.env.test`'s `DATABASE_URL`/`REDIS_URL` already point at `127.0.0.1:5433`/`:6380`, matching the service container
  ports — no `.env.test` changes needed.
- The explicit up → down → up sequence is the concrete realization of "prove reversibility" from the earlier planning
  discussion — every PR now genuinely verifies both directions, which the old `migrate.js` never could.

---

## 9. `.github/workflows/deploy.yml` — new file

```yaml
name: Deploy

on:
    push:
        branches: [tier0]

concurrency:
    group: deploy-production
    cancel-in-progress: false # never cancel a mid-flight prod migration

jobs:
    deploy:
        runs-on: ubuntu-latest
        environment:
            production # requires the "production" GitHub Environment
            # to exist with required reviewers configured,
            # giving a manual approval gate before this runs
        steps:
            - name: Checkout code
              uses: actions/checkout@v4

            - name: Setup Node.js 24.15.0
              uses: actions/setup-node@v4
              with:
                  node-version: "24.15.0"
                  cache: "npm"

            - name: Install dependencies
              run: npm ci

            - name: Migrate — real Neon database
              run: npm run migrate:up
              env:
                  DATABASE_URL: ${{ secrets.PROD_DATABASE_URL }}
              # Failure here stops the workflow — the deploy step below never
              # runs. This is the load-bearing migrate-then-deploy ordering
              # guarantee: app code is never live against an unmigrated schema.

            - name: Verify no invalid indexes after prod migration
              run: |
                  RESULT=$(psql "${{ secrets.PROD_DATABASE_URL }}" -tAc \
                    "SELECT count(*) FROM pg_index WHERE indisvalid = false;")
                  if [ "$RESULT" != "0" ]; then
                    echo "❌ Invalid index in production after migration — investigate before proceeding."
                    exit 1
                  fi

            - name: Deploy to Azure App Service
              uses: azure/webapps-deploy@v3
              with:
                  app-name: roomies-api
                  publish-profile: ${{ secrets.AZURE_PUBLISH_PROFILE }}

            - name: Smoke test
              run: |
                  sleep 15
                  curl -f https://roomies-api.azurewebsites.net/api/v1/health || exit 1
```

The `environment: production` block ties into GitHub's native **Environments** feature — configure `production` in repo
settings with required reviewers, so every deploy (which includes a real prod migration) needs an explicit human
approval click before running, even though it's otherwise fully automated. This is the standard middle ground between
"fully manual" and "fully automatic" for the step that touches real data.

---

## 10. Branch protection (GitHub repo settings — not a file)

- **Require status checks to pass before merging** — select the `test` job from `ci.yml`
- **Require a pull request before merging** — no direct pushes to `tier0`
- **Require approval** — at least 1 review (adjust for solo-maintainer reality; can be self-approve-after-CI-green if
  this stays a single-developer repo, but the setting should still exist so it's one flip away from stricter)
- **Do not allow bypassing the above settings**, including for admins, once this is stable

---

## 11. Runbook — Neon branch rehearsal for non-additive migrations

Documented procedure, not automated (classification is a human judgment call, per the earlier discussion of why this
can't be a CI gate):

```bash
# Before merging a PR containing a migration that touches/locks a table
# expected to hold real production rows (ALTER COLUMN TYPE, adding NOT
# NULL to an existing column, non-CONCURRENTLY index creation, dropping
# a column, backfill UPDATE across many rows):

neonctl branches create --parent main --name rehearsal-pr-<number>
DATABASE_URL=<branch-connection-string> npm run migrate:up
# Inspect: timing, lock behavior (pg_locks), row counts before/after
neonctl branches delete rehearsal-pr-<number>
```

Purely additive migrations (new table, new nullable column, new `CONCURRENTLY` index following §3.3) do not require this
step — they're already proven safe by the CI ephemeral-DB run and the tool's transactional guarantees.

---

## 12. Rollback plan (updates `roomies-infra-migration-prd.md` §6)

**Tooling-level rollback:** `npm run migrate:down` reverts one migration; `migrate:down:all` reverts to zero. Both are
now real, tested-in-CI operations (§8), unlike the prior custom runner which had no down path at all.

**Data-level rollback for the three lossy migrations (§7):** unchanged from the original PRD's position — Neon
point-in-time restore is the only recovery path. Confirm Neon's PITR retention window is adequate before this PRD's
migrations ever run against a populated production database.

**Mid-switch rollback (during the tooling migration itself, §6):** the old `migrations/` directory and
`src/db/migrate.js` are not deleted until step 10 of the execution plan confirms full test-suite parity. If anything is
wrong post-swap, both tools can theoretically coexist against compatible tracking-table structures for a short window —
but the intent is a clean, fast cutover (steps 7–10 are same-day work), not a long dual-running period.

---

## 13. Exit criteria

- [ ] All 17 migrations converted, content-verified identical to originals (minus the two documented `CONCURRENTLY`
      extractions)
- [ ] `npm run migrate:up` from zero produces a schema structurally identical to the old `migrate.js`'s output (verified
      via `pg_dump --schema-only` diff)
- [ ] `npm run migrate:down:all` completes without error
- [ ] Full `npm test` suite passes, zero test file changes required
- [ ] `.github/workflows/ci.yml` gates every PR on: migrate up → invalid-index check → migrate down → migrate up → test
      suite
- [ ] `.github/workflows/deploy.yml` gates every prod deploy on: migrate up → invalid-index check → (only then) app
      deploy → smoke test
- [ ] Branch protection rules active on `tier0`
- [ ] `production` GitHub Environment configured with required reviewer approval
- [ ] Lossy migrations (§7) documented in-code and cross-referenced from the original infra PRD
- [ ] Neon branch rehearsal runbook (§11) documented and understood before the first non-additive migration ever ships
      against populated data
