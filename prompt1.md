# Roomies Backend — Documentation Audit & Update Prompt

## How to Use This Prompt

This is a **chained instruction set**. The work is broken into focused phases, each of which references a specific
section of the codebase and the existing documentation. Complete the phases in order. Each phase produces output files
that are inputs for the next.

The existing documentation lives under `docs/`. The authoritative source of truth for contracts is always the code:
`src/routes/`, `src/validators/`, `src/services/`, `src/middleware/`.

---

## Phase 0 — Orientation (Read Before Doing Anything)

Before writing a single line of documentation, internalise these rules. They govern every decision in every phase that
follows.

**Rule 1 — Scenario-based JSON format is the canonical style.** Every endpoint must be documented as a series of named
scenarios. Each scenario has a title, a request contract (method, path, auth, headers, body), and a response block
showing the exact JSON. No prose descriptions of what a field "might" contain — show the actual shape. See the existing
`docs/api/auth.md` for the reference style.

**Rule 2 — Chained files, not a monolith.** Documentation is split across files linked by hyperlinks. `docs/API.md` is
the front door. Feature docs live in `docs/api/`. No feature doc should grow beyond its own feature boundary. If a new
feature was added, create a new file and link it from `docs/API.md` and from `docs/README.md`.

**Rule 3 — Code is truth, docs are its reflection.** If the service throws `new AppError("message", 404)`, the doc shows
a `404` response with `{ "status": "error", "message": "message" }`. Never infer or paraphrase the error body — copy it
exactly as the service constructs it.

**Rule 4 — Status codes come from both routes and services.** Check the controller for the success status code
(`res.status(201)` vs `res.json()`), and check the service for every `AppError`. Also check
`src/middleware/errorHandler.js` for the PostgreSQL constraint codes (23505 → 409, 23503 → 409, 23514 → 400) that
produce implicit error responses.

**Rule 5 — Document gates as first-class responses.** When a route has middleware that can short-circuit (e.g.
`contactRevealGate`, `authorize`, `guestListingGate`), those middleware responses are endpoint outcomes and must appear
as scenarios. Do not hide them in a footnote.

---

## Phase 1 — Audit the Existing Feature Docs Against Current Code

For each file listed below, open the doc and the corresponding source files side by side. For every discrepancy you
find, note it and fix it in the doc. The checklist below tells you exactly which source files to cross-reference.

### 1.1 — `docs/api/auth.md`

Cross-reference against:

- `src/routes/auth.js`
- `src/validators/auth.validators.js`
- `src/services/auth.service.js`
- `src/controllers/auth.controller.js`

Things to verify:

- The `POST /auth/logout` route does **not** require `authenticate` middleware but `POST /auth/logout/current` does.
  Confirm both are accurately described.
- The `DELETE /auth/sessions/:sid` route: confirm the scenario where revoking the **current** session also clears auth
  cookies is documented.
- The `parseTtlSeconds` function in `auth.service.js` accepts numeric TTL values in addition to string formats — confirm
  the JWT expiry behaviour description is still accurate.
- The `verifyRefreshTokenPayload` function has a legacy token migration path. The doc should note that legacy tokens
  (issued before per-session keys) are transparently migrated on first use — callers never need to handle this.
- `POST /auth/google/callback`: three internal paths (returning user, account linking, new registration) — all three
  scenarios must be present with their exact response shapes.

### 1.2 — `docs/api/profiles-and-contact.md`

Cross-reference against:

- `src/routes/student.js`
- `src/routes/pgOwner.js`
- `src/validators/student.validators.js`
- `src/validators/pgOwner.validators.js`
- `src/services/student.service.js`
- `src/services/pgOwner.service.js`
- `src/middleware/contactRevealGate.js`

Things to verify:

- The student contact reveal route is `GET` but the PG owner contact reveal route is `POST`. Confirm this asymmetry is
  documented with its rationale (POST prevents browser prefetch/cache of PII).
- Both reveal endpoints set `Cache-Control: no-store` before the gate runs. This header appears on **all** responses
  from those routes — including 429 limit-reached responses. Confirm this is reflected in the scenarios.
- The gate's two-tier model: verified users get unlimited + full bundle; guests/unverified get 10 reveals + email-only.
  The `contactRevealGate.js` middleware now uses a **pre-response hook** (wrapping `res.json`, `res.send`, `res.end`) to
  charge quota after a successful 2xx response rather than using `res.on("finish")`. The doc doesn't need to describe
  the implementation, but it must correctly state that quota is charged only on successful reveals.
