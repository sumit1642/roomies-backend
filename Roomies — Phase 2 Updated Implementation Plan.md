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
