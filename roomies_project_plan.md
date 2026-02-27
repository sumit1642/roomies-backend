# Roomies — Project Plan & System Design

**Student Roommate & PG Discovery Platform — India**

---

## Quick Reference

| Item | Detail |
|------|--------|
| Database | `roomies_db` — PostgreSQL 16 + PostGIS |
| Backend | Node.js + Express.js + `pg` (node-postgres) + BullMQ + ws (future) |
| Language | JavaScript (ES2022+) — no TypeScript |
| Cloud | Microsoft Azure (Production) |
| Dev Environment | Local PostgreSQL + Redis — no Docker |
| Environments | `.env.local` (local dev) · `.env.azure` (Azure connectivity check) |
| Auth | JWT + bcryptjs + Google OAuth via `google-auth-library` |
| Validation | Zod — request bodies, query params, route params, env vars at startup |
| Realtime | `ws` (WebSocket) — future phase after verification |
| Jobs | BullMQ queues backed by Redis (`redis` npm package) |
| Cache | Redis (`redis` npm package — official client) |

> **On the database access strategy:** There is no ORM in this project. All database queries are written as raw parameterised SQL using the `pg` (node-postgres) driver. Queries that are stable and called from more than one place are wrapped in named functions inside `src/db/utils/` — one file per concern. Queries that are one-off or still evolving live inline in their service file, clearly written and commented. The SQL schema file is the single source of truth for everything the database looks like.

> **On Zod's role:** Zod operates at two distinct points. At the HTTP boundary it validates every incoming request before any query logic runs. At server startup it validates all environment variables — if anything is missing or wrong-typed, the server refuses to start rather than failing silently later. Together with the database constraints already baked into the schema, Zod creates a two-layer defence that covers what an ORM would have provided.

> **On Real-Time / WhatsApp:** The `ws` WebSocket package is in the stack but will be implemented in a future phase. During the current verified-user phase, the contact flow works by displaying the poster's WhatsApp number as a clickable `wa.me` deep-link once a student's interest request is accepted — no custom socket infrastructure needed yet.

---

## 1 — Product Synopsis

### What Roomies Solves

Roomies is a trust-first platform built for Indian college students seeking paying-guest accommodation and compatible roommates near their institutions. The platform does not simply list rooms — dozens of apps already do that. Its core differentiation is a verified reputation system that cannot be gamed, built on the principle that trust must be earned through confirmed real-world interactions rather than self-reported claims.

The platform serves three distinct personas whose interactions are deeply interconnected across every feature.

| Persona | Registration Path | Primary Actions |
|---------|-------------------|-----------------|
| Student | College email → auto-verified via `institutions.email_domain` match | Search listings, send interest requests, confirm connections, earn and give ratings |
| PG Owner | Manual registration → document upload → admin review → verified | Create Property + Listings, manage interest requests, confirm stays, earn ratings |
| Admin | Seeded directly into DB with admin role | Review PG owner documents, moderate flagged ratings, manage user accounts |

### The Central Design Principle

Every major architectural decision in the schema and backend traces back to a single idea: trust must be earned, not claimed. A student cannot rate a PG owner simply by saying they stayed there. The system requires a two-sided confirmation of the real-world interaction, recorded as a `connections` row with `confirmation_status = confirmed`, before any rating `INSERT` is accepted. This constraint lives at the database level as a `NOT NULL` foreign key on `ratings.connection_id`, meaning it is physically impossible to submit a fake review regardless of application bugs or API manipulation. The database engine itself rejects the `INSERT` — this is not a soft rule that can be bypassed.

### The Two-Layer Defence Strategy

Because there is no ORM managing data shape, two explicit layers work together to keep data correct and safe.

