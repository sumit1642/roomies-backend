# Roomies — Project Plan & System Design

**Student Roommate & PG Discovery Platform — India**

---

## Quick Reference

| Item | Detail |
|------|--------|
| Database | `roomies_db` — PostgreSQL 16 + PostGIS |
| Backend | Node.js + Express.js + Prisma ORM + BullMQ + ws (future) |
| Language | JavaScript (ES2022+) — no TypeScript |
| Cloud | Microsoft Azure (Production) |
| Dev Environment | Local PostgreSQL + Redis — no Docker |
| Environments | `.env.local` (local dev) · `.env.azure` (Azure connectivity check) |
| Auth | JWT + bcryptjs + Google OAuth via `google-auth-library` |
| Realtime | `ws` (WebSocket) — future phase after verification |
| Jobs | BullMQ queues backed by Redis (`redis` npm package) |
| Cache | Redis (`redis` npm package — official client) |

> **Note on `redis` vs `ioredis`:** We use the official `redis` npm package (v4+). BullMQ by default expects `ioredis`, so we use the `@bull-board` Redis adapter configured with the official client, or we pass a custom connection factory. This is documented in the BullMQ setup section of the backend implementation.

> **Note on Real-Time / WhatsApp:** The `ws` WebSocket package is in the stack but will be implemented in a future phase. During the current verified-user phase, the contact flow works by displaying the poster's WhatsApp number as a clickable `wa.me` deep-link once a student's interest request is accepted — no custom socket infrastructure needed yet.

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

Every major architectural decision in the schema and backend traces back to a single idea: trust must be earned, not claimed. A student cannot rate a PG owner simply by saying they stayed there. The system requires a two-sided confirmation of the real-world interaction, recorded as a `connections` row with `confirmation_status = confirmed`, before any rating `INSERT` is accepted. This constraint lives at the database level as a `NOT NULL` foreign key on `ratings.connection_id`, meaning it is physically impossible to submit a fake review regardless of application bugs or API manipulation.

This is not a soft rule enforced by application code that can have edge cases. It is a hard structural guarantee — the database engine itself rejects the `INSERT`.

### WhatsApp Contact Flow (Current Phase)

During the current phase, real-time messaging infrastructure (`ws`) is not yet built. Instead, once a student's interest request is accepted by a PG owner, the application exposes the poster's WhatsApp number as a `wa.me/91XXXXXXXXXX` deep-link. The student taps the link and is taken directly to WhatsApp to initiate conversation manually. This is intentional — it is how the majority of Indian PG discovery currently works, it ships in Phase 1 with zero external API dependency, and it gets replaced by in-app messaging in the future `ws` phase.

### Environment Strategy

The project runs with two environment files that serve distinct purposes. The `.env.local` file contains all local development configuration: PostgreSQL running directly on the host machine, a local Redis instance, Ethereal Mail for fake SMTP, and local disk for file storage. The `.env.azure` file is a connectivity verification file for the Azure cloud environment — it points to Azure Database for PostgreSQL Flexible Server, Azure Cache for Redis, Azure Blob Storage, and Azure Communication Services. Switching from local development to cloud is purely a matter of which `.env` file is active, with zero code changes required.

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

The root of the entire schema. Every foreign key in every other zone ultimately traces back to the `users` table. The zone is structured around a deliberate split: the `users` table holds only universal credential data (`email`, `password_hash`, `google_id`, `account_status`), while role-specific data lives in separate profile tables. This avoids the common antipattern of a single bloated `users` table with dozens of nullable columns that only apply to one user type.

**`institutions`** is a master directory of Indian colleges and universities. The `email_domain` column (e.g., `iitb.ac.in`) is the auto-verification mechanism for student registration. When a student registers with a college email, the app extracts the domain, queries this table, and if a match exists, marks `is_email_verified = TRUE` and links `institution_id` on `student_profiles` — all without any manual admin review. A partial unique index on `email_domain WHERE deleted_at IS NULL` allows domain reuse after soft-deletion.

