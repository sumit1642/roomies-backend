# Roomies — Phase 2 Implementation Plan

## Listings, Search, Media & Saved

**Author perspective:** Senior backend engineer planning from the database up.  
**Entry condition:** Phase 1 fully merged and stable. At least one verified PG owner and one verified student exist in
the database.  
**No code in this document — only architecture, reasoning, and decisions.**

---

## The Mental Model for Phase 2

Phase 1 answered "who are you and can we trust you?" Phase 2 answers "what are you offering, and can someone find it?"
The entire zone is built around the `listings` table, which is the most queried table in the entire schema for the
lifetime of this product. Every architectural decision in this phase must be made with that in mind.

There are four branches in Phase 2, and their dependency order is strict and non-negotiable:

```
phase2/amenities  →  phase2/listings  →  phase2/media  →  phase2/saved
```

You cannot build listings without amenities seeded. You cannot build media without a listing to attach photos to. You
cannot build saved listings without a listing to save. Each branch must be merged and manually verified before the next
begins.

---

## Branch 1 — `phase2/amenities`

### What this branch is really about

This branch has two distinct jobs that happen to ship together: seeding the amenities reference table, and building the
property CRUD. They are coupled because a property without amenities is only half-useful, and the amenity seed must
exist before any property can attach amenities in the same transaction.

### The Amenity Seed Script

The `amenities` table is a master reference list — it is not user-generated content. Every amenity like WiFi, CCTV, AC,
or power backup is a curated, categorised entry that maps to a frontend icon via the `icon_name` column. This design
decision was made at the schema level and it has an important consequence: the seed script is not a one-time migration.
It is an idempotent script that can be re-run safely at any time using `ON CONFLICT DO NOTHING` on the `name` column,
which has a `UNIQUE` constraint.

The seed script lives at `src/db/seeds/amenities.js` and is run manually by a developer — it is not wired into server
startup. This is deliberate. You do not want your server boot sequence blocked by a seed operation. It runs once per
environment after the schema is applied.

The amenity categories are `utility`, `safety`, and `comfort` — these are the enum values already in the database. Every
seed row must belong to one of these three. The `icon_name` column is what the frontend uses to render icons without
maintaining a hardcoded map — keep these values consistent and document them.

### Property CRUD

Properties are the physical building records owned by PG owners. They are the parent of listings, so getting their
integrity right is the foundation of everything that follows in this phase.

**The verification gate** is the most architecturally significant decision in this branch. The database schema does NOT
enforce `verification_status = 'verified'` before a property INSERT. The gate is application-only, living in the
property service. This is a conscious trade-off: putting it in the DB as a CHECK or FK would require a complex trigger,
and the service-layer check is more readable and easier to test. The consequence is that you must never bypass the
service layer when inserting properties. The service checks `pg_owner_profiles.verification_status = 'verified'` for the
requesting user before proceeding with any write.

**The amenity junction table transaction** is the second important decision. When a property is created with amenities,
both the `properties` INSERT and the `property_amenities` INSERT(s) must happen in a single `BEGIN/COMMIT` transaction.
A property that exists without its amenities is an inconsistent state — the admin or PG owner would see a property with
no amenities listed, which is misleading. If the amenity INSERTs fail (e.g., an invalid `amenity_id` is passed), the
whole property creation rolls back. This is correct behaviour.

**The PostGIS geometry column** never gets written by application code — the `sync_location_geometry` trigger handles it
automatically from `latitude` and `longitude`. The service layer only ever writes the decimal coordinates. This is
already wired in the schema and requires no application-level consideration other than making sure you always provide
both `latitude` and `longitude` together or neither. The Zod validator must enforce this as a cross-field refinement.

**Soft-delete is blocked if active listings exist.** When a PG owner tries to delete a property, the service must first
check whether any listings with `status = 'active'` exist under that `property_id`. If they do, the delete must be
rejected with a meaningful error. The reason is data integrity: deleting a property while students are browsing its
active listings creates orphaned listings that can still appear in search results until the next expiry cycle. The
correct flow is: deactivate all listings first, then delete the property. This check is application-enforced, not
schema-enforced (the FK is `ON DELETE RESTRICT` which would block the hard-delete but the service uses soft-delete via
`deleted_at`).

**Property update** follows the same dynamic `SET` clause pattern established in Phase 1 for student and PG owner
profiles. Only fields provided in the request body get updated. The `location` geometry is not directly updatable —
updating `latitude` and `longitude` triggers the DB function automatically.

---

## Branch 2 — `phase2/listings`

### Why this is the most complex branch in the entire project

The `listings` table serves two fundamentally different content types through a single schema — student listings (where
`property_id IS NULL`) and PG room listings (where `property_id IS NOT NULL`). Every service function must be aware of
this distinction and branch accordingly. This is not a code smell — it is an intentional design trade-off to avoid
duplicating a near-identical table structure. The complexity lives in the service layer, not the schema.

### Listing CRUD

**Creation** has several non-obvious rules that need careful enforcement.

The `expires_at` field is set by the server at `NOW() + INTERVAL '60 days'` and never accepted from the request body. If
it were accepted from the body, a PG owner could create a listing that never expires, which would eventually bloat the
active listings index and skew search results. The 60-day rule is a business policy enforced in the service layer.

For **PG owner listings**, the service must verify that the `property_id` provided actually belongs to the authenticated
user. This is an ownership check at the property level, not just the user level. A PG owner cannot create a listing
under another owner's property.

For **student listings**, there is no `property_id`. The student provides their own address and coordinates. The
`sync_location_geometry` trigger handles the PostGIS geometry. The service must not accept a `property_id` from a
student — it must be hardcoded to NULL for student-created listings.

The `rent_per_month` and `deposit_amount` are stored in **paise** (smallest INR unit) in the database. The Zod validator
accepts values in rupees from the client, and the service multiplies by 100 before writing to the database. Every read
path divides by 100 before returning to the client. This arithmetic must happen in one place — the service — never
scattered across controllers or validators.

**Update** must enforce ownership at the service level: the authenticated user must be the `posted_by` user on the
listing. An admin should never casually be able to update a listing through this endpoint — that is a Phase 5 concern.

**Soft-delete** sets `deleted_at` and does not touch `status`. This means there are two independent signals: a listing
can be `active` but soft-deleted (transitional state during hard-delete cleanup), and a listing can be `deactivated` and
not soft-deleted (user hid it manually). Search queries must filter `AND deleted_at IS NULL AND status = 'active'` to
get clean results.

### Search — The Most Architecturally Significant Endpoint

The search endpoint is where every earlier decision in the schema pays off or comes back to haunt you. It is also the
endpoint most likely to have performance problems at scale, so it deserves the most careful thought.