The first layer is **Zod at the HTTP boundary**. Every incoming request — its body, its query parameters, its route parameters — is validated against a Zod schema before a single line of service logic runs. If `rent_per_month` arrives as a string, or a `room_type` value is not one of the allowed enum values, Zod rejects it immediately with a structured error and the query never executes. Zod also validates all environment variables at startup — a misconfigured deployment fails loudly at boot time rather than quietly at the first database call.

The second layer is **the database schema itself**. The SQL file enforces `NOT NULL` constraints, foreign keys, `CHECK` constraints on score ranges, partial unique indexes, and trigger functions. These constraints are not redundant with Zod — they are the final enforcement line that catches anything the application layer might have missed. Together, Zod at the entry point and PostgreSQL at the storage point give the same protection that a well-configured ORM would provide, without any abstraction layer in between.

### WhatsApp Contact Flow (Current Phase)

During the current phase, real-time messaging infrastructure is not yet built. Once a student's interest request is accepted by a PG owner, the application exposes the poster's WhatsApp number as a `wa.me/91XXXXXXXXXX` deep-link. The student taps the link and goes directly to WhatsApp. This is intentional — it is how the majority of Indian PG discovery currently works, it ships in Phase 1 with zero external API dependency, and it gets replaced by in-app messaging in the future `ws` phase.

### Environment Strategy

The project runs with two environment files that serve distinct purposes. `.env.local` contains all local development configuration: PostgreSQL on the host machine, a local Redis instance, Ethereal Mail for fake SMTP, and local disk for file storage. `.env.azure` is a connectivity verification file — it points to Azure Database for PostgreSQL Flexible Server, Azure Cache for Redis, Azure Blob Storage, and Azure Communication Services. Switching from local to cloud is purely a matter of which `.env` file is active, with zero code changes. Both files are validated by Zod at startup, so a missing variable in either environment fails immediately.

---

## 2 — Database Architecture: Four Zones

The schema is organised into four conceptual zones, each answering a distinct business question. The zones have a strict dependency order — no zone can exist without the zones that precede it, and data flows both downward (creation) and upward (denormalized caches updated by triggers).

| Zone | Business Question | Tables |
|------|-------------------|--------|
| Zone 1 — Identity | Who is this person and how much do we trust them? | `institutions`, `users`, `user_roles`, `student_profiles`, `pg_owner_profiles`, `user_preferences`, `verification_requests` |
| Zone 2 — Listings | What is being offered, by whom, and where? | `amenities`, `properties`, `property_amenities`, `listings`, `listing_photos`, `listing_preferences`, `listing_amenities`, `saved_listings` |
| Zone 3 — Interaction | How do two strangers reach a confirmed real-world meeting? | `interest_requests`, `connections`, `notifications` |
| Zone 4 — Reputation | What do people think of each other and the places they stayed? | `ratings`, `rating_reports` |

### Zone 1 — Identity Zone

The root of the entire schema. Every foreign key in every other zone ultimately traces back to the `users` table. The zone is structured around a deliberate split: `users` holds only universal credential data (`email`, `password_hash`, `google_id`, `account_status`), while role-specific data lives in separate profile tables. This avoids the antipattern of a bloated `users` table with dozens of nullable columns that only apply to one user type.

**`institutions`** is a master directory of Indian colleges and universities. The `email_domain` column (e.g., `iitb.ac.in`) is the auto-verification mechanism for student registration. When a student registers with a college email, the app extracts the domain and calls `findInstitutionByDomain()` — a named query function in `src/db/utils/institutions.js`. A match marks `is_email_verified = TRUE` and links `institution_id` on `student_profiles` without any manual admin review. A partial unique index on `email_domain WHERE deleted_at IS NULL` allows domain reuse after soft-deletion.

**`users`** is the universal identity record. Every person has exactly one row here. Two denormalized columns, `average_rating` and `rating_count`, are cached here and kept in sync by the `update_rating_aggregates` trigger in Zone 4. Search results never need a live `AVG()` query against `ratings` — the cached value is always current.