**`users`** is the universal identity record. Every person — student, PG owner, or admin — has exactly one row here. Two denormalized columns, `average_rating` and `rating_count`, are cached here and kept in sync by the `update_rating_aggregates` trigger in Zone 4. This means listing search results never need to run a live `AVG()` query against the `ratings` table — the cached value is always current.

**`user_roles`** is a junction table mapping users to their roles. The design deliberately uses a separate table rather than a single role column on `users` to handle the real edge case where one person is simultaneously a student and a PG owner (a local student whose family owns a PG). Adding a second role is just inserting a second row. The composite primary key `(user_id, role_name)` enforces uniqueness.

**`student_profiles` and `pg_owner_profiles`** are role-specific extensions of `users`. A `UNIQUE` constraint on `user_id` in each table enforces a one-to-one relationship at the database level. `student_profiles` holds academic identity: institution link, course, `year_of_study`, and the Aadhaar tokenized reference (never the raw 12-digit number — storing the actual number is a UIDAI compliance violation). `pg_owner_profiles` holds business identity and drives the verification state machine: `unverified → pending → verified` or `rejected`.

**`user_preferences`** stores lifestyle preferences using the Entity-Attribute-Value pattern with keys like `smoking`, `food_habit`, `sleep_schedule` and values like `non_smoker`, `vegetarian`, `night_owl`. EAV means adding a new preference type requires only an `INSERT`, never an `ALTER TABLE`. This table is the left side of the compatibility scoring JOIN — it gets compared against `listing_preferences` to produce a match percentage for each listing-user pair.

**`verification_requests`** is the document submission and admin review audit trail for PG owners. Kept as a separate table rather than columns on `pg_owner_profiles` so that the full history of every document submission and every admin decision is preserved. The composite index on `(status, submitted_at)` directly powers the admin queue view sorted oldest-first.

### Zone 2 — Listings Zone

The core product zone. Its most important design decision is that both student room postings and PG owner room postings live in the same `listings` table, distinguished by a single nullable column: `property_id`. When `property_id IS NULL`, it is a student listing. When `property_id` carries a UUID, it is a room under a PG owner's property. This avoids duplicating a near-identical table structure for two very similar content types.

**`properties`** is the physical building record, created only by PG owners. Properties hold the building-level address, location geometry (auto-synced via the `sync_location_geometry` trigger), house rules, and a denormalized `average_rating` updated by Zone 4's trigger. The GiST spatial index on the `location` geometry column enables the `ST_DWithin` proximity query that powers "find listings within 3km of my college."

**`listings`** is the most-queried table in the entire schema. Rent is stored in paise (the smallest INR unit) as an `INTEGER` to eliminate floating-point arithmetic bugs entirely. The `chk_occupancy` constraint ensures `current_occupants` can never exceed `total_capacity` at the database level. Student listings populate their own address and location columns; PG listings inherit location from their parent property row. The listing status state machine (`active → filled / expired / deactivated`) is managed by application logic combined with the cron-based expiry job.

**`listing_preferences` and `user_preferences` — the compatibility engine.** These two tables mirror each other intentionally. `listing_preferences` stores what the poster wants in a roommate; `user_preferences` stores what the user is like. The compatibility score for a given (user, listing) pair is computed by a JOIN on `(preference_key, preference_value)` — counting matching rows. Both tables carry composite indexes on `(preference_key, preference_value)` specifically to make this JOIN run index-to-index rather than scanning rows.

**`listing_photos`** stores multiple photos per listing. A partial unique index — `WHERE is_cover = TRUE AND deleted_at IS NULL` — enforces at most one cover photo per listing at the database level, a constraint that cannot be expressed by a standard `UNIQUE` clause.

### Zone 3 — Interaction Zone

