# Roomies — Phased Build Plan

**Derived from the Project Plan & System Design**
Each phase delivers a working, testable slice of the platform. No phase begins until the previous one is stable. Every level number refers directly to the build order in the main project plan.

---

## How to Read This Document

Each phase has a clear **entry condition** (what must be true before you start), a **goal** (what the platform can do when the phase is done), and a precise list of what gets built. The phases are not arbitrary time-boxes — they are dependency-driven. You cannot meaningfully test Phase 2 without Phase 1 being solid, and you cannot generate the confirmed connections that Phase 4 depends on without Phase 3 being complete.

The rule for moving between phases is simple: every endpoint built in a phase must be manually testable with real HTTP requests before the next phase begins. If something is broken and you move forward anyway, the next phase inherits that brokenness and the problem compounds.

---

## Phase 1 — Foundation & Identity

**Build order levels covered:** 0, 1, 2

**Entry condition:** PostgreSQL running locally with the schema applied from `roomies_db_setup.sql`. Redis running locally. A `.env.local` file present with all required variables. The Zod env validation at startup must pass cleanly before any other work begins.

**Goal:** A person can register as a student or PG owner, log in with email/password or Google OAuth, receive an OTP, and the server correctly identifies who they are on every subsequent request. Institution auto-verification works. PG owner document upload creates a `verification_requests` row. An admin can see the verification queue.

**What gets built:**

The foundation layer (`Level 0`) is everything the rest of the project stands on. This means the Express app with all global middleware wired in the correct order — Helmet, CORS, `express.json()`, Pino HTTP logger, global error handler — and critically, the Zod environment validation that runs at startup before the server binds to a port. The `pg.Pool` singleton (`src/db/client.js`) is created here. The Redis client singleton is created here. The base router is mounted. Nothing domain-specific exists yet — this level is purely infrastructure.

The auth layer (`Level 1`) produces the two middleware functions that every protected route in every future phase will depend on. The `authenticate` middleware reads the JWT from the Authorization header, verifies it, runs `findUserByEmail()` or a user-by-id query from `src/db/utils/auth.js`, and attaches a `req.user` object. The `authorize(role)` middleware reads `req.user` and checks the roles array. These two functions are the gate for everything above Level 1. Beyond middleware, this level also produces: password hashing with bcryptjs on registration, OTP generation stored in Redis with a TTL, the Ethereal Mail transport for OTP emails, the Google OAuth callback that exchanges a Google ID token for a local user record, token refresh, and the CRUD endpoints for reading and updating student and pg_owner profiles.

The institution and verification layer (`Level 2`) adds `src/db/utils/institutions.js` with `findInstitutionByDomain()` — a stable named function because it is called at every single student registration and will never change shape. The registration flow is completed here: domain extraction, institution lookup, conditional auto-verification. The PG owner document upload endpoint is built here, writing rows to `verification_requests`. The admin verification queue endpoint — protected by `authorize('admin')` — is built here, returning pending requests sorted oldest-first using the composite index.

**What you can test when Phase 1 is done:**

You can register a student with a college email and see `is_email_verified` flip to `TRUE` automatically. You can register a student with a non-college email and see it stay `FALSE`. You can register a PG owner, upload a document, and see the `verification_requests` row appear. You can log in and receive a JWT. You can hit a protected endpoint with and without a valid token and see correct 401 responses. You can hit a pg_owner-only endpoint as a student and receive a correct 403.

**Phase 1 is the most important phase to get completely right.** Every single subsequent feature depends on the token, the user shape, and the role system being airtight. A subtle bug here — a missing role check, a token that doesn't expire, a user query that returns the wrong shape — will silently corrupt every feature built on top of it.

---

## Phase 2 — Listings & Search

**Build order levels covered:** 3, 4

**Entry condition:** Phase 1 is stable and tested. A verified PG owner exists in the database. A verified student exists in the database.

**Goal:** A PG owner can create a property and attach listings to it. A student can search for listings by city, rent range, room type, and proximity to a location. Photos upload and get compressed. Compatibility scores appear on search results. A student can save listings.

**What gets built:**