**`user_roles`** is a junction table mapping users to roles. It handles the real edge case where one person is simultaneously a student and a PG owner. Adding a second role is just inserting a second row. The composite primary key `(user_id, role_name)` enforces uniqueness and is automatically indexed.

**`student_profiles` and `pg_owner_profiles`** are role-specific extensions of `users`. A `UNIQUE` constraint on `user_id` in each table enforces the one-to-one relationship at the database level. `student_profiles` holds academic identity including the Aadhaar tokenized reference — never the raw 12-digit number, which would be a UIDAI compliance violation. `pg_owner_profiles` holds business identity and drives the verification state machine: `unverified → pending → verified` or `rejected`.

**`user_preferences`** stores lifestyle preferences using the Entity-Attribute-Value pattern. Keys like `smoking`, `food_habit`, `sleep_schedule` with values like `non_smoker`, `vegetarian`, `night_owl`. EAV means adding a new preference type is an `INSERT`, not an `ALTER TABLE`. This table is the left side of the compatibility scoring JOIN.

**`verification_requests`** is the document submission and admin review audit trail for PG owners. Kept as a separate table so the full history of every submission and every admin decision is always preserved. The composite index on `(status, submitted_at)` powers the admin queue sorted oldest-first.

### Zone 2 — Listings Zone

The core product zone. Its most important design decision is that both student room postings and PG owner room postings live in the same `listings` table, distinguished by a single nullable column: `property_id`. When `property_id IS NULL` it is a student listing. When it carries a UUID it is a room under a PG owner's property. This avoids duplicating a near-identical table structure for two similar content types.

**`properties`** is the physical building record, created only by PG owners. The GiST spatial index on the `location` geometry column enables `ST_DWithin` proximity queries. The `location` geometry is never written by application code — the `sync_location_geometry` trigger computes it automatically from `latitude` and `longitude` on every insert or update. Properties also carry a denormalized `average_rating` kept current by Zone 4's trigger.

**`listings`** is the most-queried table in the schema. Rent is stored in paise as an `INTEGER` to eliminate floating-point bugs. The `chk_occupancy` constraint ensures `current_occupants` never exceeds `total_capacity` at the database level. Student listings populate their own address and location; PG listings inherit location from the parent property row.

**`listing_preferences` and `user_preferences` — the compatibility engine.** These two tables mirror each other intentionally. `listing_preferences` stores what the poster wants; `user_preferences` stores what the user is like. The compatibility score is computed by a JOIN on `(preference_key, preference_value)` counting matching rows, called via `scoreListingsForUser()` in `src/db/utils/compatibility.js`. The score is never stored — it is always computed fresh from current preferences.

**`listing_photos`** stores multiple photos per listing. A partial unique index `WHERE is_cover = TRUE AND deleted_at IS NULL` enforces at most one cover photo per listing — a constraint that a standard `UNIQUE` clause cannot express.

### Zone 3 — Interaction Zone

The pipeline that converts two strangers into a pair with a proven real-world history. Three sequential stages: intent (`interest_requests`), proof (`connections`), and awareness (`notifications`).

**`interest_requests`** is created when a student taps "I'm interested." The status state machine has four states: `pending`, `accepted`, `declined`, `withdrawn`. A partial unique index on `(sender_id, listing_id) WHERE status IN ('pending', 'accepted')` prevents duplicate concurrent requests while still allowing re-application after a decline or withdrawal.

**`connections` — the trust anchor.** A connection row is only created after an interest request is accepted. Its `confirmation_status` only reaches `confirmed` after BOTH `initiator_confirmed` and `counterpart_confirmed` are independently set to `TRUE` by each party. The `connection_type` (`student_roommate`, `pg_stay`, `hostel_stay`, `visit_only`) determines which rating dimensions are meaningful when Zone 4 ratings are submitted.