The pipeline that converts two strangers into a pair with a proven real-world history. The three tables in this zone represent sequential stages: intent (`interest_requests`), proof (`connections`), and awareness (`notifications`).

**`interest_requests`** is created when a student taps "I'm interested" on a listing. The status state machine has four states: `pending`, `accepted`, `declined`, `withdrawn`. A partial unique index on `(sender_id, listing_id) WHERE status IN ('pending', 'accepted')` prevents a user from spamming the same listing with multiple concurrent requests while still allowing re-application after a decline or withdrawal.

**`connections` — the trust anchor.** This is the most architecturally significant table on the platform. A connection row is only created after an interest request is accepted. Its `confirmation_status` only reaches `confirmed` after BOTH `initiator_confirmed` and `counterpart_confirmed` are independently set to `TRUE` by each party. This two-sided confirmation is what proves the interaction actually happened rather than being self-reported. The `connection_type` (`student_roommate`, `pg_stay`, `hostel_stay`, `visit_only`) determines which rating dimensions are meaningful when Zone 4 ratings are submitted.

**`notifications`** is the in-app event feed. It uses a polymorphic reference pattern: `entity_type` (a string like `'listing'`, `'connection'`, `'interest_request'`) plus `entity_id` (a UUID) rather than multiple nullable foreign key columns. The notification bell query hits a partial index on `(recipient_id, created_at DESC) WHERE is_read = FALSE` — kept intentionally small so it is fast on every page load for every logged-in user.

### Zone 4 — Reputation Zone

The endpoint of the trust pipeline. Zones 1 through 3 built the infrastructure to prove real interactions happened. Zone 4 converts those proven interactions into scores that future users rely on.

**`ratings`** — each row is one party's review of either another user or a property. The `NOT NULL` foreign key on `connection_id` is the anti-fake-review guarantee. The reviewee is identified by a polymorphic `(reviewee_type, reviewee_id)` pair because a single FK column cannot reference two different tables. Dimension scores (`cleanliness`, `communication`, `reliability`, `value`) are nullable because not every dimension applies to every `connection_type` — only `overall_score` is required. The `is_visible` column allows admin moderation without destroying the row: hidden ratings are preserved for audit history but excluded from all user-facing queries.

**`update_rating_aggregates` trigger** fires `AFTER INSERT OR UPDATE OF overall_score, is_visible` on `ratings`. It recalculates the `AVG` and `COUNT` for the affected reviewee and writes the result back to either `users.average_rating` or `properties.average_rating`. Firing only on the two relevant columns avoids unnecessary recalculations when `review_text` or other unrelated columns change. The `COALESCE(v_avg, 0.00)` handles the edge case where the last visible rating is removed and `AVG` returns `NULL`.

**`rating_reports`** is the moderation queue. When a user flags a rating, a row is inserted with `status = open`. Admins resolve it as `resolved_removed` (hides the rating by setting `is_visible = FALSE`) or `resolved_kept` (rating stays). Both outcomes are preserved in the table — the pattern of which report reasons lead to removals informs future automated flagging logic. A partial unique index prevents the same user from filing duplicate open reports against the same rating.

---

## 3 — Feature Interconnections

Every feature on Roomies is part of a chain. No feature operates in isolation — each one either unlocks the next or feeds data back into earlier zones. Understanding these connections is essential for building each zone in the correct order and for reasoning about what breaks when something goes wrong.

### 3.1 — Registration & Institution Verification

The registration flow branches immediately based on the incoming email domain. The app extracts the domain from the submitted email and queries the `institutions` table. A match triggers automatic verification: `is_email_verified` is set `TRUE`, `institution_id` is written to `student_profiles`, and the user receives the `student` role. No match means the user is treated as a PG owner candidate or a general user pending manual verification. Google OAuth registrations follow the same branching logic on callback — the `google_id` is stored on `users` and the domain is extracted from the Google-verified email.