- `GET /students/:userId/preferences` and `PUT /students/:userId/preferences` are mounted in `src/routes/student.js` —
  confirm they are documented (they appear in `profiles-and-contact.md`).

### 1.3 — `docs/api/listings.api.md`

Cross-reference against:

- `src/routes/listing.js`
- `src/validators/listing.validators.js`
- `src/services/listing.service.js`
- `src/middleware/guestListingGate.js`
- `src/services/listingLifecycle.js`

Things to verify:

- Guest access: `GET /listings` and `GET /listings/:listingId` are the only two endpoints that accept unauthenticated
  requests. Confirm the doc clearly states this and shows a guest scenario for both.
- `compatibilityAvailable` field: the search response now includes both `compatibilityScore` (integer) and
  `compatibilityAvailable` (boolean). The existing doc only shows `compatibilityScore`. Add `compatibilityAvailable` to
  all search result item shapes.
- The `guestListingGate` middleware caps the `limit` query param to 20 for guests silently. Document this as part of the
  guest access table.
- `EXPIRED_LISTING_MESSAGE` and `UNAVAILABLE_LISTING_MESSAGE` are constants in `listingLifecycle.js`. The exact strings
  are `"Listing has expired and is no longer available"` and `"Listing is no longer available"`. Confirm the error
  scenarios in the doc show these exact strings, not paraphrases.
- For `PUT /listings/:listingId`: the `422` scenario for updating location fields on a `pg_room` or `hostel_bed` listing
  should show the actual message format:
  `"Location fields (city, latitude) cannot be updated on a pg_room listing — they are inherited from the parent property. Update the property's address instead."`
  (with the actual field names interpolated).
- The `PATCH /listings/:listingId/status` response does not include `rentPerMonth` or other listing fields — it only
  returns `{ listingId, status }`. Confirm the doc shows the correct minimal shape.

### 1.4 — `docs/api/interests.md`

Cross-reference against:

- `src/routes/interest.js`
- `src/routes/listing.js` (for the listing-scoped interest routes)
- `src/validators/interest.validators.js`
- `src/services/interest.service.js`

Things to verify:

- The `POST /listings/:listingId/interests` route requires `authorize("student")`. Confirm the doc correctly states this
  is student-only.
- The accept transition response includes `whatsappLink` (can be `null` if the poster has no phone) and `listingFilled`
  (boolean). Confirm both fields are in the scenario response.
- The `GET /listings/:listingId/interests` route returns `403` when the listing exists but the caller doesn't own it,
  and `404` when the listing doesn't exist. These are two distinct error scenarios that must both be documented.
- The `createInterestRequest` service uses `ON CONFLICT ... DO NOTHING` on the partial unique index
  `(sender_id, listing_id) WHERE status IN ('pending','accepted')`. This means re-sending an interest request after a
  previous one was declined or withdrawn succeeds (it creates a new row). The doc should clarify this behaviour.

### 1.5 — `docs/api/connections.md`

Cross-reference against:

- `src/routes/connection.js`
- `src/validators/connection.validators.js`
- `src/services/connection.service.js`

Things to verify:

- The `confirmConnection` service uses a single atomic `UPDATE` with a `CASE WHEN` block to flip the caller's flag and
  promote `confirmation_status` to `'confirmed'` when both flags are true. The doc should reflect that this is a single
  atomic operation, not two steps.
- `GET /connections/me` supports `confirmationStatus` and `connectionType` query filters. Confirm both are documented
  with their valid enum values.

### 1.6 — `docs/api/ratings-and-reports.md`

Cross-reference against:

- `src/routes/rating.js`
- `src/validators/rating.validators.js`
- `src/validators/report.validators.js`
- `src/services/rating.service.js`
- `src/services/report.service.js`

Things to verify:

- `GET /ratings/user/:userId` and `GET /ratings/property/:propertyId` are public (no auth). Confirm the doc does not
  mention an auth requirement for these two endpoints.
- The `submitRating` zero-rowCount disambiguation: the service checks for three distinct failure cases (connection not
  found/not party → 404, connection unconfirmed → 422, duplicate rating → 409). All three should be distinct scenarios.
- The `resolveReport` endpoint's `adminNotes` field: it is required when `resolution = "resolved_removed"` and optional
  otherwise. This cross-field constraint must be visible in the doc.