**`notifications`** is the in-app event feed using a polymorphic reference pattern: `entity_type` (string like `'listing'`, `'connection'`, `'interest_request'`) plus `entity_id` (UUID). The notification bell query hits a partial index on `(recipient_id, created_at DESC) WHERE is_read = FALSE` — kept small so it is fast on every page load.

### Zone 4 — Reputation Zone

The endpoint of the trust pipeline. Zones 1 through 3 proved real interactions happened. Zone 4 converts those proven interactions into scores future users rely on.

**`ratings`** — each row is one party's review of a user or property, anchored to a confirmed connection. The `NOT NULL` FK on `connection_id` is the anti-fake-review guarantee. The reviewee is identified by a polymorphic `(reviewee_type, reviewee_id)` pair — since a standard FK cannot reference two tables, the service layer validates that `reviewee_id` exists in the correct table before any `INSERT` runs. Dimension scores are nullable since not every dimension applies to every `connection_type`. `is_visible` allows admin moderation without deleting the row.

**`update_rating_aggregates` trigger** fires `AFTER INSERT OR UPDATE OF overall_score, is_visible` on `ratings`. It recalculates `AVG` and `COUNT` for the affected reviewee and writes back to `users` or `properties`. The application inserts the rating — the database handles the cache update automatically, no application code needed.

**`rating_reports`** is the moderation queue. `resolved_removed` hides the rating via `is_visible = FALSE`, which fires the trigger and removes it from the average. `resolved_kept` closes the report with the rating intact. Both outcomes are preserved for future automated flagging analysis.

---

## 3 — Database Access Strategy

### Why Raw SQL with `pg`

There is no ORM in this project. The `pg` (node-postgres) package is the direct driver — it maintains a connection pool, sends parameterised SQL to PostgreSQL, and returns results as plain JavaScript objects. This decision is coherent with the project philosophy: the schema was designed carefully and is the source of truth, so application code speaks to it directly rather than through a translation layer.

The triggers already handle the most repetitive write-side work (`set_updated_at`, `sync_location_geometry`, `update_rating_aggregates`), and the most complex read-side queries (PostGIS proximity, compatibility scoring) would have required raw SQL even with an ORM. Going fully raw eliminates the split-brain problem of deciding which tool to reach for on any given query.

### Query Organisation — `src/db/`

All database interaction lives under `src/db/`. The `client.js` file holds the single shared `pg.Pool` instance — created once, exported, imported everywhere, never recreated. The `utils/` subfolder holds named query functions organised by domain concern.

```
src/
  db/
    client.js             ← single pg.Pool instance, exported and shared everywhere
    utils/
      spatial.js          ← PostGIS queries: findListingsNearPoint, findPropertiesNearPoint
      compatibility.js    ← preference JOIN scoring: scoreListingsForUser
      auth.js             ← findUserByEmail, findUserByGoogleId (called from multiple services)
      institutions.js     ← findInstitutionByDomain (stable, called at every registration)
```

The wrapping rule is deliberate and narrow. A query earns a named function when it is called from more than one place, its inputs and outputs are stable and well-defined, and getting it wrong anywhere would cause a real problem. One-off queries, evolving search filters, fetches used in only one place — those live inline in their service file, clearly written and commented. The named function is a contract; inline SQL is working code. Both are valid, and both are explicit.

### Transaction Handling

When a sequence of queries must succeed or fail as a unit — accepting an interest request and creating a connection row being the clearest example — they run inside an explicit `BEGIN / COMMIT / ROLLBACK` block using the same `pg.PoolClient` checked out for that operation. Any query function that might participate in a transaction accepts an optional `client` parameter defaulting to the shared pool but accepting a checked-out client when passed one. This keeps individual query functions usable both standalone and inside transactions without any special internal wiring.

### Where Zod Fits

Zod operates at two points. At the HTTP boundary, every route's incoming data is validated against a Zod schema in the middleware layer before the request reaches the service or any SQL string is constructed. This catches type mismatches, missing required fields, out-of-range values, and invalid enum values early. At server startup, the full environment configuration is validated against a Zod schema — if `DATABASE_URL` is missing or `PORT` is not a number, the process exits immediately with a clear error.