This institution lookup is the first point where Zone 1 data directly shapes the user's journey through every subsequent feature. A verified student can immediately browse and send interest requests; an unverified PG owner cannot create listings until their documents are reviewed.

### 3.2 — PG Owner Verification Flow

After a PG owner registers, their `verification_status` on `pg_owner_profiles` starts at `unverified`. They upload documents (`property_document`, `rental_agreement`, `owner_id`, `trade_license`) which creates rows in `verification_requests` with `status = pending`. An admin reviews the documents in the admin dashboard and sets the status to `verified` or `rejected`. The app mirrors this decision back to `pg_owner_profiles.verification_status`. Only once `verification_status = verified` can the PG owner create properties and attach listings to them.

This creates a hard dependency: PG listing creation is gated behind the verification state machine. The admin review queue — an index on `(status, submitted_at)` sorted oldest-first — ensures the longest-waiting submissions surface first.

### 3.3 — Listing Search and Compatibility Scoring

A search query composes a dynamic `WHERE` clause from optional filter parameters: `city`, rent range, `room_type`, `preferred_gender`, `available_from`, `listing_type`, and amenities. The PostGIS proximity component is a separate raw SQL query using `ST_DWithin` on the `location` geometry column, which returns listing IDs within a radius. Those IDs are then fed into a Prisma `findMany` call to load the full relational shape including photos and property data.

Compatibility scoring runs as a secondary query against the results. For each (listing, user) pair, it JOINs `listing_preferences` against `user_preferences` on `(preference_key, preference_value)` and counts the matching rows. The result is a percentage shown on each listing card. The composite indexes on both preference tables make this JOIN run index-to-index. This score is not stored anywhere — it is computed per-request and remains ephemeral by design, so the score updates whenever a user updates their preferences.

### 3.4 — Interest Request State Machine

When a student sends an interest request, the app first checks for an active (pending or accepted) request from this sender to this listing. The partial unique index rejects duplicates at the DB level if the app somehow misses this check — a good example of defense in depth. On submission, a notification of type `interest_request_received` is inserted with `entity_id` pointing to the request row, and delivered to the poster.

When the poster accepts, `status` transitions to `accepted` inside a `prisma.$transaction()` that simultaneously creates a `connections` row with `confirmation_status = pending` and both confirmed flags `FALSE`. The atomicity here is critical — a partially-committed accept (status updated but connection not created) would leave the system in an inconsistent state. A notification of type `interest_request_accepted` fires to the sender, and the sender's UI now shows the poster's WhatsApp deep-link (`wa.me/91XXXXXXXXXX`) to initiate contact.

When the poster declines, `status` transitions to `declined` and the sender is notified. The partial index now allows the sender to submit a fresh interest request in the future if they choose. When the sender withdraws before receiving a response, `status` transitions to `withdrawn` — allowed only while `status = pending`.

### 3.5 — Connection Confirmation Flow

A connection row is created at the moment an interest request is accepted. Both `initiator_confirmed` and `counterpart_confirmed` start as `FALSE`. Either party can flip their own flag at any time after the interaction occurs — there is no time constraint enforced at the DB level, only a cron job that expires connections in the `pending` state after 30 days of inactivity.

The application checks after each flag update: if BOTH flags are now `TRUE`, it sets `confirmation_status = confirmed` in the same transaction as the flag update. This transition is atomic — it cannot partially succeed. The moment `confirmation_status` reaches `confirmed`, two things become available: both parties can submit ratings against this `connection_id`, and the connection appears in each party's public interaction history.

If one party denies the interaction (actively setting their confirmation to a denial state), the `denial_reason` column captures their explanation for potential admin review.

### 3.6 — Rating Submission and Aggregate Update

