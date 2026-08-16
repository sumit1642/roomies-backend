# Roomies — Infrastructure & Migration Tooling Shift
## Technical PRD & Execution Tracker

**Status:** In Progress
**Owner:** Sumit
**Created:** 2026-07-27
**Last updated:** 2026-08-16

---

## 1. Context

Roomies backend currently runs on:
- **Compute:** Render (free tier) — Node.js/Express, BullMQ workers, node-cron jobs
- **Database:** Neon (serverless Postgres, `ap-southeast-1`) — already external to Render
- **Redis:** Upstash — already external to Render
- **Blob storage:** Azure Blob Storage (`roomiesblob` account, `roomies-uploads` container) — already external to Render
- **Migrations:** custom Node runner (`src/db/migrate.js`), single `.sql` files, checksum-verified, no down migrations
- **CI/CD:** GitHub Actions now includes a `main`-only Azure deploy workflow that runs `npm ci`, `npm test`, production install, OIDC Azure login, and App Service deploy
- **Frontend:** will live on Vercel (separate from this effort)

### Problems this work addresses
1. CI does not verify migrations apply cleanly — a broken migration is only discovered manually.
2. `src/db/migrate.js` wraps every migration in a transaction, but `CREATE INDEX CONCURRENTLY` (used in migrations 001 and 002) cannot run inside a transaction — this is a live bug.
3. No down/rollback migrations exist — schema mistakes require manual SQL surgery.
4. Render free tier has cold starts (15-min idle spin-down) and no static egress IP, which is disruptive for background workers and cron jobs.
5. Azure "Azure for Students" credit (₹9,436.54 remaining, 0.03% used, resets in 45 days) is available and currently idle except for the storage account already in use.

### Explicit non-goals for this phase
- **Not** migrating Neon → Azure Database for PostgreSQL. Neon stays. Only the compute layer moves.
- **Not** migrating Redis off Upstash.
- **Not** deploying the frontend to Azure. Frontend stays on Vercel per explicit decision.
- **Not** doing the migration-tooling switch and the Azure compute switch simultaneously — sequenced deliberately (see Phase order below) so a failure in one doesn't get confused with a failure in the other.

---

## 2. Decisions Log

Recorded as they're made so we don't re-litigate them later.

| # | Decision | Rationale | Date |
|---|---|---|---|
| D1 | Keep `src/db/migrate.js` custom runner *or* switch to golang-migrate — **golang-migrate chosen** for the full switch | Native down migrations, explicit non-transactional migration support | 2026-07-27 |
| D2 | Azure region: **Southeast Asia** (revised from Central India, which was rejected by subscription policy — see history below) | Only region confirmed to actually pass App Service Plan creation on this subscription. Also co-locates with the existing `roomiesblob` storage account (also Southeast Asia), removing a cross-region hop that existed even in the original Central India plan | 2026-07-27 |
| D2-history | Original choice was Central India (matched resource group). Rejected at creation time: `RequestDisallowedByAzure` — subscription-level region policy on Azure for Students restricts deployable regions beyond what SKU-availability checks report. Southeast Asia tested next and succeeded. | — | 2026-07-27 |
| D3 | App Service tier: **B1 Basic** (not F1 Free) | F1's 60 CPU-min/day cap is incompatible with always-on BullMQ workers + cron jobs; B1 (~$13/mo, ~₹1,600-1,700 for 45 days) fits comfortably in the ₹9,436.54 budget | 2026-07-27 |
| D4 | Deploy method: **GitHub Actions** (not Azure native GitHub integration) | Needed to enforce migrate-then-deploy ordering as explicit steps; native integration has no clean hook for this | 2026-07-27 |
| D5 | App Service name: **`roomies-api`** | Backend-only deploy; frontend is separate (Vercel) | 2026-07-27 |
| D6 | Domain split: **`roomies.sumitbuilds.app` → Vercel (frontend)**, **`api.sumitbuilds.app` → Azure App Service (backend)** | Standard convention — users visit/bookmark the frontend domain; API domain is invisible infrastructure. Matches existing cross-origin cookie architecture (`sameSite: none`) already built into `authenticate.js` | 2026-07-27 |
| D7 | Frontend stays on Vercel, not Azure Static Web Apps | Better frontend-specific DX (build cache, preview UX); splitting clouds costs nothing extra since cross-origin auth is already implemented and working | 2026-07-27 |
| D8 | Sequencing: **Azure compute switch first, golang-migrate switch second**, as fully separate phases | Keeps platform-swap risk and migration-tooling-swap risk from being conflated if something breaks | 2026-07-27 |

---

## 3. Phase Plan