The listings layer (`Level 3`) is the largest single build level in the project. It starts with amenity seeding — inserting the master amenity list into the database so that listings can reference them. Property CRUD comes next, gated behind `authorize('pg_owner')` and a secondary ownership check (a PG owner cannot edit another owner's property). Listing CRUD follows, with the student versus PG owner branching logic: when `property_id` is provided, the listing belongs to a property; when it is `NULL`, the listing is a student room posting.

The search endpoint is the most technically complex piece of this level because it combines two different query types that must be merged. The dynamic parameterised `WHERE` clause handles city, rent range, room type, gender preference, available_from, listing_type, and amenity filters — all of which are optional, meaning the query builder must compose only the clauses for filters that were actually provided. The PostGIS proximity component is a separate call to `findListingsNearPoint(lat, lng, radiusMeters, client)` in `src/db/utils/spatial.js`, which returns a list of listing IDs within the radius using `ST_DWithin`. Those IDs are merged with the filter results to produce the final result set. On top of that, `scoreListingsForUser(userId, listingIds, client)` in `src/db/utils/compatibility.js` appends a compatibility percentage to each listing card by JOINing `listing_preferences` against `user_preferences`. All search parameters are Zod-validated before the first query runs.

Saved listings — the bookmark feature — is a simple toggle on `saved_listings` but it is part of this level because it depends on listings existing.

The media layer (`Level 4`) refactors the photo upload path. Until now, photos are uploaded synchronously — the HTTP request waits while the file is written to disk. Level 4 introduces the `StorageService` interface with two implementations: `LocalDiskAdapter` for development (writes to `/uploads/` and serves via Express static middleware) and `AzureBlobStorageAdapter` for production (writes to Azure Blob Storage). The Sharp compression pipeline moves into the `media-processing-queue` BullMQ worker — the HTTP response returns immediately with a temporary URL, and the compressed WebP version replaces it asynchronously. The `NODE_ENV` environment variable controls which adapter is active.

**What you can test when Phase 2 is done:**

A PG owner can create a property with lat/lng and see the `location` geometry column populated automatically by the trigger. A PG owner can attach a listing to that property. A student can search by city and receive active listings. A student can search with a lat/lng and receive listings sorted by proximity. A student with preferences set receives compatibility scores on listings. A photo uploads and the compressed WebP version appears at the expected URL.

---

## Phase 3 — Interaction Pipeline & Contact

**Build order levels covered:** 5, 6

**Entry condition:** Phase 2 is stable and tested. At least one active listing exists posted by a verified PG owner. At least one verified student exists with preferences set.

**Goal:** A student can express interest in a listing. A PG owner can accept or decline. On acceptance, a connection is created and the student receives the poster's WhatsApp deep-link. Both parties can confirm the interaction happened. The notification feed works. This is the phase where the core value proposition of the platform — connecting a student to a PG owner — becomes live end to end.

**What gets built:**

The interest and connections layer (`Level 5`) is the most transaction-heavy level in the project. Every state transition in the interest request state machine touches multiple tables and must be atomic. When a student sends an interest request, the service first runs a duplicate check query, then inserts the `interest_requests` row and a `notifications` row for the poster inside a single `BEGIN / COMMIT` block. When a PG owner accepts, the status update on `interest_requests` and the creation of the `connections` row happen together in one transaction — if either fails, both roll back. When the transaction commits, the notification for the sender is dispatched via the `notification-queue`, and the response to the PG owner includes the student's contact information. Symmetrically, when a student's request is accepted, the PG owner's WhatsApp number is returned in the response as a formatted `wa.me` deep-link.

The two-sided confirmation flow is implemented here: either party can flip their own confirmed flag, and after each flip the service checks whether both are now `TRUE`. If they are, `confirmation_status` is updated to `confirmed` in the same transaction as the flag flip. This transition is also the point after which ratings become possible — which is why it is in Phase 3 even though ratings themselves are in Phase 4.

The withdrawal and decline flows are simpler state transitions but still need their own Zod validation and their own notification dispatch.

The notifications layer (`Level 6`) adds the HTTP endpoints for reading notifications: the unread count endpoint (used on every page load to populate the bell badge), the full notification feed endpoint (paginated, includes read and unread), and the mark-as-read endpoint. The `notification-queue` BullMQ worker is wired here — it consumes jobs dispatched from Level 5 and inserts the notification rows. The reason notifications are at Level 6 rather than embedded in Level 5 is separation of concerns: Level 5 produces the events, Level 6 consumes and exposes them. The notification feed uses the partial index on `(recipient_id, created_at DESC) WHERE is_read = FALSE` directly.

**What you can test when Phase 3 is done:**

A student can send an interest request and the PG owner receives a notification. The PG owner can accept and a `connections` row appears with `confirmation_status = pending`. The student's response contains the WhatsApp deep-link. Both parties can flip their confirmed flags independently. When both flags are `TRUE`, `confirmation_status` becomes `confirmed`. A student can decline or withdraw and the correct status transition happens. The notification bell shows the correct unread count. The full notification feed returns notifications in the correct order.

---

## Phase 4 — Reputation System

**Build order levels covered:** 7

**Entry condition:** Phase 3 is stable and tested. At least one `connections` row with `confirmation_status = confirmed` exists in the database. This is non-negotiable — the entire rating system depends on confirmed connections existing. If you try to build Phase 4 without Phase 3 complete, you have nothing to test against.

**Goal:** A participant in a confirmed connection can rate the other party or the property. The rating appears on the reviewee's public profile. The cached average updates automatically via the trigger. Ratings can be reported. Admins can moderate reports. Hidden ratings drop out of the average automatically.

**What gets built:**

The ratings layer (`Level 7`) starts with the eligibility check — a query that confirms the submitting user is either `initiator_id` or `counterpart_id` in the referenced connection and that `confirmation_status = confirmed`. This check runs in the service layer before the `INSERT`. The polymorphic reviewee validation also runs here: if `reviewee_type = 'user'`, the service verifies `reviewee_id` exists in `users`; if `reviewee_type = 'property'`, it verifies it exists in `properties`. These two checks are the application-level integrity that replaces the FK constraint the database cannot express for polymorphic references.

After both checks pass, the `ratings` row is inserted with the `connection_id` FK. The `update_rating_aggregates` trigger fires automatically — the service writes one row and the database recalculates and updates the cached average on `users` or `properties` with no additional application code. After the `INSERT` commits, the `rating_received` notification is dispatched via `notification-queue`.

The public rating feed endpoint returns all visible ratings for a given user or property, ordered newest-first, filtered by `is_visible = TRUE AND deleted_at IS NULL`. This is what the profile page renders.

The report submission endpoint lets any user flag a visible rating with a reason. The partial unique index on `(reporter_id, rating_id) WHERE status = 'open'` prevents duplicate open reports. The admin moderation endpoints — protected by `authorize('admin')` — allow resolving reports as `resolved_removed` or `resolved_kept`. When `resolved_removed` is set, the service runs `UPDATE ratings SET is_visible = FALSE`, which fires `update_rating_aggregates` and removes the rating from the cached average automatically.

**What you can test when Phase 4 is done:**

A participant in a confirmed connection can submit a rating. A non-participant cannot. A rating without a confirmed connection is rejected. The `average_rating` on the reviewee's `users` or `properties` row updates immediately after the INSERT. The public profile shows the rating. A second rating for the same (reviewer, connection, reviewee) triple is rejected by the partial unique index. A user can report a rating. An admin can resolve it as removed and the average drops. An admin can resolve it as kept and the rating stays.

---

## Phase 5 — Operations & Admin

**Build order levels covered:** 8, 9

**Entry condition:** Phase 4 is stable and tested. The full trust pipeline — from registration through confirmed connection through rating — works end to end.

**Goal:** The platform maintains itself without manual intervention. Expired listings are cleaned up automatically. Stale connections expire. Old soft-deleted rows are permanently removed. The admin panel provides full operational control over users, verifications, and content moderation.

**What gets built:**

The background jobs layer (`Level 8`) introduces `node-cron` scheduled tasks and the remaining BullMQ queue workers. The listing expiry cron runs daily at 02:00 — it finds all `active` listings where `expires_at < NOW()` and bulk-updates their `status` to `expired`, then dispatches `listing_expiring` notifications via `notification-queue` for any listings expiring within the next 3 days. The connection expiry cron runs daily at 03:00 — it finds `pending` connections older than 30 days and transitions them to `expired`. The hard-delete cleanup cron runs weekly on Sunday at 04:00 — it permanently removes rows where `deleted_at < NOW() - 90 days` from every soft-delete table. The `email-queue` BullMQ worker is wired here, consuming jobs dispatched from registration and OTP flows since Level 1.

The reason background jobs come this late in the build order is not that they are unimportant — it is that they depend on the data they operate on existing and being stable. Running a listing expiry job before listings exist, or a connection expiry job before connections exist, would produce jobs that have nothing to do and would never surface real failures.

The admin panel (`Level 9`) adds the admin-only Express router mounted at `/api/v1/admin`, protected by `authorize('admin')` on every single route. The routes here bypass soft-delete filters and visibility constraints so admins can see the full picture. The verification queue management endpoints allow admins to list pending verifications and approve or reject them. The user management endpoints allow suspending, banning, and reactivating accounts. The rating moderation endpoints are the admin-facing side of what was built in Phase 4 — listing open reports and resolving them. The platform analytics endpoints provide aggregate counts: total users by role, listings by status and city, connections by type, ratings submitted in the last 30 days. These are straightforward aggregate queries but they depend on all four zones having live data, which is why they come last.

**What you can test when Phase 5 is done:**

Listing rows with a past `expires_at` are updated to `expired` status. `pending` connections older than 30 days transition to `expired`. Rows with `deleted_at` older than 90 days are permanently removed. An admin can approve a PG owner's verification documents and see `verification_status` flip to `verified`. An admin can suspend a user account. An admin can view all open rating reports. Platform analytics return non-zero counts.

---

## Phase 6 — Real-Time (Future Phase)

**Build order levels covered:** 10

**Entry condition:** Phase 3 (notifications) is stable and the polling-based notification delivery is confirmed working. This phase is explicitly deferred until the core platform is live and being used — there is no value in building WebSocket infrastructure before there are real users generating real events to push.

**Goal:** Replace polling-based notification delivery with push delivery over persistent WebSocket connections. The notification database schema does not change. The only additions are the WebSocket server layer and the notification service emitting to connected clients alongside inserting rows.

**What gets built:**

The `ws` WebSocket server is attached to the same HTTP server instance as Express, so it runs on the same port. On connection, the server reads the JWT from the query parameter (`?token=...`), verifies it, looks up the user, and rejects the connection if the token is invalid or expired. On successful handshake, the connection is tracked in a `Map` keyed by `user_id`. When a notification is created — anywhere in the codebase, from any service — the `NotificationService` checks whether the recipient has an active WebSocket connection in the map and if so pushes the notification payload directly to that socket. The polling endpoints from Phase 3 remain in place as fallback for clients whose connection drops.

The `@socket.io/redis-adapter` equivalent for `ws` — a Redis pub/sub layer for broadcasting across multiple server instances on Azure App Service — is also implemented here. This ensures a notification emitted by a request handled on Instance A reaches a client connected to Instance B.

**What you can test when Phase 6 is done:**

Open two browser tabs logged in as different users. Trigger an interest request from one. The notification appears on the other in real time without a page reload. Kill and restart the WebSocket connection — polling picks up any notifications delivered during the gap. Deploy two instances and verify cross-instance delivery works via Redis pub/sub.

---

## Phase Summary

| Phase | Levels | What Becomes Possible | Hard Dependency |
|-------|--------|----------------------|-----------------|
| 1 — Foundation & Identity | 0, 1, 2 | Register, log in, verify, upload documents | Schema applied, `.env.local` valid |
| 2 — Listings & Search | 3, 4 | Post listings, search by filters + proximity, photos, compatibility scores | Phase 1 stable |
| 3 — Interaction Pipeline | 5, 6 | Send interest, accept/decline, WhatsApp contact, confirm interactions, notification feed | Phase 2 stable + active listing exists |
| 4 — Reputation System | 7 | Rate users and properties, report ratings, admin moderation, cached averages | Phase 3 stable + confirmed connection exists |
| 5 — Operations & Admin | 8, 9 | Auto-expiry, cleanup cron, full admin control panel, analytics | Phase 4 stable |
| 6 — Real-Time (Future) | 10 | Push notifications via WebSocket, replaces polling | Phase 3 polling confirmed working, real users exist |

---

*— End of Phased Build Plan —*