Before accepting a rating `INSERT`, the `RatingService` performs an eligibility check: is `reviewer_id` either `initiator_id` or `counterpart_id` in the referenced connection, and is `confirmation_status = confirmed`? If either check fails, the submission is rejected at the application layer before it ever reaches the database. The `NOT NULL` FK on `connection_id` is the second line of defense — the database rejects the `INSERT` independently if the connection does not exist.

After a successful `INSERT`, the `update_rating_aggregates` trigger fires automatically. It calculates `AVG(overall_score)` and `COUNT(*)` for the reviewee filtering only `is_visible = TRUE AND deleted_at IS NULL` rows, then writes the result back to `users` or `properties`. Search result cards now reflect the updated score without any additional query from the application layer. A notification of type `rating_received` is dispatched to the reviewee.

### 3.7 — Notification System

Every state transition in the interest request and connection flows creates a notification row. The notification write path is called from service layer functions — never from controllers — to maintain clean dependency flow. In the current phase, notification delivery is polling-based: the client fetches unread count on page load using the partial index on `(recipient_id, created_at DESC) WHERE is_read = FALSE`, and fetches the full feed on the notifications page.

The `ws` WebSocket implementation is planned for a future phase. When built, it will authenticate connections via a JWT passed in the WebSocket handshake query parameter (since custom headers are not available in browser WebSocket connections), join each socket to a room identified by `user_id`, and push notification payloads in real time. The database design already supports this — no schema changes will be needed when `ws` is added.

### 3.8 — Rating Moderation Flow

Any user can report a visible rating using one of four reasons: `fake`, `abusive`, `conflict_of_interest`, or `other`. The report is inserted into `rating_reports` with `status = open`. A partial unique index prevents duplicate open reports from the same reporter against the same rating.

When an admin resolves a report as `resolved_removed`, the application sets `ratings.is_visible = FALSE`. This change fires `update_rating_aggregates`, which recalculates the reviewee's average excluding the now-hidden rating. The rating row is never deleted — it remains for audit history and is still referenced by the report row. When an admin resolves as `resolved_kept`, the rating remains visible and the report is simply closed. Both outcomes are preserved because the pattern of which reasons lead to removals informs future automated flagging logic.

---

## 4 — Cross-Zone Data Flows

The four zones are not independent silos — data flows between them in both directions. Understanding these cross-zone flows is critical for building features in the correct order and for understanding why certain denormalized columns exist where they do.

### Downward Flow — Creation Dependencies

The creation dependency graph is strictly top-down. Zone 1 must exist before Zone 2 can have an `owner_id` or `posted_by`. Zone 2 must exist before Zone 3 can have a `listing_id` on `interest_requests` or `connections`. Zone 3 must have a confirmed connection before Zone 4 can accept a rating `INSERT`. This is why the backend build order follows zones in sequence — you cannot meaningfully test a listing feature without auth, cannot test interest requests without listings, cannot test ratings without connections.

### Upward Flow — Trigger-Driven Cache Updates

Zone 4 writes back to Zones 1 and 2 via the `update_rating_aggregates` trigger. This denormalization is a deliberate trade of storage for read performance — search queries on listings never need to JOIN to `ratings` or run `AVG()` live.

| From | To | Mechanism | Trigger |
|------|----|-----------|---------|
| `ratings` (Zone 4) | `users` (Zone 1) | `update_rating_aggregates` trigger | `overall_score`, `is_visible` change |
| `ratings` (Zone 4) | `properties` (Zone 2) | `update_rating_aggregates` trigger | `overall_score`, `is_visible` change |
| `interest_requests` (Zone 3) | `connections` (Zone 3) | App creates connection on accept | `status = accepted` |
| `connections` (Zone 3) | `notifications` (Zone 3) | App creates notification on status change | `confirmation_status` change |
| `ratings` (Zone 4) | `notifications` (Zone 3) | App creates notification after INSERT | Rating INSERT |

### The Complete End-to-End Trust Flow

Tracing one complete user journey from registration to submitted rating shows how all four zones interact in sequence.