**The query is dynamic and parameterised.** There is no single static SQL query. The WHERE clause is built at runtime
from the filters the user actually provides. City and status are the baseline — nearly every search includes them, and
the composite index `idx_listings_city_status` is specifically designed for this. Adding optional filters (rent range,
room type, gender, available_from, listing type, amenity filter) appends additional clauses to the same parameterised
query. This avoids the N+1 anti-pattern of running a base query and then filtering in JavaScript.

**The amenity filter is a subquery or JOIN on `listing_amenities`**, not a string search. If a user filters for WiFi and
AC, the query must return only listings that have both amenities — this is an AND condition across amenity rows, which
requires either a `HAVING COUNT(DISTINCT amenity_id) = N` approach or a series of EXISTS subqueries. The `HAVING COUNT`
approach is more performant for multi-amenity filters because it scans `listing_amenities` once. The
`idx_listing_amenities_amenity_id` index is designed for exactly this reverse lookup.

**PostGIS proximity** via `findListingsNearPoint` in `src/db/utils/spatial.js` is a separate query that returns listing
IDs within a given radius using `ST_DWithin` with a geography cast. The geography cast matters — it makes the radius
calculation accurate in meters accounting for Earth's curvature, rather than using flat Euclidean distance which becomes
meaningless at scale. This function only returns IDs. The main search query can then optionally filter by those IDs as
an `IN` clause if the user provided coordinates. The reason proximity is a separate step rather than a JOIN on the main
query is that `ST_DWithin` on a GiST index is fast for the spatial filter, but mixing it with the full listing SELECT
complicates query planning. Separating the concern is cleaner.

**Compatibility scoring** via `scoreListingsForUser` in `src/db/utils/compatibility.js` is the last step in the search
pipeline, and it runs after the main query returns results. It takes the list of listing IDs from the search results and
JOINs `listing_preferences` against `user_preferences` for the authenticated user, counting matching
`(preference_key, preference_value)` pairs per listing. The score is appended to each listing object before the response
is sent. It is never stored in the database — it is always computed fresh so that if a user updates their preferences,
the next search immediately reflects the change.

The **search response shape** needs to be designed carefully because it is the first response in this project that
returns a collection rather than a single resource. It must include pagination metadata (keyset cursor, not offset —
same reasoning as Phase 1's verification queue), the total is never returned (COUNT on a filtered listings table is
expensive and not necessary), and each listing item must include its cover photo URL, compatibility score, and the
denormalized `average_rating` from the property (for PG listings) or the poster (for student listings).

### Listing Preferences

`listing_preferences` are set at listing creation time and can be updated separately. They mirror the EAV structure of
`user_preferences`. The service must enforce the `UNIQUE (listing_id, preference_key)` constraint at the application
layer (the DB will enforce it as a hard stop, but a pre-check in the service gives a better error message).

---

## Branch 3 — `phase2/media`

### The storage adapter pattern

The `StorageService` is an interface with two implementations: `LocalDiskAdapter` for development and `AzureBlobAdapter`
for production. The `STORAGE_ADAPTER` environment variable controls which is instantiated at startup. Neither the
controller nor the service knows which adapter is active — they only call `storageService.upload(file)` and receive back
a URL string. This is the same pattern as environment-driven config: zero code changes between dev and prod, only env
var changes.

The `LocalDiskAdapter` writes files to the `/uploads` folder and returns a relative URL like `/uploads/filename.webp`.
The `AzureBlobAdapter` uploads to Azure Blob Storage and returns a full HTTPS URL. In this phase, the `AzureBlobAdapter`
is a stub that throws 501 — the interface exists but Azure integration is deferred to the deployment phase.

### Why uploads return 202 Accepted

Photo upload does not return 200. It returns `202 Accepted` with a job ID. This is because the Sharp compression
pipeline (resize to 1200px max, convert to WebP, quality 80) is CPU-bound and potentially takes several hundred
milliseconds. Running it synchronously in the request handler would block the Node.js event loop for every concurrent
upload request. The upload endpoint accepts the raw file, writes it to a staging location, enqueues a
`media-processing-queue` job in BullMQ, and returns immediately with a job reference.

The BullMQ worker picks up the job, runs Sharp, writes the compressed file, and updates the `listing_photos` row with
the final URL. The concurrency for this worker is set to 1 — not because BullMQ cannot run concurrent jobs, but because
Sharp is CPU-intensive and running multiple Sharp jobs concurrently on the same Node process will saturate the CPU. One
job at a time is correct for a single-instance deployment. If you ever scale to multiple instances on Azure, each
instance has its own worker with concurrency 1, which gives you horizontal scaling without intra-instance CPU
contention.

### The cover photo constraint

The `listing_photos` table has a partial unique index `WHERE is_cover = TRUE AND deleted_at IS NULL` that enforces at
most one cover photo per listing at the database level. The service honours this by checking whether the listing already
has a cover photo before setting a new one. If no cover photo exists (first upload), the new photo is automatically set
as cover. If one already exists, the new photo is not set as cover unless explicitly requested by the client. This logic
lives in the service, and the DB constraint is the final safety net.

### The worker lifecycle in server.js

The media processing worker is started in `server.js` alongside the PostgreSQL and Redis connections. It must also be
shut down gracefully on SIGTERM/SIGINT — BullMQ workers have a `close()` method that drains the current job before
shutting down. This must be added to the existing graceful shutdown sequence, before `pool.end()` and `redis.close()`.
The order matters: close the worker first (stop accepting new jobs), then close Redis (which BullMQ uses internally),
then close the DB pool.

---

## Branch 4 — `phase2/saved`

### Idempotency by design

The save operation uses `INSERT ... ON CONFLICT DO NOTHING` on the `(user_id, listing_id)` composite primary key. This
means a student who saves the same listing twice gets a 200 response both times, not a 409. This is the correct
behaviour for a bookmark feature — the client should not need to track whether it has already saved something. The
operation is idempotent.

### The unsave operation

Unsave is a soft-delete: it sets `deleted_at = NOW()` on the `saved_listings` row rather than deleting it. This is
consistent with the rest of the schema. It also means the composite PK alone is not a sufficient uniqueness guard after
unsaving — a re-save after an unsave would hit the PK conflict even though the `deleted_at` version should be treated as
gone. The service must handle this by upserting: if a row exists with a non-null `deleted_at`, it updates that row back
to `deleted_at = NULL` rather than inserting a new row.

### The saved listings feed