- The `submitReport` service uses an atomic `INSERT ... SELECT ... FROM ratings JOIN connections` to enforce party
  membership. The 404 message is `"Rating not found or you are not a party to this connection"`. Confirm this exact
  string is shown.

### 1.7 — `docs/api/notifications.md`

Cross-reference against:

- `src/routes/notification.js`
- `src/validators/notification.validators.js`
- `src/services/notification.service.js`
- `src/workers/notificationWorker.js`

Things to verify:

- The `POST /notifications/mark-read` validator uses `z.literal(true)` for the `all` field, meaning `{ all: false }` is
  a validation error, not a no-op. The doc should show the validation error scenario for `all: false` (it currently only
  shows the scenario for providing both modes simultaneously).
- The `NOTIFICATION_MESSAGES` map in `notificationWorker.js` is the source of truth for message text. Verify that the
  notification type table in the doc matches the map exactly — including `listing_expired` (distinct from
  `listing_expiring`), `listing_filled`, and `connection_requested` (currently PLANNED, no emitter yet).

### 1.8 — `docs/api/health.md`

Cross-reference against:

- `src/routes/health.js`

This file is likely accurate. Quick check: confirm the `503` degraded response shape uses `"timeout"` as a service
status string (not `"timed_out"` or any other variant) — sourced from `isTimeoutError()` in `health.js`.

---

## Phase 2 — Document New or Undocumented Features

The following features are either missing from the docs entirely or only partially covered. Create new sections or new
files as needed.

### 2.1 — Admin Feature Doc (`docs/api/admin.md`)

This file is referenced in `docs/API.md` and `docs/README.md` but check whether it contains full scenario-based
documentation for all admin endpoints. The admin surface is:

**Verification queue** (in `src/routes/admin.js`, served by `src/services/verification.service.js`):

- `GET /admin/verification-queue` — paginated, oldest-first
- `POST /admin/verification-queue/:requestId/approve`
- `POST /admin/verification-queue/:requestId/reject`

**Report queue** (in `src/routes/admin.js`, served by `src/services/report.service.js`):

- `GET /admin/report-queue` — paginated, oldest-first
- `PATCH /admin/reports/:reportId/resolve`

All five endpoints share the same auth requirement: `authenticate` + `authorize('admin')` enforced at the router level.
Every request to any route under `/admin` that lacks a valid admin JWT produces a `403` before the route handler runs.

For each endpoint, document every scenario the service can produce, including the concurrent-state `409` (e.g. approving
an already-resolved request), the `404` party check where applicable, and the cross-field validation error on
`resolveReport` (adminNotes required for `resolved_removed`).

### 2.2 — Preferences Feature Doc (`docs/api/preferences.md`)

This file exists but verify it is complete. The full preferences surface is:

- `GET /preferences/meta` — returns the PREFERENCE_DEFINITIONS catalog (served by `src/services/preferences.service.js`)
- `GET /students/:userId/preferences` — owner-only, returns the student's current preference profile
- `PUT /students/:userId/preferences` — owner-only, full replace (empty array clears all)

The `dedupePreferencesByKey` function in `src/config/preferences.js` applies last-write-wins when duplicate keys are
submitted. Document this as a named scenario: "Request with duplicate preference keys — last value wins, no error
returned."

The allowed preference keys and values come from `PREFERENCE_DEFINITIONS` in `src/config/preferences.js`. The doc should
include the full current catalog so integrators don't need to call `/preferences/meta` just to know valid values.

### 2.3 — Cron Job Behaviour in `docs/API.md`

The "Background Jobs That Affect API Behavior" section in `docs/API.md` lists three cron jobs. Verify the descriptions
match the actual schedules and behaviour in the cron files:

- `src/cron/listingExpiry.js` — runs at `0 2 * * *` (02:00 daily), transitions `active` listings to `expired` where
  `expires_at < NOW()`, then bulk-expires pending interest requests. Overridable via `CRON_LISTING_EXPIRY` env var.
- `src/cron/expiryWarning.js` — runs at `0 1 * * *` (01:00 daily), enqueues `listing_expiring` notifications for
  listings expiring within 7 days. Uses an idempotency key of format `expiry_warning:{listing_id}:{YYYY-MM-DD}` to
  prevent duplicate warnings per calendar day. Overridable via `CRON_EXPIRY_WARNING`.