| Step | Action | System Behaviour |
|------|--------|-----------------|
| 1 | Student registers | Zone 1: `users` row created, email domain matched against `institutions`, `institution_id` written to `student_profiles`, student role assigned in `user_roles` |
| 2 | Student browses listings | Zone 2: search query filters `listings` by city, rent, `room_type`. PostGIS proximity filter applied if lat/lng provided. Compatibility score computed via Zone 1 `user_preferences` JOIN Zone 2 `listing_preferences` |
| 3 | Student sends interest | Zone 3: `interest_requests` row inserted (`status = pending`). Notification (`interest_request_received`) created and delivered to listing poster |
| 4 | PG owner accepts | Zone 3: `interest_requests.status → accepted`. `connections` row created (`confirmation_status = pending`). Notification (`interest_request_accepted`) sent to student. WhatsApp deep-link shown in student UI |
| 5 | Both parties confirm | Zone 3: `initiator_confirmed` and `counterpart_confirmed` both flipped `TRUE`. App transitions `confirmation_status → confirmed` in atomic transaction. Notification (`connection_confirmed`) sent to both parties |
| 6 | Student submits rating | Zone 4: `ratings` row inserted with `connection_id` FK. App verified reviewer is a participant in the confirmed connection. DB enforces `NOT NULL` FK. Partial unique index prevents duplicate |
| 7 | Trigger fires | Zone 4 → Zone 1/2: `update_rating_aggregates` recalculates AVG and COUNT, writes back to `properties.average_rating`. Zone 3: notification (`rating_received`) sent to PG owner |
| 8 | Rating appears in search | Zone 2: next listing search reads updated `properties.average_rating` from cached column — no live `AVG()` needed |

---

## 5 — Background Jobs & Scheduled Tasks

Operations that would block the HTTP response cycle or that are time-triggered rather than event-triggered are moved out of the request path into BullMQ queues and `node-cron` scheduled tasks.

### BullMQ Queues