`GET /users/me/saved-listings` returns only active, non-deleted listings that the authenticated user has saved. This
requires JOINing `saved_listings` against `listings` with the filter
`listings.status = 'active' AND listings.deleted_at IS NULL`. Listings that have since expired, been filled, or been
deactivated are silently omitted from the feed — not returned with an error. The client never needs to handle a "this
saved listing is no longer available" state at the API level; it simply isn't in the list. This simplifies the client
significantly.

Pagination for this feed uses the same keyset cursor pattern as the verification queue — stable under concurrent updates
to the saved_listings table.

---

## Cross-Cutting Concerns for the Entire Phase

### The paise arithmetic rule

Every price in this phase is stored in paise and returned in rupees. This rule must be documented in a comment in the
listing service and enforced in Zod validators. The validator accepts the value in rupees from the client. The service
multiplies by 100 before writing. Every read path divides by 100 before the response is assembled. No floating-point
arithmetic anywhere — all multiplication and division is integer arithmetic since we only deal in whole rupees.

### Authorisation pattern for listings

Phase 2 introduces a new authorisation pattern that does not exist in Phase 1: resource-level ownership checking. In
Phase 1, ownership was simple (your profile is yours). In Phase 2, a PG owner can own multiple properties and multiple
listings under those properties. The service layer must always check `owner_id = requestingUserId` (for properties) or
`posted_by = requestingUserId` (for listings) on every mutation. Role-level `authorize('pg_owner')` is not sufficient —
it only confirms the role, not the ownership of the specific resource.

### Index utilisation awareness

The search endpoint will be the first endpoint that seriously exercises the database indexes designed in the schema. The
three most important indexes for search are `idx_listings_city_status` (covers the city + active status filter),
`idx_listings_rent` (covers the rent range filter), and `idx_listings_location` (GiST, covers proximity). Writing the
search query as a dynamic parameterised WHERE clause rather than separate queries for each filter combination ensures
the query planner sees a single query and can choose the best index combination via bitmap index scan or index
intersection.

### Response shapes must be finalised before Phase 3

Phase 3 (interest requests) will send notifications that reference listing IDs and embed listing data in notification
payloads. The listing response shape decided in Phase 2 becomes the contract that Phase 3 depends on. Do not design it
as a quick convenience — design it as a stable API contract. The listing summary shape (used in search results and saved
feed) and the listing detail shape (used in the single listing GET) should be explicitly separated in the service.

---

## What Phase 2 Unlocks

By the end of this phase, the core product loop is demonstrable for the first time: a verified PG owner can post a
property with amenities, attach listings with photos and preferences, and a student can search for listings near their
college with compatibility scores, view details, and save the ones they like. This is the first moment the platform is
actually usable as a product — not just as an infrastructure. Phase 3's interest request system requires exactly this to
be stable before it can begin.

---

_— Document created: Phase 2 planning complete, no code written yet —_

# Phase 2 / `phase2/amenities` — Build Plan

Let's think through this branch carefully before touching any code. There are two jobs here — amenity seeding and
property CRUD — and the decisions made in this branch set the conventions that `phase2/listings` will depend on.

---

## What This Branch Delivers

By the end of this branch, a verified PG owner should be able to create a property (with amenities attached), read it
back, update it, and soft-delete it (subject to the active-listings gate). None of this is testable end-to-end until
`phase2/listings` exists, but the property endpoints can be manually verified in isolation.

---

## Part 1 — The Amenity Seed Script

### Where it lives and how it runs

The script goes at `src/db/seeds/amenities.js`. It is a standalone Node script — not a route, not a service function —
and it is run manually once per environment after the schema is applied. The npm script for it will be something like
`"seed:amenities": "ENV_FILE=.env.local node src/db/seeds/amenities.js"` added to `package.json`.

It must not be wired into server startup. The reasons are practical: you don't want the boot sequence to block on a seed
operation, and idempotency alone is not sufficient justification to run it every time — idempotent still means "it does
something," and "something" should be intentional.

### Idempotency via `ON CONFLICT DO NOTHING`

The `amenities` table has a `UNIQUE` constraint on `name`. The seed script uses
`INSERT INTO amenities (...) VALUES ... ON CONFLICT (name) DO NOTHING`. This means re-running the script after adding
new amenities only inserts the rows that don't yet exist — it never touches existing rows. That's the correct behaviour:
you want to be able to add new amenities to the seed list and re-run safely, without touching whatever `icon_name` or
`category` updates an admin may have made in the DB since the last seed.

### What amenities to seed

The three categories are `utility`, `safety`, and `comfort` — those are the enum values in the schema. A reasonable
initial set across all three:

**Utility** covers infrastructure: WiFi, power backup, water supply (24-hour), piped gas, laundry, housekeeping.

**Safety** covers security: CCTV, security guard, gated entry, biometric/key-card access, fire extinguisher.

**Comfort** covers quality-of-life: AC, ceiling fan, attached bathroom, furnished room, gym, common room/lounge,
parking, rooftop/terrace.

The `icon_name` column is what the frontend uses to render icons without a hardcoded map. The convention needs to be
established now. A reasonable choice is kebab-case strings that map to a known icon library (e.g. Lucide or React Icons)
— something like `wifi`, `power-backup`, `cctv`, `air-conditioning`. These strings must be documented in a comment in
the seed file so future developers know what format to follow when adding new amenities.

### The script structure

The script connects to the pool, runs the INSERT, logs how many rows were inserted vs skipped (you can get this from
`result.rowCount` — `ON CONFLICT DO NOTHING` means `rowCount` only counts actual inserts), and closes the pool. It
should import `config` from `src/config/env.js` and `pool` from `src/db/client.js` exactly as any other file does — no
special treatment just because it's a seed script.

---

## Part 2 — Property CRUD

### New files this branch creates

The property system follows the exact layering pattern already established in Phase 1. The new files are
`src/validators/property.validators.js`, `src/services/property.service.js`, `src/controllers/property.controller.js`,
and `src/routes/property.js`. The property router gets mounted at `/api/v1/properties` in `src/routes/index.js`.

### Validation layer — the interesting decisions

The property Zod schema has one non-obvious requirement: `latitude` and `longitude` must be validated as a cross-field
pair. Either both are present or neither is — a property with only `latitude` is invalid because the
`sync_location_geometry` trigger needs both. In Zod v4 this is a `.refine()` on the body object:

```js
.refine(
  data => (data.latitude === undefined) === (data.longitude === undefined),
  { error: "latitude and longitude must be provided together" }
)
```

`amenityIds` is validated as an array of UUIDs with `z.array(z.uuid())`. The array can be empty (a property with no
amenities is valid), but the array itself must be present — or at minimum treated as an empty array via `.default([])`.
Why? Because the service always needs to know "what amenities should this property have" — `undefined` and `[]` mean
different things in the update path.