- `src/cron/hardDeleteCleanup.js` — runs at `0 4 * * 0` (04:00 every Sunday), hard-deletes soft-deleted rows older than
  `SOFT_DELETE_RETENTION_DAYS` (default 90 days). Overridable via `CRON_HARD_DELETE`.

The `SOFT_DELETE_RETENTION_DAYS` variable has a strict format requirement: plain decimal integer only (e.g. `"90"`, not
`"90days"` or `"-30"`). Document this in `docs/API.md` under the background jobs section.

---

## Phase 3 — Update `docs/TechStack.md` for Recent Changes

Cross-reference against `src/config/env.js` and `src/workers/emailWorker.js`.

The `EMAIL_PROVIDER` enum now includes `"brevo-api"` as a third valid value alongside `"ethereal"` and `"brevo"`. The
TechStack doc's email section should describe all three options.

The email delivery pipeline has moved from direct `sendMail()` calls in `auth.service.js` to a BullMQ queue
(`email-delivery`) processed by `src/workers/emailWorker.js`. Update the BullMQ queues table in `docs/TechStack.md` to
add:

| Queue name       | Worker file      | Concurrency   | Used for                                                      |
| ---------------- | ---------------- | ------------- | ------------------------------------------------------------- |
| `email-delivery` | `emailWorker.js` | 3 (I/O-bound) | OTP emails, verification status emails via CDC outbox drainer |

Also document the new CDC outbox worker (`src/workers/verificationEventWorker.js`) which is not a BullMQ worker but a
`setInterval`-based polling loop. It reads from `verification_event_outbox` (written by the
`trg_verification_status_changed` Postgres trigger), processes events, and enqueues both in-app notifications and
emails. This should be explained in its own subsection under the Workers section.

---

## Phase 4 — Update `docs/ImplementationPlan.md`

This file tracks phase and branch status. The following updates are needed:

**Phase 5 status correction:** `phase5/cron` is marked ✅ MERGED. Verify `phase5/admin` is still ⏳ NOT STARTED and that
the "What needs building" list accurately reflects what the `emailWorker.js` already provides (the email worker is done
— remove it from the "needs building" list) versus what is genuinely still missing (admin user management endpoints,
analytics endpoint, admin rating visibility endpoints).

**Source file inventory additions:** The following files exist in the codebase and should be added to the inventory if
they are not already listed:

- `src/workers/emailWorker.js`
- `src/workers/emailQueue.js`
- `src/workers/verificationEventWorker.js`
- `src/middleware/guestListingGate.js`

**DB trigger reference table:** The `trg_verification_status_changed` trigger (introduced in migration 002) should be
added to the trigger table with its table, firing condition, and action described.

---

## Phase 5 — Update `docs/Deployment.md` and Deployment Tier Docs

The deployment docs are spread across `docs/Deployment.md` (the older combined guide) and the newer
`docs/deployment/tier0.md`, `docs/deployment/tier1.md`, `docs/deployment/tier2.md`.

**Priority check for `docs/deployment/tier0.md`:** This is the most operationally relevant guide. Verify that it
accurately reflects the `brevo-api` email provider requirement (SMTP is blocked on Render free tier — this is already
addressed in Phase 1 of the tier0 guide with the code changes). Confirm that the env var `EMAIL_PROVIDER=brevo-api` is
correctly used throughout the setup instructions and that `BREVO_API_KEY` (not `BREVO_SMTP_KEY`) is what this mode
requires.

**`TRUST_PROXY` in tier0 guide:** The Render deployment must set `TRUST_PROXY=1`. Verify the Render environment variable
table in Phase 7.2 of `docs/deployment/tier0.md` includes this row.

**`NODE_ENV` in `.env.render`:** The current `.env.render` file has `NODE_ENV=development`. The tier0 guide Phase 7.2
table correctly lists `NODE_ENV=production`. Add a callout in the guide noting that the `.env.render` file is for local
testing against live Tier 0 services and therefore uses `development`, whereas the actual Render dashboard environment
variable should be `production`. This distinction must be explicit to avoid confusion.

---

## Phase 6 — Final Consistency Pass

After completing all phases above, do a final sweep:

**Check all hyperlinks.** Every cross-reference between doc files (e.g. `docs/API.md` → `docs/api/auth.md`) should
resolve correctly. If you created a new file, make sure it is linked from `docs/README.md` and from `docs/API.md`.

**Check example UUIDs.** The conventions file (`docs/api/conventions.md`) defines canonical example UUIDs (student =
`11111111-...`, PG owner = `22222222-...`, etc.). Every scenario in every feature doc should use these consistent
example values, not random UUIDs.