Zod is not a replacement for database constraints — it is the first line of defence ensuring only well-shaped, well-typed data reaches the query layer. The database constraints are the second line, enforcing correctness at the storage level regardless of how the data arrived.

---

## 4 — Feature Interconnections

Every feature on Roomies is part of a chain. No feature operates in isolation — each one either unlocks the next or feeds data back into earlier zones.

### 4.1 — Registration & Institution Verification

Zod validates the registration body first — confirming email is a well-formed address before anything touches the database. The app extracts the domain and calls `findInstitutionByDomain()`. A match triggers automatic verification: `is_email_verified = TRUE`, `institution_id` written to `student_profiles`, student role inserted into `user_roles`. Google OAuth registrations follow the same branching logic at the callback — the domain is extracted from the Google-verified email.

### 4.2 — PG Owner Verification Flow

After registration, `verification_status` on `pg_owner_profiles` starts at `unverified`. Document uploads create rows in `verification_requests` with `status = pending`. An admin reviews and resolves to `verified` or `rejected`, which the app mirrors back to `pg_owner_profiles.verification_status`. Only `verified` owners can create properties and attach listings. The admin review queue is powered by the composite index on `(status, submitted_at)`.

### 4.3 — Listing Search and Compatibility Scoring

Zod validates all search query parameters — city, rent range, room type, gender preference, available_from — before the SQL string is assembled. The PostGIS proximity component calls `findListingsNearPoint(lat, lng, radiusMeters, client)` from `src/db/utils/spatial.js`, returning listing IDs. A second parameterised query fetches the full listing rows and their photos for those IDs. Compatibility scoring calls `scoreListingsForUser(userId, listingIds, client)` from `src/db/utils/compatibility.js`, which JOINs `listing_preferences` against `user_preferences` and counts matching rows per listing. The score is computed per request and never stored — it always reflects the user's current preferences.

### 4.4 — Interest Request State Machine

Zod validates the request body. The service checks for an existing active request from this sender to this listing — a defensive read before the write, since the partial unique index will also reject duplicates at the DB level. On submission, the `interest_requests` row and a notification row are inserted in the same transaction. When the poster accepts, the status update and the `connections` row creation happen inside a single `BEGIN / COMMIT` block — atomicity here is non-negotiable. After the transaction commits, a notification of type `interest_request_accepted` is dispatched, and the student's UI receives the poster's WhatsApp deep-link.

### 4.5 — Connection Confirmation Flow

Both `initiator_confirmed` and `counterpart_confirmed` start as `FALSE`. Either party flips their own flag. After each flip, the service checks whether both are now `TRUE` — if so, it updates `confirmation_status = confirmed` in the same transaction as the flag update. Once confirmed, both parties can submit ratings referencing this `connection_id`, and the connection appears in their public interaction history.

### 4.6 — Rating Submission and Aggregate Update

Zod validates the rating body including score ranges. The service runs an eligibility check query: is the reviewer a participant in the referenced connection and is `confirmation_status = confirmed`? Then it validates that `reviewee_id` exists in the correct table — the polymorphic integrity check the DB cannot enforce with a FK. If both pass, the `ratings` row is inserted. The `update_rating_aggregates` trigger fires automatically — the application writes one row and the database handles the cache update with no additional application code involved.

### 4.7 — Notification System

Every state transition creates a notification row inserted via a direct parameterised query. In the current phase, delivery is polling-based: the client fetches unread count on page load via the partial index on `(recipient_id, created_at DESC) WHERE is_read = FALSE`, and fetches the full feed on the notifications page. The future `ws` phase adds push delivery on top of this same notification row infrastructure — no schema changes are needed when that phase begins.

### 4.8 — Rating Moderation Flow