For the update schema, `amenityIds` means "replace the entire amenity set with this new list." This is a full-replace
semantic, not a patch. It's simpler and more predictable for both the API consumer and the implementation. The
partial-patch approach (add these, remove those) requires a diff and is not worth the complexity here.

`pincode` is a string, not a number — leading zeros are significant in Indian postal codes (e.g. 011001).

### Service layer — the key decisions

**The verification gate.** Before any property write, the service queries `pg_owner_profiles` for
`verification_status = 'verified'` where `user_id = requestingUserId AND deleted_at IS NULL`. If the row doesn't exist
or the status isn't `verified`, it throws `AppError("Your account must be verified before creating properties", 403)`.
This is a 403, not a 401 — the user is authenticated, just not authorised for this specific operation. The check lives
in the service, not in a middleware, because it's a data-dependent decision that the schema cannot enforce.

**The amenity transaction.** Property creation uses an explicit `BEGIN/COMMIT` block. Inside the transaction: INSERT
into `properties` with RETURNING `property_id`, then (if `amenityIds.length > 0`) bulk-INSERT into `property_amenities`.
The bulk insert uses a single parameterised query with a VALUES list built dynamically — not N separate queries.
Pseudocode: `INSERT INTO property_amenities (property_id, amenity_id) VALUES ($1, $2), ($1, $3), ...` where `$1` is the
new `property_id` and `$2..$N` are the amenity IDs. This is atomic — if any amenity ID is invalid (FK violation on
`amenity_id`), the whole transaction rolls back and the property doesn't exist. That's the correct behaviour. The error
handler already catches `23503` (FK violation) and returns a 409 — so invalid amenity IDs surface cleanly.

**Why not use a trigger for amenity linking?** Because amenity linking requires application input (which amenity IDs to
link). Triggers only fire on data that's already being written — they can't read from request context. The transaction
pattern is the right tool here.

**The soft-delete gate.** Before setting `deleted_at = NOW()` on a property, the service runs a check query:
`SELECT COUNT(*) FROM listings WHERE property_id = $1 AND status = 'active' AND deleted_at IS NULL`. If count > 0, throw
`AppError("Deactivate all active listings before deleting this property", 409)`. A 409 is appropriate because the
conflict is with existing data state, not the request itself.

**The update path.** The service uses the same dynamic `SET` clause pattern from Phase 1 for scalar fields. For
`amenityIds` specifically, if it's present in the update body: delete all existing rows from `property_amenities` where
`property_id = $1`, then re-insert the new set. Both the delete and re-insert happen in the same transaction as the
property UPDATE. This full-replace semantic is simple and correct — it avoids any diff logic and the DB constraint
prevents duplicates.

**Ownership check on write operations.** For update and delete, the service checks `owner_id = requestingUserId` by
querying the property row first. If the property doesn't exist or `deleted_at IS NOT NULL`, it's a 404. If it exists but
`owner_id` doesn't match, it's a 403. This is the resource-level ownership check that Phase 2 introduces for the first
time (as noted in the implementation plan).

A cleaner approach is to embed the ownership check into the UPDATE/DELETE query itself —
`WHERE property_id = $1 AND owner_id = $2 AND deleted_at IS NULL` — and use `rowCount === 0` to distinguish "doesn't
exist" from "not your resource" only when needed. For update and soft-delete, this is fine because we return a 404/403
either way. The property read (GET) doesn't need an ownership check at all — any authenticated user can read any
property.

### Routes

The property router shape looks like this:

`POST /api/v1/properties` — `authenticate`, `authorize('pg_owner')`, `validate(createPropertySchema)`,
`propertyController.createProperty`

`GET /api/v1/properties/:propertyId` — `authenticate`, `validate(propertyParamsSchema)`,
`propertyController.getProperty`

`PUT /api/v1/properties/:propertyId` — `authenticate`, `authorize('pg_owner')`, `validate(updatePropertySchema)`,
`propertyController.updateProperty`

`DELETE /api/v1/properties/:propertyId` — `authenticate`, `authorize('pg_owner')`, `validate(propertyParamsSchema)`,
`propertyController.deleteProperty`

`GET /api/v1/properties` — `authenticate`, `authorize('pg_owner')`, `validate(listPropertiesSchema)`,
`propertyController.listProperties` — returns only the requesting user's own properties. A PG owner needs a "my
properties" view to manage listings under each property.

### The `listProperties` query and pagination

This is the first list endpoint in the project (the verification queue was Phase 1, but that was admin-only and already
handled). It uses keyset pagination, consistent with `getVerificationQueue`. The cursor is `(created_at, property_id)`,
ordered newest-first (a PG owner wants to see their most recently added properties at the top). The query filters on
`owner_id = $1 AND deleted_at IS NULL`. The `limit + 1` trick for detecting next-page applies here too.

### What the response shape looks like

The GET single property response should include the property's own columns plus the list of amenity objects (not just
IDs) joined from `amenities`. This means a JOIN or a subquery against `property_amenities JOIN amenities`. Returning
full amenity objects (with `name`, `category`, `icon_name`) means the frontend never needs to make a second request to
translate IDs to display values.

The list response (for "my properties") returns a leaner version — property metadata plus a count of amenities (not the
full amenity objects), and a count of active listings (which requires a subquery against `listings`). This gives the PG
owner dashboard the information density it needs without over-fetching.

---

## What This Branch Does NOT Include

It's worth being explicit about the boundary. This branch does not include: listing creation (that's `phase2/listings`),
photo upload (that's `phase2/media`), PostGIS proximity queries (those belong to the listing search endpoint), or any
student-facing property views. Students will find properties through listings, not by browsing properties directly.

---

## Branch Completion Criteria

Before this branch merges, you should be able to manually verify:

A verified PG owner can POST a property with amenities and get a 201 back with the created property including full
amenity objects. Attempting to create a property with an invalid amenity UUID returns a 409 (FK violation). An
unverified PG owner gets a 403. A student gets a 403 (role check). GET retrieves the property with amenities. PUT
updates scalar fields and (when `amenityIds` is included) replaces the amenity set atomically. DELETE succeeds on a
property with no active listings, and returns a 409 when active listings exist. The seed script runs without error and
is idempotent.

The health check must still return 200 after all this — that's the standing rule before any merge.

---

When you're ready, we can start writing the actual code in dependency order: seed script first (standalone, no
blockers), then validators, then service, then controller, then routes.

---
---

# `phase2/listings` — Architecture & Planning

No code in this document. Every decision here is reasoned from the schema up.

---

## The Mental Model Before Writing a Single Line