**Check the HTTP status code table.** `docs/API.md` section 20 has a table of status codes. Verify that `202` (photo
upload async) and `503` (service unavailable, including the queue-unavailable response from `photo.service.js`) are
present and described accurately.

**Check the pagination section.** `docs/API.md` section 19 documents keyset pagination. Verify it mentions the
constraint that `cursorTime` and `cursorId` must always be provided together, and that providing one without the other
returns a `400`.

---

## Deliverables Checklist

When all phases are complete, the following should be true:

- [ ] Every endpoint in `src/routes/` has at least one success scenario and all failure scenarios documented in a
      `docs/api/` file.
- [ ] Every file in `docs/api/` has been reviewed against current source code and any stale scenarios corrected.
- [ ] `docs/README.md` links to every file in `docs/api/`.
- [ ] `docs/API.md` feature docs list is complete and all links resolve.
- [ ] `docs/TechStack.md` BullMQ queue table includes all three current workers.
- [ ] `docs/ImplementationPlan.md` source file inventory includes all current workers and middleware.
- [ ] `docs/deployment/tier0.md` correctly documents `EMAIL_PROVIDER=brevo-api`, `TRUST_PROXY=1`, and the `NODE_ENV`
      distinction between the file and the Render dashboard.
- [ ] All cross-file hyperlinks resolve correctly.
- [ ] All scenario response bodies use the exact strings from the source code, not paraphrases.

---

## Reference: Quick-Lookup Source Files

Use this table when auditing a specific feature to know exactly which files to open:

| Feature                  | Routes                                       | Validators                              | Service                                                                       | Controller                               |
| ------------------------ | -------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------- |
| Auth                     | `routes/auth.js`                             | `validators/auth.validators.js`         | `services/auth.service.js`                                                    | `controllers/auth.controller.js`         |
| Student profiles & prefs | `routes/student.js`                          | `validators/student.validators.js`      | `services/student.service.js`                                                 | `controllers/student.controller.js`      |
| PG owner profiles        | `routes/pgOwner.js`                          | `validators/pgOwner.validators.js`      | `services/pgOwner.service.js`                                                 | `controllers/pgOwner.controller.js`      |
| Properties               | `routes/property.js`                         | `validators/property.validators.js`     | `services/property.service.js`                                                | `controllers/property.controller.js`     |
| Listings                 | `routes/listing.js`                          | `validators/listing.validators.js`      | `services/listing.service.js`                                                 | `controllers/listing.controller.js`      |
| Photos                   | `routes/listing.js`                          | `validators/photo.validators.js`        | `services/photo.service.js`                                                   | `controllers/photo.controller.js`        |
| Interests                | `routes/interest.js`, `routes/listing.js`    | `validators/interest.validators.js`     | `services/interest.service.js`                                                | `controllers/interest.controller.js`     |
| Connections              | `routes/connection.js`                       | `validators/connection.validators.js`   | `services/connection.service.js`                                              | `controllers/connection.controller.js`   |
| Notifications            | `routes/notification.js`                     | `validators/notification.validators.js` | `services/notification.service.js`                                            | `controllers/notification.controller.js` |
| Ratings                  | `routes/rating.js`                           | `validators/rating.validators.js`       | `services/rating.service.js`                                                  | `controllers/rating.controller.js`       |
| Reports                  | `routes/rating.js`                           | `validators/report.validators.js`       | `services/report.service.js`                                                  | `controllers/report.controller.js`       |
| Verification (admin)     | `routes/admin.js`                            | `validators/verification.validators.js` | `services/verification.service.js`                                            | `controllers/verification.controller.js` |
| Preferences              | `routes/preferences.js`, `routes/student.js` | `validators/preferences.validators.js`  | `services/preferences.service.js`                                             | `controllers/preferences.controller.js`  |
| Contact reveal (gate)    | `routes/student.js`, `routes/pgOwner.js`     | —                                       | `services/student.service.js`, `services/pgOwner.service.js`                  | `middleware/contactRevealGate.js`        |
| Health                   | `routes/health.js`                           | —                                       | —                                                                             | —                                        |
| Error shapes             | —                                            | —                                       | —                                                                             | `middleware/errorHandler.js`             |
| Cron behaviour           | —                                            | —                                       | `cron/listingExpiry.js`, `cron/expiryWarning.js`, `cron/hardDeleteCleanup.js` | —                                        |