### Phase 0 — Azure Account Verification ✅ COMPLETE
- [x] Confirm subscription type and state (`az account show`) — Azure for Students, active
- [x] Confirm resource group exists (`roomies-rg`, Central India)
- [x] Inventory existing resources — only `roomiesblob` storage account + `roomies-uploads` container exists
- [x] Confirm B1 Linux App Service quota available in Central India
- [x] Confirm Node runtime string: `NODE|22-lts`
- [x] Register `Microsoft.Web` resource provider — confirmed `Registered`

### Phase 1 — Azure Backend Compute Provisioning 🔶 IN PROGRESS

> **Deploy branch clarified 2026-08-15:** `main` is the sole deploy-triggering branch (not `tier0`). `tier0` remains the active development/PR branch and continues to trigger `ci.yml`'s test-only workflow with no Azure credentials involved. The plan is: work happens on `tier0`, and merging `tier0` → `main` is what will trigger the Azure deploy workflow once 1.9 is written.

**Goal:** Get the existing repo (unchanged) running on Azure App Service, proving parity with Render, before touching migration tooling.

- [x] **1.1** Check real spend to date (`az consumption usage list`) — returned empty table; no discrete usage records posted yet (consistent with 0.03% used)
- [ ] **1.2** Set budget alert — CLI method failed (`az consumption budget create` — known CLI/API schema mismatch on this command, error: "Invalid budget configuration, please use filter interface with 2019-05-01-preview version"). **Fallback: Azure Portal UI**, not yet completed — see Account Reference for portal click-path
- [x] **1.3** Create App Service Plan `roomies-api-plan` — **DONE**, region corrected to **Southeast Asia** after Central India was rejected by subscription policy. `provisioningState: Succeeded`, SKU B1/Basic confirmed, `status: Ready`
- [x] **1.4** Create Web App `roomies-api` (Node 22 LTS runtime) — **DONE**; attached to `roomies-api-plan`
- [x] **1.5** Confirm Web App is live (`az webapp show`) — **DONE**; `state: Running`, `availabilityState: Normal`, hostname `roomies-api.azurewebsites.net`
- [x] **1.6** Create `.env.azure` file (mirror `.env.render` structure, same `DATABASE_URL` pointing at Neon, same `REDIS_URL` pointing at Upstash, same Azure Blob credentials) — **DONE**; 23 application variables present
- [x] **1.7** Port environment variables into Azure App Settings (`az webapp config appsettings set`) — **DONE**; all 23 `.env.azure` variables verified with `az webapp config appsettings list`. App Service does **not** read `.env` files.
- [x] **1.8** Set `WEBSITES_PORT` app setting to match `config.PORT` — **DONE**; `WEBSITES_PORT=3000` verified. The resulting 24 App Settings consist of 23 application variables plus this Azure port setting. The `set` command echo may show `null` values; use `appsettings list` as the authoritative verification.
- [x] **1.9** Write GitHub Actions workflow: `npm ci` → `npm test` → deploy to App Service, authenticating via the OIDC federated credential provisioned in 1.10 — **DONE 2026-08-16.** `.github/workflows/deploy.yml` is `main`-push only and uses two jobs: `test` (`npm ci` → `npm test`) gates `deploy` (`npm ci --omit=dev` → `azure/login@v2` via OIDC → `azure/webapps-deploy@v3` to `roomies-api` → `az logout`). First live run passed both jobs.
- [x] **1.10** Configure GitHub Secrets for Azure deploy credentials — **DONE 2026-08-16.** OIDC app registration (`roomies-api-github-oidc`), federated credential scoped to `refs/heads/main` pushes only, service principal, and `Contributor` role assignment at `roomies-rg` scope are all provisioned and CLI-verified. Required repo secrets are present in GitHub (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`) and no client secret exists or is needed.
- [ ] **1.11** First deploy — first pipeline deploy completed successfully on 2026-08-16, but the post-deploy health check is still pending after a configuration fix. Initial `GET /api/v1/health` returned an Azure platform 503 because the App Service process crashed during startup. Logs showed Postgres authentication failure for user `neondb_owner` (`28P01`); root cause was Azure App Settings `DATABASE_URL` pointing at stale Neon host `ep-divine-field-a16dgg7p-pooler.ap-southeast-1` instead of the verified `.env.azure` Neon host `ep-gentle-meadow-ax07bhxf-pooler.c-4.us-east-2`. Azure `DATABASE_URL` was overwritten with the verified value, all 24 settings were re-listed to match `.env.azure`, and the App Service restarted automatically. Remaining check: confirm `roomies-api.azurewebsites.net/api/v1/health` returns 200 with `database: ok`, `redis: ok`.
- [ ] **1.12** Confirm BullMQ workers are actually processing jobs on App Service (not just that the process boots) — test one flow end-to-end (e.g. OTP email send)
- [ ] **1.13** Confirm cron jobs register on startup (check logs for the `cron:*` registration messages already present in the codebase)
- [ ] **1.14** Load test / soak for a few hours — confirm no unexpected restarts, memory growth, or cold-start-like behavior on B1
- [ ] **1.15** Custom domain: request/verify domain ownership for `api.sumitbuilds.app`
- [ ] **1.16** Bind custom domain to App Service, enable managed TLS certificate
- [ ] **1.17** Update `ALLOWED_ORIGINS` in Azure App Settings to include `https://roomies.sumitbuilds.app`
- [ ] **1.18** Point Vercel frontend's API base URL at `https://api.sumitbuilds.app`
- [ ] **1.19** Full end-to-end smoke test: frontend (Vercel) → backend (Azure) → Neon + Upstash + Azure Blob, auth flow, listing creation, photo upload
- [ ] **1.20** Decommission / pause Render service once Azure is confirmed stable (don't delete immediately — keep as rollback option for a defined window, see Section 6)

**Exit criteria for Phase 1:** Azure serves production traffic reliably for at least 48 hours with no manual intervention, and Render is no longer required for uptime.

---

### Phase 2 — golang-migrate Adoption ⬜ NOT STARTED
**Goal:** Replace `src/db/migrate.js` with golang-migrate, with proper up/down pairs, without touching Phase 1's stability.

**Prerequisite:** Phase 1 exit criteria met. Do not start Phase 2 until Azure compute is proven stable — keeps failure domains separate per D8.

- [ ] **2.1** Install golang-migrate CLI locally
- [ ] **2.2** Spin up a fresh local Postgres (with PostGIS) matching migration 001's extensions
- [ ] **2.3** Rename all 14 existing migration files to golang-migrate's `NNNNNN_description.up.sql` / `.down.sql` convention (strip spaces/colons from current filenames)
- [ ] **2.4** Split `CREATE INDEX CONCURRENTLY` statements out into their own dedicated migration files (affects migration 001's `idx_listings_city_lower` and migration 002's `idx_connections_interest_request_id`)
- [ ] **2.5** Write `.down.sql` for each migration — flag 007 and 011 explicitly as **lossy/structural-only** reverts (cannot restore deleted/backfilled data) in file comments
- [ ] **2.6** Run `migrate up` from zero locally — diff resulting schema against current Neon schema to confirm parity
- [ ] **2.7** Run `migrate down -all` locally — confirm no errors, no orphaned objects (watch specifically for enum value drops, which Postgres restricts)
- [ ] **2.8** Write `scripts/migrate.sh` wrapper to preserve the `ENV_FILE=.env.local` / `.env.azure` pattern (golang-migrate doesn't natively support this)
- [ ] **2.9** Update `package.json` scripts (`migrate:up`, `migrate:down`, `migrate:status`) to call the wrapper
- [ ] **2.10** Delete `src/db/migrate.js` (after 2.6–2.7 pass, not before)
- [ ] **2.11** Test against a **Neon branch** (not prod) — Neon supports cheap branching; use this instead of testing directly on production data
- [ ] **2.12** Update CI workflow: spin up ephemeral Postgres service container, run `migrate up` then `migrate down -all` as a PR gate
- [ ] **2.13** Update Phase 1's GitHub Actions deploy workflow to call golang-migrate instead of `node src/db/migrate.js` before the App Service deploy step
- [ ] **2.14** Document the "dirty" state recovery procedure (golang-migrate locks further migrations after a failed run until manually forced) — add to README or runbook
- [ ] **2.15** Cut over: run golang-migrate against production Neon for the first time, confirm `schema_migrations`-equivalent tracking table state matches expectations
- [ ] **2.16** Decommission old `schema_migrations` table tracking once golang-migrate's own version table is confirmed authoritative

**Exit criteria for Phase 2:** A team member can run one command to apply or roll back any migration, CI blocks merges that break migration application, and the two known-lossy migrations (007, 011) are documented as such.

---

## 4. Open Questions / Needs Decision

- [x] Auth method for GitHub Actions → Azure deploy: **RESOLVED 2026-08-15 — OIDC federated credential chosen and fully provisioned.** See Section 3, Phase 1.9/1.10 status and Section 7 Change Log for details. No publish-profile secret was ever created.
- [ ] Should Render be deleted or just paused/downgraded after Phase 1 cutover? (Section 6 has a recommendation)
- [ ] Vercel preview deployment URLs are dynamic (`roomies-<hash>.vercel.app`) — do preview deploys need to talk to the Azure API? If yes, `ALLOWED_ORIGINS` needs a pattern-match approach, not a static list (current `app.js` CORS logic uses `config.ALLOWED_ORIGINS.includes(origin)` — exact match only, won't work for dynamic preview URLs as-is)
- [ ] Budget alert email recipient — confirm which email should receive Azure Cost Management alerts
- [ ] Stale Neon project follow-up — determine whether the old `ap-southeast-1` Neon project referenced by the previous Azure `DATABASE_URL` is still live/costing money or can be decommissioned.
- [ ] Secret hygiene after live-debug exposure — a full Azure App Settings table was printed during debugging with plaintext secrets. There is no evidence of compromise, but rotate cheap/low-risk secrets first (for example Brevo SMTP/API keys) after the deployment is stable.

---

## 5. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `az consumption budget create` rejected due to Student subscription CLI restrictions | Medium | Low | Fallback to Azure Portal UI budget setup (Section covers this) |
| B1 App Service name `roomies-api` already taken globally | Low | Low | Immediate fallback naming, no blocker |
| golang-migrate "dirty" state after a failed migration blocks all future migrations until manually forced | Medium (will happen eventually) | Medium | Documented recovery procedure (2.14), always test against Neon branch first, never against prod directly |
| Migrations 007 / 011 down-scripts give false confidence they're fully reversible | Medium | High if relied upon during an incident | Explicit comments in the down files + this PRD stating they're structural-only |
| 45-day Azure credit reset catches an in-progress migration cutover | Low (current pace has room) | Medium | Track days remaining against Section 1 phase timeline, don't let Phase 2 drag past the reset window |
| CORS `ALLOWED_ORIGINS` exact-match logic breaks Vercel preview deploys hitting the new Azure API | Medium | Low (dev convenience only, not prod-blocking) | Open question above — decide before relying on preview deploys for backend testing |

---

## 6. Rollback Plan

**During Phase 1 (Azure compute cutover):**
Render stays live and untouched until Phase 1's exit criteria (48hr stable Azure) are met. If Azure has problems, DNS/Vercel API base URL simply points back at Render — no data-layer rollback needed since Neon/Upstash/Blob are untouched throughout.

**During Phase 2 (migration tooling cutover):**
Old `src/db/migrate.js` and the existing `schema_migrations` table are not deleted until 2.15–2.16 are confirmed. If golang-migrate cutover fails partway, the original runner is still present and functional as a fallback, since both tools can coexist against the same tracking table structure until the explicit decommission step.

**Data-loss scenarios (lossy migrations 007, 011):**
Not recoverable via any down migration. Sole recovery path is Neon point-in-time restore — confirm PITR retention window is adequate *before* Phase 2 begins running against production.

---

## 7. Change Log

| Date | Change |
|---|---|
| 2026-07-27 | Document created. Phase 0 marked complete based on verified `az` command output. Phase 1 commands drafted, awaiting execution. |
| 2026-07-28 | Completed Phase 1.4–1.8: created and verified `roomies-api` (Running/Normal), prepared `.env.azure`, ported its 23 variables to Azure App Settings, and set `WEBSITES_PORT=3000`. App Settings were re-listed after the port-setting command and all 24 settings remained present. |
| 2026-08-15 | OIDC federation for GitHub Actions → Azure deploy completed (Phase 1.9–1.10 prerequisite). Created App Registration `roomies-api-github-oidc` (appId `1d2282ba-5347-4153-a18a-16b95a18068e`, object ID `880d4a39-fb7f-454b-8c15-e84d6cc4dfb1`). Added federated credential `roomies-api-main-branch-deploy`, subject `repo:sumit1642/roomies-backend:ref:refs/heads/main` — deploy federation is scoped to `main`-branch pushes only; `tier0` and PRs remain test-only via existing `ci.yml`, no Azure federation. Created service principal (object ID `55431d16-3577-4c3f-a97b-ffa03d2e5b2c`) and assigned `Contributor` at `roomies-rg` scope (role assignment ID `387eb9fc-9ce0-4568-a5e0-448be2b3f6d3`). Scope decision: RG-level chosen over resource-level, deliberately, given the planned future migration of DB/other services into `roomies-rg` and solo-operator deploy triggering — documented as a conscious least-privilege tradeoff, not a default. No client secret created; OIDC token exchange only. All four provisioning steps were independently re-queried (`list`/`show`) and corroborated before proceeding to the next. Workflow YAML (`.github/workflows/deploy.yml`) not yet written — that is the next actionable step under 1.9. |
| 2026-08-16 | Wrote and shipped `.github/workflows/deploy.yml` for `main` pushes only. The first live GitHub Actions run passed both the gated `test` job and the OIDC-backed `deploy` job to `roomies-api`. Post-deploy health initially failed with an Azure platform 503 because the app crashed on startup due to stale Azure App Settings `DATABASE_URL` pointing at an old Neon host. Replaced Azure `DATABASE_URL` with the verified `.env.azure` Neon connection target, confirmed all 24 App Settings now match `.env.azure`, and left 1.11 pending on the post-restart health response. Added follow-up hygiene items for the stale Neon project and low-cost secret rotation after plaintext app settings were exposed in the debugging chat. |