Before thinking about routes or validators, it helps to hold the mental model of what a "listing" actually is in this schema, because it is doing double-duty in a way that has real consequences for how every service function is written.

A listing row where `property_id IS NULL` is a student posting their own room — they have a spare bed or want a flatmate, and they are the landlord in this context. A listing row where `property_id IS NOT NULL` is a PG owner advertising a room in a building they manage. Same table, same columns, same API surface, but fundamentally different actors, different ownership semantics, and different data requirements. Every service function in this branch has to be aware of which world it is operating in, and the branching logic is the most important thing to get right before anything else.

The second mental model to hold is that listings are the most-queried table in the entire schema for the lifetime of this product. Every search request touches it. Every student browsing the app hits it. Every index in the schema was designed with this table in mind. The search endpoint is the highest-stakes code in Phase 2 — it has to be written with query planner awareness, not just correctness.

---

## Branch Structure and Dependency Order

`phase2/listings` depends on `phase2/amenities` being fully merged. The reason is not just that listing creation can attach amenities via `listing_amenities` — it is that the amenities seed data must actually exist in the database for any listing with amenities to be insertable. An `amenity_id` FK on `listing_amenities` pointing to an empty `amenities` table would reject every INSERT. So the seed script is not optional infrastructure — it is a hard prerequisite.

The branch itself delivers four things in this order: listing CRUD, listing preferences management, the search endpoint (the hardest piece), and the saved listings feature. The search endpoint depends on listings existing to return, so CRUD comes first. Preferences are a child resource of listings and must come after listing creation. Search comes after preferences because compatibility scoring requires `listing_preferences` rows to JOIN against. Saved listings are last because they require listings to save.

---

## Part 1 — Listing CRUD

### New Files

The file layout follows the exact same layering pattern as properties and every Phase 1 resource. Four new files: `src/validators/listing.validators.js`, `src/services/listing.service.js`, `src/controllers/listing.controller.js`, and `src/routes/listing.js`. The listing router mounts at `/api/v1/listings` in `src/routes/index.js`.

### The Paise Rule — Understanding Why It Exists