A report is submitted via a Zod-validated request. The partial unique index prevents duplicate open reports from the same reporter against the same rating. When an admin resolves as `resolved_removed`, the service runs `UPDATE ratings SET is_visible = FALSE`, which fires `update_rating_aggregates` automatically — removing the hidden rating from the cached average with no additional application code.

---

## 5 — Cross-Zone Data Flows

### Downward Flow — Creation Dependencies

Zone 1 must exist before Zone 2 can have an `owner_id` or `posted_by`. Zone 2 must exist before Zone 3 can have a `listing_id` on `interest_requests` or `connections`. Zone 3 must have a confirmed connection before Zone 4 can accept a rating `INSERT`. The backend build order follows this zone sequence exactly.

### Upward Flow — Trigger-Driven Cache Updates

Zone 4 writes back to Zones 1 and 2 via the `update_rating_aggregates` trigger. Search queries on listings never need to JOIN to `ratings` or run `AVG()` live.

| From | To | Mechanism | What Triggers It |
|------|----|-----------|-----------------|
| `ratings` (Zone 4) | `users` (Zone 1) | `update_rating_aggregates` DB trigger | `overall_score` or `is_visible` change |
| `ratings` (Zone 4) | `properties` (Zone 2) | `update_rating_aggregates` DB trigger | `overall_score` or `is_visible` change |
| `interest_requests` (Zone 3) | `connections` (Zone 3) | App query inside explicit transaction | `status = accepted` |
| `connections` (Zone 3) | `notifications` (Zone 3) | App query after transaction commits | `confirmation_status` change |
| `ratings` (Zone 4) | `notifications` (Zone 3) | App query after rating INSERT | Rating INSERT |

### The Complete End-to-End Trust Flow

| Step | Action | System Behaviour |
|------|--------|-----------------|
| 1 | Student registers | Zod validates body. `findInstitutionByDomain()` called. Three rows inserted: `users`, `student_profiles`, `user_roles` |
| 2 | Student browses listings | Zod validates query params. `findListingsNearPoint()` for proximity IDs. Second query fetches full rows. `scoreListingsForUser()` appends compatibility percentages |
| 3 | Student sends interest | Zod validates body. Duplicate check runs. `interest_requests` row + notification row inserted in one transaction |
| 4 | PG owner accepts | Transaction: `interest_requests` status updated + `connections` row created. Post-commit: notification inserted. WhatsApp deep-link returned in response |
| 5 | Both parties confirm | Each flip: flag updated + both-confirmed check. If both TRUE: `confirmation_status = confirmed` in same transaction. Notification dispatched |
| 6 | Student submits rating | Zod validates body. Eligibility check + polymorphic reviewee check. `ratings` row inserted. DB trigger fires — cache updated automatically |
| 7 | Trigger fires | `update_rating_aggregates` writes new `average_rating` and `rating_count` to `properties`. App dispatches `rating_received` notification |
| 8 | Rating appears in search | Next search reads `properties.average_rating` from cached column directly — no live `AVG()` needed |

---

## 6 — Background Jobs & Scheduled Tasks

### BullMQ Queues

BullMQ is configured with the official `redis` npm package via a custom connection factory. Each queue has its own concurrency settings and retry policy, all visible in the Bull Board dashboard at `/admin/queues` in development.

| Queue | Triggered By | What It Does | Concurrency |
|-------|-------------|--------------|-------------|
| `email-queue` | Registration, OTP, listing alerts | Sends emails via Nodemailer (Ethereal in dev, Azure Communication Services in prod) | 5 workers |
| `notification-queue` | Every Zone 3 state transition | Inserts notification row. Decoupled from the main transaction so a notification failure never rolls back a state change | 10 workers |
| `media-processing-queue` | Photo upload endpoint | Sharp compression pipeline: resize to 1200px max, convert to WebP, quality 80 | 1 worker (CPU-bound) |
| `listing-expiry-queue` | Cron trigger (daily) | Bulk-updates listings where `expires_at < NOW()` and `status = active` to `status = expired` | 2 workers |