BullMQ is configured with the official `redis` npm package via a custom connection factory (since BullMQ's default assumes `ioredis` but supports custom connections through its `connection` option accepting any Redis-compatible client). Each queue has its own concurrency settings and retry policy, and all are visible in the Bull Board dashboard at `/admin/queues` in development.

| Queue | Triggered By | What It Does | Concurrency |
|-------|-------------|--------------|-------------|
| `email-queue` | Registration, OTP, listing alerts | Sends emails via Nodemailer (Ethereal in dev, Azure Communication Services in prod) | 5 workers |
| `notification-queue` | Every Zone 3 state transition | Inserts notification row. Decoupled from the main transaction so a notification failure never rolls back a state change | 10 workers |
| `media-processing-queue` | Photo upload endpoint | Sharp compression pipeline: resize to 1200px max, convert to WebP, quality 80 | 1 worker (CPU-bound) |
| `listing-expiry-queue` | Cron trigger (daily) | Bulk-updates listings where `expires_at < NOW()` and `status = active` to `status = expired` | 2 workers |

### node-cron Scheduled Tasks

| Schedule | Task | Tables Affected |
|----------|------|-----------------|
| Daily 02:00 | Listing expiry — find active listings past `expires_at`, bulk-update to `expired`, dispatch `listing_expiring` notifications | `listings`, `notifications` |
| Daily 03:00 | Connection expiry — find pending connections older than 30 days, transition to `expired` status | `connections` |
| Daily 01:00 | Expiry warning — find active listings where `expires_at` is within 3 days, send `listing_expiring` notification | `listings`, `notifications` |
| Weekly Sunday 04:00 | Hard-delete cleanup — permanently remove rows where `deleted_at < NOW() - 90 days` | All tables with `deleted_at` |

---

## 6 — Tech Stack Reference

| Category | Package / Service | Role |
|----------|-------------------|------|
| Runtime | Node.js + Express.js | HTTP server, routing, middleware pipeline |
| ORM | Prisma + `@prisma/client` | DB access. Raw SQL via `$queryRaw` for PostGIS proximity |
| Validation | Zod | Request body, query params, route params, and `.env` validation at startup |
| Auth | `jsonwebtoken` + `bcryptjs` + `google-auth-library` | JWT issuance/verification, password hashing, Google OAuth ID token verification |
| Cache | `redis` (official v4+ npm package) | Redis client for rate limiting, OTP TTL storage, general caching |
| Queue | BullMQ | Job queue. Uses `redis` client via custom connection factory |
| Queue Dashboard | `@bull-board/express` | Visual queue inspector at `/admin/queues` (dev only) |
| Real-Time | `ws` | Native WebSocket — future phase. Not built during verified-user phase |
| Contact (Current) | WhatsApp `wa.me` deep-link | Shown to student after interest request accepted. Zero infrastructure cost |
| File Uploads | `multer` + `sharp` | Multipart parsing + WebP compression pipeline |
| Email (Dev) | `nodemailer` + Ethereal Mail | Fake SMTP — no real emails sent, preview URL logged to console |
| Email (Prod) | Azure Communication Services SDK | Real email delivery in Azure environment |
| Scheduling | `node-cron` | Time-triggered tasks within the main Express process |
| Logging | `pino` + `pino-http` + `pino-pretty` | Structured JSON logging. `pino-pretty` for human-readable dev output |
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

## 7 — Backend Build Order

The build order is a directed dependency graph. Each level cannot be meaningfully tested until all levels above it are stable.

| Level | Zone | Produces | Blocked By |
|-------|------|----------|------------|
| 0 | Foundation | Express app, Prisma singleton, Redis singleton, Pino logger, global error handler, Zod env validation, CORS, Helmet, base router | — |
| 1 | Auth + Identity | `authenticate` JWT middleware, `authorize(role)` middleware, `req.user` shape, bcryptjs hashing, OTP via Redis TTL, Ethereal email transport, Google OAuth callback, token refresh, student + pg_owner profile CRUD | Level 0 |
| 2 | Institution + Verification | Institution lookup service, PG owner document upload, admin verification queue endpoints | Level 1 |
| 3 | Listings | Amenity seeding, property CRUD (pg_owner-gated), listing CRUD, listing photos, search with dynamic Prisma `WHERE` + PostGIS raw query, compatibility scoring, saved listings | Level 2 |
| 4 | Media | `StorageService` interface (`LocalDiskAdapter` + `AzureBlobAdapter`), Multer config centralised, Sharp compression moved to `media-processing-queue` | Level 3 |
| 5 | Interest + Connections | Interest request state machine (all transitions in `prisma.$transaction`), connection creation, two-sided confirmation flow, WhatsApp deep-link exposure on accept, notification dispatch after each transition | Level 3 |
| 6 | Notifications | Notification HTTP endpoints (feed, mark-read, unread count), `notification-queue` worker wired | Level 5 |
| 7 | Ratings | Rating submission with connection eligibility check, public rating feed, report submission, `is_visible` moderation | Level 5 + 6 |
| 8 | Background Jobs | Listing expiry cron, connection expiry cron, soft-delete cleanup cron, `email-queue` worker | Level 7 |
| 9 | Admin Panel | Admin-only router, verification queue management, user account management, rating moderation, platform analytics queries | Level 8 |
| 10 | Real-Time (Future) | `ws` WebSocket server, JWT handshake authentication, user rooms, push notification delivery replacing polling | Level 6 stable |

---

## 8 — Environment Files

Two environment files serve distinct purposes and are never mixed. The `ConfigService` module validates both files using Zod at startup and throws immediately if any required variable is absent — preventing silent runtime failures.

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

This file is used specifically to verify that the application can connect to all Azure services before a production deployment. It is never used for day-to-day feature development.

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