Rent is stored in paise (the smallest INR unit — 1 rupee = 100 paise) as a PostgreSQL `INTEGER`. This means Rs 8,500/month is stored as `850000`. The reason is subtle but important: floating-point arithmetic in IEEE 754 (which is what JavaScript's `number` type uses) cannot represent all decimal values exactly. `0.1 + 0.2` in JavaScript is `0.30000000000000004`, not `0.3`. For a currency field this is unacceptable — rounding errors accumulate and you eventually get rent displayed as Rs 8,499.99 or Rs 8,500.01.

By storing in paise as integers, all arithmetic is exact integer arithmetic. There is no floating-point involvement until display time, and at display time you are dividing by 100 — a single operation that introduces no accumulated error.

The rule is: the Zod validator accepts values in rupees from the client (whole numbers only — no paise input), the service multiplies by 100 before writing, every read path divides by 100 before returning. This arithmetic must happen exclusively in the service layer. The controller never touches the raw paise values, the validator never sees paise, the DB never sees rupees. The boundary is the service.

A comment documenting this rule must live in the service file, directly above the conversion lines. Future developers who do not know the convention will touch this code — the comment is the only thing preventing them from returning raw paise to clients.

### Validator Decisions

The create schema branches meaningfully on listing type. For PG room listings (`listing_type` is `pg_room` or `hostel_bed`), `property_id` is required. For student listings (`listing_type` is `student_room`), `property_id` must be absent and `address_line` and `city` become required (a student listing needs its own address since it has no parent property). This is a cross-field refinement using `.refine()` on the body object, similar to the latitude/longitude pair validation in `property.validators.js`.

The `expires_at` field is not in the create schema at all. It is not accepted from the client. This is a deliberate omission — it is computed server-side in the service as `NOW() + INTERVAL '60 days'`. If it appeared in the schema, a PG owner could POST a listing with `expires_at: "2099-12-31"` and create a listing that never expires. The schema omission is the enforcement.

`rent_per_month` and `deposit_amount` are validated as `z.coerce.number().int().min(0)` in rupees. The service converts them. The validator must not accept fractional rupees (e.g. `8500.50`) because there is no sub-rupee denomination in normal Indian PG pricing, and accepting fractional values would require the service to decide how to round — a decision that should not exist.

`available_from` is validated as a date string `z.string().date()` — the same pattern as `dateOfBirth` in student validators. The service passes it as a string to PostgreSQL which handles date parsing natively.

Coordinates on student listings follow the same cross-field refinement as properties — both present or both absent. For PG listings, coordinates are intentionally not accepted at all because the location is inherited from the parent `properties` row. The validator for PG listing creation should not include latitude/longitude fields.

### Service Layer — The Branching Logic

The most important architectural decision in the listing service is where the branching between student listings and PG listings happens. It happens in the service, not in separate routes or controllers. A single `createListing` service function receives the body and the authenticated user's ID and roles, then branches internally. The reason for keeping it in one function: the response shape is identical, the transaction pattern is identical, and the differences are confined to a few conditional checks. Separate service functions would force the routes and controllers to know which type of listing is being created, which means putting business logic into the wrong layer.

**For PG listings:** before any INSERT, the service must verify that the provided `property_id` belongs to the authenticated user. The query is `SELECT 1 FROM properties WHERE property_id = $1 AND owner_id = $2 AND deleted_at IS NULL`. If `rowCount === 0`, throw `AppError("Property not found or does not belong to you", 404)`. This check is the resource-level ownership guard that `authorize('pg_owner')` at the route level cannot provide — the role check only confirms the user is a PG owner, not that they own this specific property.

Additionally, the service must enforce that the PG owner is verified before creating listings. `assertOwnerVerified` from the property service cannot be imported here (circular imports) — the right approach is to extract it into a shared module, or simply repeat the query inline with a comment explaining the duplication is intentional to avoid circular imports. Since it is a single query, the duplication is preferable to the architectural coupling that a shared import would create.

**For student listings:** `property_id` is hardcoded to `NULL` in the INSERT regardless of what the body contains. Even if a malicious student somehow submitted a `property_id`, the service ignores it. The address fields (`addressLine`, `city`, `locality`, `pincode`, `latitude`, `longitude`) from the body are written directly since student listings own their own location.

**The `expires_at` value** is always `NOW() + INTERVAL '60 days'`. The service inserts this as a PostgreSQL interval expression directly in the SQL string rather than computing a JavaScript `Date` object and passing it as a parameter. The reason: computing it in JavaScript introduces a subtle risk where the calculated timestamp is slightly before or after the actual INSERT time due to processing latency. Using `NOW()` in the SQL ensures the timestamp is computed at the exact moment the row is written.

**Listing preferences** can optionally be submitted alongside the listing at creation time. If `preferences` is present in the body, the service inserts the listing first, then bulk-inserts the preference rows inside the same transaction. The same bulk-insert pattern as `property_amenities` — a single multi-row `INSERT INTO listing_preferences (listing_id, preference_key, preference_value) VALUES ...` query rather than N separate inserts. The `UNIQUE (listing_id, preference_key)` constraint means sending duplicate keys in the same request results in a `23505` error from PostgreSQL, which the global handler converts to 409.

**Listing amenities** (room-level, stored in `listing_amenities`) follow the same pattern. Note the distinction: `property_amenities` are building-wide (WiFi for the whole PG), `listing_amenities` are room-specific (attached bathroom only for this room). Both the listing INSERT, the preferences INSERT, and the amenities INSERT must all be in the same transaction.

### Read — GET Single Listing

The single listing response is the most complex read shape in the project so far. It includes the listing's own columns, full amenity objects (name, category, icon_name) joined from `listing_amenities JOIN amenities`, listing preferences (all key-value pairs), the cover photo URL from `listing_photos WHERE is_cover = TRUE AND deleted_at IS NULL`, and if it is a PG listing, the parent property's name and location.

All of this in one query, using `LEFT JOIN` for amenities and photos (a listing with no amenities or no photos is valid), `JSON_AGG` for amenities (same as the property query), and a conditional `LEFT JOIN` to `properties` for the PG listing case. The `COALESCE(JSON_AGG(...) FILTER (WHERE ...), '[]')` pattern is already established in `fetchPropertyWithAmenities` — the same pattern applies here.

The rent division happens in the service after the DB returns raw paise values — the SELECT returns `rent_per_month` and `deposit_amount` as integers, and the service divides them by 100 before assembling the response object. This transformation should not happen in a SQL expression like `rent_per_month / 100.0` because that would leak the concern into the query layer.

### Update — PUT /:listingId

Update follows the dynamic SET clause pattern. Ownership is verified by embedding `AND posted_by = $N` in the UPDATE WHERE clause, same as the property update pattern. `rowCount === 0` returns 404 regardless of whether it was "not found" or "not yours" — information leakage prevention, same reasoning as properties.

If `amenityIds` or `preferences` are in the update body, the same full-replace semantic applies: DELETE all existing rows for this listing from the relevant table, then re-insert the new set, inside the same transaction as the listing UPDATE.

One field that must be excluded from the update schema is `listing_type` — you cannot change a student listing into a PG listing or vice versa after creation. The type is baked into the data model (the `property_id` nullable distinction). Allowing type changes would require a cascading restructure of related data that is not worth supporting.

Similarly, `expires_at` is excluded — it is only extendable via a dedicated renewal endpoint (Phase 5), not via PUT.

### Delete — DELETE /:listingId

Soft-delete: `UPDATE listings SET deleted_at = NOW() WHERE listing_id = $1 AND posted_by = $2 AND deleted_at IS NULL`. Same ownership-in-WHERE pattern. A 409 is returned if any open (pending or accepted) interest requests exist against this listing, similar to how a property cannot be deleted while it has active listings. The gate query is `SELECT 1 FROM interest_requests WHERE listing_id = $1 AND status IN ('pending', 'accepted') AND deleted_at IS NULL LIMIT 1`. This prevents a situation where a student expresses interest, the poster soft-deletes the listing, and the student's interest request is left dangling with no valid parent.

---

## Part 2 — The Search Endpoint

### Why This Is the Most Architecturally Significant Endpoint in the Project

Search is the first read endpoint that is not a by-ID lookup. Every other endpoint in the project so far has been "give me this specific thing by its ID." Search is "give me all things matching an arbitrary set of conditions, ordered and paginated." This is fundamentally harder for three reasons: the query must be dynamically constructed, the result set is a collection (not a single row), and the performance characteristics matter at scale in a way that single-row lookups do not.

The `listings` table will be the hottest table in the database by query volume. The search endpoint is where all the composite indexes defined in the schema pay off or fail to be used. Writing this query incorrectly — for example, using an `OR` condition where PostgreSQL expects separate clauses, or using a non-sargable expression that prevents index use — can turn a 5ms query into a 500ms query once the table has 10,000 rows.

### The Dynamic Parameterised WHERE Clause

The query is not a static SQL string. It is assembled at runtime from the filters the user actually provides. The pattern, established in the Phase 1 verification queue but much more significant here, is:

Start with a base array of clauses that are always present: `status = 'active'` and `deleted_at IS NULL`. Then, for each optional filter, push a new clause and its value into the params array if the filter is present. The final SQL string is assembled with `WHERE ${clauses.join(' AND ')}`.

This is the only correct approach. The alternative — running a base query and then filtering the results in JavaScript — is catastrophically wrong at scale. It fetches every active listing and then discards most of them in Node.js memory. The database has indexes; JavaScript does not.

The filters the endpoint supports and their implementations:

**City** is the most fundamental filter. Nearly every search includes it. The `idx_listings_city_status` composite index covers `(city, status) WHERE status = 'active' AND deleted_at IS NULL`, meaning a city + status filter is an index-only scan on a partial index — extremely fast. The city value is matched case-insensitively using `ILIKE $N` rather than exact match, because users will type "Delhi" or "delhi" or "New Delhi" and expect results. The trade-off is that `ILIKE` cannot use a standard B-Tree index — it requires `pg_trgm` (trigram indexing) for index use on large datasets. For the current phase, `ILIKE` without trigram indexing is acceptable — the city + status composite index does the heavy lifting for the initial filter, and ILIKE operates on the already-filtered result set. A trigram index can be added in Phase 5 if query analysis shows it is needed.

**Rent range** is two optional filters: `minRent` and `maxRent`. Each generates its own clause: `rent_per_month >= $N` and `rent_per_month <= $N`. The client provides values in rupees; the service multiplies by 100 before inserting them as query parameters, so the comparison is always paise-to-paise. The `idx_listings_rent` index on `(rent_per_month) WHERE status = 'active' AND deleted_at IS NULL` supports this filter.

**Room type** and **bed type** are simple equality filters on enum columns. `room_type = $N` and `bed_type = $N`. No index complexity needed — enum equality is fast on any indexed or unindexed column at the scale this product will operate at initially.

**Preferred gender** maps to the `preferred_gender` column. A student of any gender can search for listings that accept their gender. The value `null` in the database means "no preference" — a listing with `preferred_gender = NULL` is visible to all genders. The correct SQL for this is `(preferred_gender = $N OR preferred_gender IS NULL)` which returns listings that explicitly accept the given gender and listings with no gender restriction.

**Available from** maps to `available_from <= $N` — listings available on or before the date the student wants to move in. The `idx_listings_available_from` index supports this.

**Listing type** is an equality filter on `listing_type`. A student searching for PG rooms does not want to see other students' room postings in their results. The enum values (`student_room`, `pg_room`, `hostel_bed`) map directly to the filter parameter.

**Amenity filter** is the most complex filter. A student might search for "listings with WiFi and AC." This is an AND condition — the listing must have all the requested amenities, not just one. The correct SQL is a subquery existence check or a `HAVING COUNT` approach on `listing_amenities`. The recommended approach: for each `amenity_id` in the filter array, add a subquery: `EXISTS (SELECT 1 FROM listing_amenities la WHERE la.listing_id = l.listing_id AND la.amenity_id = $N)`. One `EXISTS` subquery per requested amenity. This is readable, correctly enforces AND semantics, and uses the `idx_listing_amenities_amenity_id` index in each subquery. The alternative `HAVING COUNT(DISTINCT amenity_id) = N` approach requires a JOIN + GROUP BY on the outer query, which complicates the query structure significantly.

### The Proximity Component — `src/db/utils/spatial.js`

PostGIS proximity search is its own query, separated from the main search query. The function `findListingsNearPoint(lat, lng, radiusMeters, client = pool)` returns an array of `listing_id` values for all listings within `radiusMeters` meters of the given point.

The SQL is: `SELECT listing_id FROM listings WHERE ST_DWithin(location::geography, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, $3) AND status = 'active' AND deleted_at IS NULL`. The `::geography` cast is critical — it makes `ST_DWithin` operate in meters on a spherical Earth rather than in degrees on a flat plane. Without the geography cast, a 3km radius in degrees would be correct at the equator but wildly wrong in India (about 23°N latitude). The `idx_listings_location` GiST index supports the spatial query. The function is in `src/db/utils/spatial.js` because it is reused by the listing search and potentially the property proximity search in Phase 5.

When the search request includes coordinates and a radius, the proximity function runs first, returning a list of `listing_id` values. These are then added to the main search query as an `AND l.listing_id = ANY($N::uuid[])` clause. `ANY` with an array parameter is more efficient than `IN (...)` with a dynamically-built clause because it avoids rewriting the query string for different array sizes.

The radius defaults to 5km if coordinates are provided without an explicit radius. The maximum enforced by the validator is 50km — searching within 50km of a location in a PG discovery context is already very broad, and allowing unlimited radius would effectively make the radius filter meaningless (it becomes a full-table scan with a spatial filter that returns most of the table).

### Compatibility Scoring — `src/db/utils/compatibility.js`

Compatibility scoring runs after the main search query returns results. The function `scoreListingsForUser(userId, listingIds, client = pool)` takes an array of listing IDs and returns a map of `{ listingId: score }`.

The SQL JOINs `listing_preferences` against `user_preferences` on `(preference_key, preference_value)` for the given user and listing IDs: `SELECT lp.listing_id, COUNT(*)::int AS match_count FROM listing_preferences lp JOIN user_preferences up ON up.preference_key = lp.preference_key AND up.preference_value = lp.preference_value WHERE lp.listing_id = ANY($1::uuid[]) AND up.user_id = $2 GROUP BY lp.listing_id`. This returns a row per listing that has at least one preference match. Listings with zero matches are simply absent from the result — the service then adds a score of `0` for those.

The score is not a percentage — it is a raw match count. Turning it into a percentage would require knowing the total number of preferences on each listing, which requires an additional query. The raw count is more useful for ranking purposes: a listing with 5 out of 7 preferences matched is clearly better than a listing with 3 out of 3 matched, even though the second has a higher "percentage." The frontend can choose how to display it.

The score is appended to each listing object in the service after the compatibility query returns: `listings.map(l => ({ ...l, compatibilityScore: scoreMap[l.listing_id] ?? 0 }))`. It is never written to the database — it is always computed fresh so preference updates immediately affect search results.

### The Search Response Shape

This is the most important contract decision in Phase 2, because Phase 3 will embed listing data in notification payloads. Two shapes must be designed now and kept stable: the listing summary (used in search results, saved listings feed) and the listing detail (single listing GET).

The **listing summary** includes: `listing_id`, `listing_type`, `title`, `city`, `locality`, `rent_per_month` (in rupees), `room_type`, `preferred_gender`, `available_from`, `status`, `cover_photo_url` (a single URL from `listing_photos WHERE is_cover = TRUE LIMIT 1`, or null), `average_rating` (the poster's `users.average_rating` for student listings, or the property's `properties.average_rating` for PG listings), `compatibility_score`, and for PG listings, `property_name`. This is lean enough for a search result card without over-fetching.

The `cover_photo_url` in search results comes from a subquery in the listing SELECT: `(SELECT photo_url FROM listing_photos WHERE listing_id = l.listing_id AND is_cover = TRUE AND deleted_at IS NULL LIMIT 1) AS cover_photo_url`. This avoids a JOIN that would require a GROUP BY on all selected columns.

The **listing detail** includes everything in the summary plus: `description`, `deposit_amount`, `bed_type`, `total_capacity`, `current_occupants`, `is_negotiable`, `rent_includes_utilities`, `available_until`, `house_rules` (inherited from the parent property for PG listings, or null for student listings), full amenity objects, all listing preferences, all photos (not just cover), poster's public profile info (name, average_rating, rating_count), and for PG listings, the full parent property object.

### Pagination

Search uses keyset pagination, consistent with the verification queue and property list. The cursor for search is `(created_at, listing_id)`, ordered newest-first. This is appropriate because students generally want to see recently posted listings first — a listing posted today is more likely to still be available than one posted 30 days ago. The `limit + 1` trick applies here too.

The total count is never returned. A `COUNT(*)` on `listings` filtered by search criteria is expensive — it requires scanning all rows that match the filter before the index can reduce the result set. The `LIMIT` clause prevents this scan from happening on the data fetch, but a separate COUNT query for "1,247 results found" cannot use the same optimization. For the current phase, the count is omitted. The frontend shows "Load more" rather than "Page 3 of 47."

---

## Part 3 — Listing Preferences (Standalone Endpoint)

Preferences can be set at listing creation or managed independently via their own endpoints. The standalone endpoints are `PUT /listings/:listingId/preferences` (full replace — same semantics as amenityIds in property update) and `GET /listings/:listingId/preferences`.

The PUT endpoint's authorization: only the listing poster can update preferences. The check is the same ownership-in-WHERE pattern: `WHERE listing_id = $1 AND posted_by = $2`. The GET endpoint is world-readable by any authenticated user, since preferences are part of the public listing information.

The UNIQUE constraint on `(listing_id, preference_key)` in the schema means the full-replace approach (DELETE + INSERT in a transaction) is the correct implementation — trying to implement a patch approach would require diffing the existing preference set against the new one, which is more complex and offers no benefit over full replace for a small set of key-value pairs.

---

## Part 4 — Saved Listings

Two endpoints: `POST /listings/:listingId/save` and `DELETE /listings/:listingId/save`, and one read endpoint: `GET /users/me/saved-listings`.

The save operation uses `INSERT INTO saved_listings (user_id, listing_id) ON CONFLICT (user_id, listing_id) DO NOTHING`. A student who saves the same listing twice gets a 200 both times. This is the idempotent bookmark pattern — the client never needs to track whether something is already saved.

The unsave operation is not a DELETE from the table — it is a soft-delete (setting `deleted_at = NOW()`). The re-save case requires handling: if a row exists with `deleted_at IS NOT NULL`, a new save should clear `deleted_at` rather than hitting the composite PK conflict. The correct SQL for this is `INSERT INTO saved_listings (user_id, listing_id, saved_at) VALUES ($1, $2, NOW()) ON CONFLICT (user_id, listing_id) DO UPDATE SET deleted_at = NULL, saved_at = NOW()`. This single UPSERT handles both the fresh save and the re-save-after-unsave case atomically.

The feed endpoint `GET /users/me/saved-listings` JOINs `saved_listings` to `listings` filtering `listings.status = 'active' AND listings.deleted_at IS NULL AND saved_listings.deleted_at IS NULL`. Listings that have expired, been filled, or been deactivated since the user saved them are silently omitted. The client never receives an error about a stale save — the listing simply disappears from the feed. This simplifies the client significantly.

Pagination for the saved feed uses the keyset cursor on `(saved_at, listing_id)` to page through results in reverse-chronological order (most recently saved first). The response shape for each item in the saved feed uses the listing summary shape defined in search — the same structure, no special saved-only fields.

---

## Routes Summary

The listing router mounts at `/api/v1/listings`. The ownership and role logic at the route level reflects the two-actor model:

`POST /` requires `authenticate` and the user must be either `pg_owner` or `student` (i.e., any authenticated user with a valid role). The authorization check at route level is just `authenticate` — the service layer enforces the specific branching (verified PG owner for PG listings, any student for student listings).

`GET /` is the search endpoint. `authenticate` only — any authenticated user can search. No role restriction.

`GET /:listingId` is world-readable by any authenticated user.

`PUT /:listingId` requires `authenticate` only — the ownership check is in the service (WHERE posted_by = userId). No `authorize('pg_owner')` because both PG owners and students have listings they can update.

`DELETE /:listingId` requires `authenticate` only, same reasoning.

`PUT /:listingId/preferences` and `GET /:listingId/preferences` follow the same pattern — authenticate only, ownership enforced in the service.

`POST /:listingId/save` and `DELETE /:listingId/save` require `authenticate` and conceptually the user should be a student (only students save listings), but enforcing this as a role check at the route level is fine — `authorize('student')`. A PG owner saving a listing has no product meaning.

`GET /users/me/saved-listings` is a special case: the URL suggests it belongs on a `/users` router, but it is listing-domain data. It can live on either router. The cleaner choice is `/api/v1/listings/me/saved` which keeps all listing-related reads on the listing router and avoids having listing queries in a user router. The implementation guide should note this explicitly so the route registration is intentional.

---

## Cross-Cutting Concerns

### The Two-Actor Ownership Model

Phase 1 ownership was simple: your profile is yours. Phase 2 introduces a more complex pattern: a PG owner can own multiple properties, each property can have multiple listings, and each listing must verify ownership through its parent property chain. The service must never trust the client to self-declare ownership — it always derives ownership from the database.

The anti-pattern to avoid is passing `ownerId` as a parameter and trusting it without a database check. The correct pattern is always `WHERE listing_id = $1 AND posted_by = $2` (or `property_id = $1 AND owner_id = $2` for property-level operations), where `$2` is always `req.user.userId` from the JWT — never from the request body.

### View Count

The `views_count` column on listings should be incremented on every `GET /:listingId` request. The correct way to do this is an asynchronous fire-and-forget update: `pool.query('UPDATE listings SET views_count = views_count + 1 WHERE listing_id = $1', [listingId])` called after the response is sent, not awaited. Awaiting it would add unnecessary latency to every listing view. The `pool.query` call returns a promise — the service fires it without awaiting it or catching its rejection in the critical path. If the increment fails (extremely rare, and not user-visible), it fails silently. View counts are analytics data, not transactional data.

### The Import Path for `assertOwnerVerified`

As noted above, `assertOwnerVerified` currently lives in `property.service.js` as a private (non-exported) function. The listing service also needs to call it for PG listing creation. The correct resolution: extract the verification check into `src/db/utils/pgOwner.js` as a named exported function `assertPgOwnerVerified(userId, client = pool)`. Both the property service and the listing service import it from there. This avoids circular imports and puts the query in the right location — `db/utils/` is where stable, reused queries live, exactly as the project conventions define.

### Index Awareness Summary

The search query will exercise these indexes: `idx_listings_city_status` (city + status filter), `idx_listings_rent` (rent range filter), `idx_listings_location` GiST (proximity via `ST_DWithin`), `idx_listings_available_from` (available_from filter), `idx_listing_amenities_amenity_id` (amenity existence subqueries), `idx_user_preferences_key_value` (compatibility JOIN), `idx_listing_preferences_key_value` (compatibility JOIN). Writing the search query as a single dynamic parameterised WHERE clause ensures the query planner sees one query and can use bitmap index scans or index intersection across multiple indexes. Splitting into multiple queries and merging results in JavaScript would lose this optimization entirely.

---

## Branch Completion Criteria

Before merging this branch: a student can search for listings by city and get results with compatibility scores and cover photo URLs. A verified PG owner can create a PG room listing under one of their properties and it appears in search results. A student can create a student room listing and it also appears in search results. Preference filtering works — a search for WiFi only returns listings with WiFi in `listing_amenities`. Proximity search works — providing coordinates and a radius filters results correctly. A student can save and unsave a listing and see their saved listings in the feed. The paise arithmetic is correct — a listing created with Rs 8,500 rent is stored as 850000 and returned as 8500. Soft-delete blocks when open interest requests exist. The health check still returns 200.

---

*— Document complete. Ready to build in dependency order: listing CRUD → preferences → search → saved —*