### node-cron Scheduled Tasks

| Schedule | Task | Tables Affected |
|----------|------|-----------------|
| Daily 02:00 | Listing expiry — bulk-update past-expiry active listings to `expired`, dispatch notifications | `listings`, `notifications` |
| Daily 03:00 | Connection expiry — find pending connections older than 30 days, transition to `expired` | `connections` |
| Daily 01:00 | Expiry warning — find active listings where `expires_at` within 3 days, send `listing_expiring` notification | `listings`, `notifications` |
| Weekly Sunday 04:00 | Hard-delete cleanup — permanently remove rows where `deleted_at < NOW() - 90 days` | All tables with `deleted_at` |

---

## 7 — Tech Stack Reference

| Category | Package / Service | Role |
|----------|-------------------|------|
| Runtime | Node.js + Express.js | HTTP server, routing, middleware pipeline |
| Database Driver | `pg` (node-postgres) | Direct PostgreSQL connection pool. All queries are raw parameterised SQL |
| Validation | Zod | HTTP boundary validation (body, query, params) + env var validation at startup |
| Auth | `jsonwebtoken` + `bcryptjs` + `google-auth-library` | JWT issuance/verification, password hashing, Google OAuth ID token verification |
| Cache | `redis` (official v4+ npm package) | Redis client for rate limiting, OTP TTL storage, general caching |
| Queue | BullMQ | Job queue using `redis` client via custom connection factory |
| Queue Dashboard | `@bull-board/express` | Visual queue inspector at `/admin/queues` (dev only) |
| Real-Time | `ws` | Native WebSocket — future phase |
| Contact (Current) | WhatsApp `wa.me` deep-link | Shown to student after interest request accepted. Zero infrastructure cost |
| File Uploads | `multer` + `sharp` | Multipart parsing + WebP compression pipeline |
| Email (Dev) | `nodemailer` + Ethereal Mail | Fake SMTP — no real emails sent, preview URL logged to console |
| Email (Prod) | Azure Communication Services SDK | Real email delivery in Azure environment |
| Scheduling | `node-cron` | Time-triggered tasks within the main Express process |
| Logging | `pino` + `pino-http` + `pino-pretty` | Structured async JSON logging. `pino-pretty` for human-readable dev output |
| Security | `helmet` + `cors` + `express-rate-limit` + `rate-limit-redis` | Security headers, CORS, Redis-backed per-route rate limiting |
| API Docs | `swagger-jsdoc` + `swagger-ui-express` | Auto-generated OpenAPI docs at `/api/docs` |
| Testing | Jest + Supertest | Unit and integration testing |
| Dev Tooling | `nodemon` + `concurrently` | Hot reload + parallel process runner |
| DB (Local) | PostgreSQL 16 + PostGIS (host-installed) | Direct host installation, no Docker |
| DB (Prod) | Azure Database for PostgreSQL Flexible Server | Managed PostgreSQL with native PostGIS support |
| Cache (Local) | Redis (host-installed) | Direct host installation, no Docker |
| Cache (Prod) | Azure Cache for Redis | Managed Redis |
| Storage (Local) | Local disk (`/uploads` folder) | `StorageService` `LocalDiskAdapter` |
| Storage (Prod) | Azure Blob Storage | `StorageService` `AzureBlobAdapter` — same interface, swapped by `NODE_ENV` |

---

## 8 — Backend Build Order

The build order is a directed dependency graph. Each level cannot be meaningfully tested until all levels above it are stable. The `src/db/client.js` pool singleton and all `src/db/utils/` query functions are built as part of their relevant level — they are part of the feature, not infrastructure added on top of it.

| Level | Zone | Produces | Blocked By |
|-------|------|----------|------------|
| 0 | Foundation | Express app, `pg` pool singleton (`src/db/client.js`), Redis client singleton, Pino logger, Zod env validation at startup, global error handler, CORS, Helmet, base router | — |
| 1 | Auth + Identity | `authenticate` JWT middleware, `authorize(role)` middleware, `req.user` shape, bcryptjs hashing, OTP via Redis TTL, Ethereal email transport, Google OAuth callback, token refresh, student + pg_owner profile CRUD, `src/db/utils/auth.js` | Level 0 |
| 2 | Institution + Verification | `src/db/utils/institutions.js`, institution domain lookup at registration, PG owner document upload, admin verification queue endpoints | Level 1 |
| 3 | Listings | Amenity seeding queries, property CRUD (pg_owner-gated), listing CRUD, listing photos, search with dynamic parameterised SQL + `src/db/utils/spatial.js` + `src/db/utils/compatibility.js`, saved listings | Level 2 |
| 4 | Media | `StorageService` interface (`LocalDiskAdapter` + `AzureBlobAdapter`), Multer config centralised, Sharp compression in `media-processing-queue` | Level 3 |
| 5 | Interest + Connections | Interest request state machine (all transitions in explicit `BEGIN/COMMIT` transactions), connection creation, two-sided confirmation flow, WhatsApp deep-link on accept, notification dispatch post-commit | Level 3 |
| 6 | Notifications | Notification HTTP endpoints (feed, mark-read, unread count), `notification-queue` worker wired | Level 5 |
| 7 | Ratings | Rating submission with eligibility check + polymorphic reviewee check, public rating feed, report submission, `is_visible` moderation — DB trigger handles cache update automatically | Level 5 + 6 |
| 8 | Background Jobs | Listing expiry cron, connection expiry cron, soft-delete cleanup cron, `email-queue` worker | Level 7 |
| 9 | Admin Panel | Admin-only router, verification queue management, user account management, rating moderation, platform analytics | Level 8 |
| 10 | Real-Time (Future) | `ws` WebSocket server, JWT handshake auth, user rooms, push notification delivery replacing polling | Level 6 stable |

---

## 9 — Environment Files

### `.env.local` — Local Development

| Variable | Value / Notes |
|----------|---------------|
| `DATABASE_URL` | `postgresql://postgres:password@localhost:5432/roomies_db` |
| `REDIS_URL` | `redis://localhost:6379` |
| `JWT_SECRET` | Any long random string for local dev |
| `JWT_REFRESH_SECRET` | Different long random string |
| `GOOGLE_CLIENT_ID` | From Google Cloud Console (free) |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud Console |
| `SMTP_HOST` | `smtp.ethereal.email` — fake SMTP, zero cost |
| `STORAGE_ADAPTER` | `local` — uses `LocalDiskStorageAdapter`, writes to `/uploads` |
| `NODE_ENV` | `development` |
| `PORT` | `3000` |

### `.env.azure` — Azure Connectivity Check

This file is used specifically to verify the application can connect to all Azure services before a production deployment. It is never used for day-to-day development.

| Variable | Value / Notes |
|----------|---------------|
| `DATABASE_URL` | Azure PostgreSQL Flexible Server connection string |
| `REDIS_URL` | Azure Cache for Redis connection string (with SSL: `rediss://`) |
| `AZURE_STORAGE_ACCOUNT` | Azure Blob Storage account name |
| `AZURE_STORAGE_KEY` | Azure Blob Storage access key |
| `AZURE_STORAGE_CONTAINER` | Blob container name for uploads |
| `ACS_CONNECTION_STRING` | Azure Communication Services connection string for email |
| `ACS_FROM_EMAIL` | Verified sender email on ACS |
| `STORAGE_ADAPTER` | `azure` — activates `AzureBlobStorageAdapter` |
| `NODE_ENV` | `production` |
| `PORT` | `8080` (Azure App Service default) |

---

*— End of Roomies Project Plan —*