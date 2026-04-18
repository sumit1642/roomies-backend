-- =============================================================================
-- ROOMIES — DATABASE SCHEMA SETUP SCRIPT (REWRITTEN & CONSOLIDATED)
--
-- How to run:
--   Step 1: sudo -u postgres psql
--   Step 2: CREATE DATABASE roomies_db WITH ENCODING='UTF8' TEMPLATE=template0;
--   Step 3: \c roomies_db
--   Step 4: Run this entire script
--
-- Safe to re-run — every CREATE uses IF NOT EXISTS and every function/trigger
-- uses CREATE OR REPLACE, making every statement fully idempotent.
--
-- All later migrations (Phase 3 schema changes) have been folded into their
-- original table and type definitions. There are no ALTER TYPE or ALTER TABLE
-- statements anywhere in this file — every type and table is already in its
-- final, up-to-date state.
-- =============================================================================

-- =============================================================================
-- SECTION 1 — EXTENSIONS
--
-- PostgreSQL ships lean and lets you opt into extra capabilities via extensions,
-- similar to installing npm packages but at the database level. Extensions
-- persist permanently once installed; the IF NOT EXISTS clause makes these
-- safe to re-run without errors.
-- =============================================================================

-- PostGIS adds geographic column types (GEOMETRY, GEOGRAPHY) and a family of
-- spatial functions like ST_DWithin, ST_MakePoint, and ST_SetSRID. This is what
-- powers "find listings within 3km of my college" queries in listing.service.js.
-- Without this extension the `location GEOMETRY(POINT, 4326)` columns and all
-- proximity searches would be impossible.
CREATE EXTENSION IF NOT EXISTS postgis;

-- pgcrypto gives us gen_random_uuid(), which is used as the DEFAULT value on
-- every primary key column in every table. UUIDs as primary keys are preferable
-- to auto-incrementing integers because they do not reveal the total number of
-- rows in the table and cannot be guessed by an attacker incrementing a number.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- SECTION 2 — ENUMS
--
-- PostgreSQL enums are named types defined once and reused across multiple
-- tables. The database engine enforces the allowed values at the storage level,
-- meaning an application bug that passes an invalid status string will be
-- rejected by PostgreSQL itself before any data is written.
--
-- NOTE: Every enum here already includes all values added by later migrations.
-- For example, request_status_enum includes 'expired' and
-- notification_type_enum includes 'interest_request_withdrawn' — both of which
-- were originally added via ALTER TYPE in the Phase 3 migration. They are
-- folded here so the final schema is defined in one place.
-- =============================================================================

-- Tracks whether a user account is usable or has been actioned by an admin.
-- Used on users.account_status and checked by the authenticate middleware
-- (src/middleware/authenticate.js) via the INACTIVE_STATUSES constant before
-- issuing tokens or allowing access.
CREATE TYPE account_status_enum AS ENUM (
    'active', 'suspended', 'banned', 'deactivated'
);

-- The role a user plays on the platform. A single user can hold multiple roles
-- simultaneously (e.g. someone who is both a student AND a PG owner). Multiple
-- roles are handled via the user_roles junction table — this enum just names
-- the valid role strings that table can hold.
CREATE TYPE role_enum AS ENUM (
    'student', 'pg_owner', 'admin'
);

-- Used on both user profiles and listing preference fields for roommate matching.
-- Appears on student_profiles.gender, listings.preferred_gender, and
-- user_preferences when preference_key = 'gender_preference'.
CREATE TYPE gender_enum AS ENUM (
    'male', 'female', 'other', 'prefer_not_to_say'
);

-- Tracks where a PG owner is in the manual document verification workflow.
-- The state machine is: unverified → pending → verified (or rejected).
-- assertPgOwnerVerified() in src/db/utils/pgOwner.js checks this value before
-- allowing a PG owner to create or modify properties and listings.
CREATE TYPE verification_status_enum AS ENUM (
    'unverified', 'pending', 'verified', 'rejected'
);

-- Distinguishes whether a listing was posted by a student (student_room) or a
-- PG owner (pg_room, hostel_bed). This field drives the connection_type
-- derivation in interest.service.js when an interest request is accepted:
-- student_room → student_roommate, pg_room → pg_stay, hostel_bed → hostel_stay.
CREATE TYPE listing_type_enum AS ENUM (
    'student_room', 'pg_room', 'hostel_bed'
);

-- The physical layout of the room being offered. Shown on listing cards and
-- used as a filter in the search endpoint (listing.service.js searchListings).
CREATE TYPE room_type_enum AS ENUM (
    'single', 'double', 'triple', 'entire_flat'
);

-- The type of bed in the room. Particularly relevant for student room searches
-- where a student might be looking for a double bed in a shared room.
CREATE TYPE bed_type_enum AS ENUM (
    'single_bed', 'double_bed', 'bunk_bed'
);

-- The lifecycle state of a listing from creation to removal. The service layer
-- in listing.service.js enforces the allowed transition table:
--   active → filled | deactivated
--   deactivated → active
-- 'expired' is set exclusively by the listing expiry cron job (Phase 5).
-- 'filled' is a terminal state — a new listing must be created for a refilled room.
CREATE TYPE listing_status_enum AS ENUM (
    'active',       -- visible and accepting interest requests
    'filled',       -- room taken, no longer accepting requests, terminal state
    'expired',      -- auto-expired by cron after 60 days from creation
    'deactivated'   -- manually hidden by the poster, can be re-activated
);

-- The category of a PG owner's physical property building. Used to group
-- properties on the frontend and filter search results.
CREATE TYPE property_type_enum AS ENUM (
    'pg', 'hostel', 'shared_apartment'
);

-- The operational state of a property. An 'under_review' state is reserved for
-- admin workflows that require temporarily hiding a property from search results.
CREATE TYPE property_status_enum AS ENUM (
    'active', 'inactive', 'under_review'
);

-- The full lifecycle of an interest request from initial expression to final
-- resolution. The service enforces which transitions are actor-driven vs.
-- system-driven:
--   Actor-driven:  pending → accepted (by poster)
--                  pending → declined (by poster)
--                  pending → withdrawn (by sender/student)
--   System-driven: pending → expired (by expirePendingRequestsForListing
--                  when a listing is deactivated, deleted, or another request
--                  on the same listing is accepted)
-- The 'expired' status was originally added in the Phase 3 migration and is
-- now included directly here as the canonical definition.
CREATE TYPE request_status_enum AS ENUM (
    'pending', 'accepted', 'declined', 'withdrawn', 'expired'
);

-- Whether both parties have independently confirmed that the real-world
-- interaction happened. A rating can only be submitted once this reaches
-- 'confirmed'. This is the core trust mechanism — the NOT NULL FK on
-- ratings.connection_id plus this status check is what makes fake reviews
-- structurally impossible at the database level.
CREATE TYPE confirmation_status_enum AS ENUM (
    'pending', 'confirmed', 'denied', 'expired'
);

-- The nature of the real-world interaction recorded in a connections row.
-- This is derived from listing_type at the time an interest request is accepted,
-- using the LISTING_TYPE_TO_CONNECTION_TYPE map in interest.service.js. It
-- determines which rating dimension scores (cleanliness, value, etc.) are
-- shown by the frontend for a given review.
CREATE TYPE connection_type_enum AS ENUM (
    'student_roommate', -- two students lived together
    'pg_stay',          -- student stayed at a PG
    'hostel_stay',      -- student stayed in a hostel
    'visit_only'        -- student visited but did not stay
);

-- Who or what is being reviewed. A polymorphic discriminator used alongside
-- reviewee_id in the ratings table to point at either a users row or a
-- properties row. Because a standard FK cannot reference two tables, the
-- application layer (rating.service.js) validates existence in the correct
-- table before any INSERT is attempted.
CREATE TYPE reviewee_type_enum AS ENUM (
    'user', 'property'
);

-- Why a user flagged a rating for admin review. Stored on rating_reports and
-- shown to admins in the report queue view (report.service.js getReportQueue).
CREATE TYPE report_reason_enum AS ENUM (
    'fake', 'abusive', 'conflict_of_interest', 'other'
);

-- The outcome of an admin's review of a flagged rating. Both outcomes are
-- persisted — 'resolved_removed' hides the rating and triggers the
-- update_rating_aggregates DB trigger to recalculate averages automatically.
-- 'resolved_kept' closes the report without touching the rating.
CREATE TYPE report_status_enum AS ENUM (
    'open', 'resolved_removed', 'resolved_kept'
);

-- Every possible event type the notification system can fire. The BullMQ
-- notification worker (notificationWorker.js) maps each value to a human-
-- readable message string before inserting into the notifications table.
-- The 'interest_request_withdrawn' value was originally added in the Phase 3
-- migration and is now included here as the canonical definition.
CREATE TYPE notification_type_enum AS ENUM (
    'interest_request_received',
    'interest_request_accepted',
    'interest_request_declined',
    'interest_request_withdrawn',   -- fires when a student withdraws their own request
    'connection_confirmed',
    'connection_requested',
    'rating_received',
    'listing_expiring',
    'listing_expired',
    'listing_filled',
    'verification_approved',
    'verification_rejected',
    'new_message'
);

-- The kinds of documents a PG owner can upload to prove their identity and
-- property ownership. Used by submitDocumentSchema (verification.validators.js)
-- to validate the documentType field before inserting into verification_requests.
CREATE TYPE document_type_enum AS ENUM (
    'property_document', 'rental_agreement', 'owner_id', 'trade_license'
);

-- Groups amenities into visual sections on the frontend listing page.
-- The amenity seed (src/db/seeds/amenities.js) assigns a category to each
-- of the 19 seeded amenities; the frontend uses this to render groupings.
CREATE TYPE amenity_category_enum AS ENUM (
    'utility',  -- wifi, power backup, water supply
    'safety',   -- CCTV, security guard, gated entry
    'comfort'   -- AC, gym, common room, housekeeping
);

-- =============================================================================
-- SECTION 3 — SHARED TRIGGER FUNCTIONS
--
-- Trigger logic is placed in a reusable FUNCTION first. A TRIGGER then attaches
-- that function to a specific table event. One function can power triggers on
-- many tables — this avoids duplicating identical timestamp-update logic across
-- every table in the schema. CREATE OR REPLACE safely overwrites on re-runs.
-- =============================================================================

-- Automatically stamps the updated_at column on every row UPDATE. The NEW
-- keyword refers to the incoming row data after the update is applied.
-- This function is attached to every table that has an updated_at column via
-- individual BEFORE UPDATE triggers created in each table's section below.
CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS
$$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Automatically computes the PostGIS GEOMETRY column from plain latitude and
-- longitude decimal numbers. Application code (listing.service.js,
-- property.service.js) only ever writes lat/lng decimals — this trigger derives
-- the spatial geometry automatically, ensuring the geometry column is always
-- in sync with the human-readable coordinates.
--
-- ST_MakePoint takes (longitude, latitude) — X axis first, then Y axis. This
-- is counter-intuitive because humans say "lat, lng" but PostGIS uses the
-- mathematical (x=lng, y=lat) convention. SRID 4326 is WGS84, the coordinate
-- system used by GPS receivers, Google Maps, and the GEOMETRY columns in
-- properties and listings.
CREATE OR REPLACE FUNCTION sync_location_geometry()
    RETURNS TRIGGER AS
$$
BEGIN
    IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
        NEW.location = ST_SetSRID(
            ST_MakePoint(NEW.longitude, NEW.latitude),
            4326  -- WGS84: the coordinate system used by GPS and Google Maps
        );
    ELSE
        NEW.location = NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- ZONE 1 — IDENTITY ZONE
--
-- Answers: who is this person and how much do we trust them?
-- Every table in every other zone has a foreign key that ultimately traces back
-- to users.user_id. This zone is created first because every other zone depends
-- on it.
--
-- Creation order within this zone:
--   institutions → users → user_roles → profile tables → preferences
-- =============================================================================

-- -----------------------------------------------------------------------------
-- TABLE: institutions
--
-- The verified college/university directory. When a student registers with an
-- email like priya@iitb.ac.in, the application extracts 'iitb.ac.in' and calls
-- findInstitutionByDomain() (src/db/utils/institutions.js). A match means
-- institution auto-verification happens instantly — is_email_verified is set to
-- TRUE and institution_id is written to student_profiles in the same transaction
-- — with no manual review required.
--
-- The table uses soft-deletion (deleted_at) so historical student records retain
-- their institution_id link even after an institution is removed. The partial
-- unique index below enforces uniqueness only among non-deleted rows.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS institutions
(
    institution_id UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    name           VARCHAR(255) NOT NULL,
    city           VARCHAR(100) NOT NULL,
    state          VARCHAR(100) NOT NULL,

-- The domain portion of a college email, e.g. 'iitb.ac.in'. No inline
-- UNIQUE here because the partial index below handles uniqueness better —
-- it allows a domain to be reused after the old institution is soft-deleted.
email_domain VARCHAR(100) NOT NULL,

-- VARCHAR instead of an enum because India has too many institution types
-- to enumerate at schema-definition time (deemed university, autonomous
-- college, IIT, NIT, IIIT, private university, etc.).
type VARCHAR(50),
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

-- NULL means the record is active. A non-NULL timestamp means the record
-- was soft-deleted at that point but is retained for historical integrity
-- (existing student_profiles still reference it via institution_id).
deleted_at TIMESTAMPTZ );

-- A partial unique index enforces uniqueness only on rows WHERE deleted_at IS NULL.
-- This allows the same email domain to be re-registered after the old institution
-- row is soft-deleted, which is the correct real-world behaviour.
-- findInstitutionByDomain() in src/db/utils/institutions.js uses a WHERE
-- deleted_at IS NULL clause that matches this predicate exactly, so PostgreSQL
-- uses an index scan rather than a sequential scan for every registration lookup.
CREATE UNIQUE INDEX IF NOT EXISTS idx_institutions_email_domain ON institutions (email_domain)
WHERE
    deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_institutions_updated_at
    BEFORE UPDATE ON institutions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- TABLE: users
--
-- The universal identity record. Every person on the platform — student,
-- PG owner, admin — has exactly one row here regardless of their role(s).
-- This table stores only what is universal: login credentials and top-level
-- account flags. Role-specific data lives in student_profiles and
-- pg_owner_profiles respectively.
--
-- average_rating and rating_count are denormalized caches kept up-to-date by
-- the update_rating_aggregates trigger (Zone 4). This means search queries
-- never need a live AVG() against the ratings table — the cached value is
-- always current and available with zero JOIN cost.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users
(
    user_id           UUID               PRIMARY KEY DEFAULT gen_random_uuid(),

-- Nullable because a user who signs in via Google OAuth for the first time
-- may not provide an email immediately. No inline UNIQUE — soft-deleted
-- users need to be able to re-register with the same email. See the partial
-- unique index below for how uniqueness is actually enforced.
email VARCHAR(255), phone VARCHAR(20),

-- NULL for OAuth-only users who have never set a password.
password_hash VARCHAR(255),

-- Stores the unique subject ID ('sub') from Google's OAuth system.
-- Used by findUserByGoogleId() in src/db/utils/auth.js during OAuth sign-in.
google_id VARCHAR(255),
account_status account_status_enum NOT NULL DEFAULT 'active',
is_email_verified BOOLEAN NOT NULL DEFAULT FALSE,
is_phone_verified BOOLEAN NOT NULL DEFAULT FALSE,

-- Denormalized rating aggregates updated by the update_rating_aggregates
-- trigger in Zone 4. Never written by application code directly.

average_rating    NUMERIC(3, 2)       NOT NULL DEFAULT 0.00,
    rating_count      INTEGER             NOT NULL DEFAULT 0,

    created_at        TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    deleted_at        TIMESTAMPTZ
);

-- Partial unique indexes covering only non-deleted, non-null rows. Multiple NULL
-- values are permitted simultaneously because in SQL NULL != NULL, so multiple
-- OAuth users without emails don't violate the index. Soft-deleted users also
-- don't block re-registration with the same email.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email)
WHERE
    email IS NOT NULL
    AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users (phone)
WHERE
    phone IS NOT NULL
    AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users (google_id)
WHERE
    google_id IS NOT NULL
    AND deleted_at IS NULL;

-- Used by the authenticate middleware when enforcing account_status checks.
-- Filtering on account_status in WHERE clauses hits this index rather than
-- scanning all users rows.
CREATE INDEX IF NOT EXISTS idx_users_account_status ON users (account_status)
WHERE
    deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- TABLE: user_roles
--
-- Maps users to their roles via a junction table. A junction table is used
-- (rather than a roles column on users) because the real edge case must be
-- handled: one person can simultaneously be both a student AND a PG owner.
-- Adding a second role is just an INSERT into this table.
--
-- The composite primary key (user_id + role_name) prevents duplicate role
-- assignments and PostgreSQL automatically creates an index on it, making
-- "what roles does user X have?" fast. The separate index on role_name alone
-- makes "give me all pg_owner users" (used by the admin panel) equally fast.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_roles (
    user_id UUID NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
    role_name role_enum NOT NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, role_name)
);

-- Supports admin queries like "show all users with the pg_owner role" and
-- authorization checks that need to enumerate role holders.
CREATE INDEX IF NOT EXISTS idx_user_roles_role_name ON user_roles (role_name);

-- -----------------------------------------------------------------------------
-- TABLE: student_profiles
--
-- Extends users with academic identity. The UNIQUE constraint on user_id
-- enforces the one-to-one relationship with users at the database level —
-- it is impossible to have two student_profiles rows for the same user_id.
--
-- Aadhaar note: the raw 12-digit Aadhaar number is never stored. The UIDAI API
-- returns a tokenized reference after OTP verification — that token is all we
-- store in aadhaar_reference. Storing raw Aadhaar numbers would be a UIDAI
-- compliance violation.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS student_profiles
(
    profile_id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

-- UNIQUE enforces the one-to-one relationship with users at the DB level.
user_id UUID NOT NULL UNIQUE REFERENCES users (user_id) ON DELETE RESTRICT,

-- ON DELETE SET NULL: if an institution is soft-deleted and eventually hard-
-- deleted, we null out this reference rather than cascading the delete to
-- the student's profile. Historical profiles survive institution removal.

institution_id      UUID        REFERENCES institutions (institution_id) ON DELETE SET NULL,

    full_name           VARCHAR(255) NOT NULL,
    date_of_birth       DATE,
    gender              gender_enum,
    profile_photo_url   TEXT,
    bio                 TEXT,
    course              VARCHAR(255),
    year_of_study       SMALLINT,

    is_aadhaar_verified BOOLEAN     NOT NULL DEFAULT FALSE,
    aadhaar_reference   VARCHAR(255) UNIQUE, -- UIDAI tokenized reference, never raw Aadhaar number

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ
);

-- Both indexes use partial WHERE deleted_at IS NULL so they only cover active
-- profiles, keeping the index small and matching query predicates exactly.
CREATE INDEX IF NOT EXISTS idx_student_profiles_user_id ON student_profiles (user_id)
WHERE
    deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_student_profiles_institution ON student_profiles (institution_id)
WHERE
    deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_student_profiles_updated_at
    BEFORE UPDATE ON student_profiles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- TABLE: pg_owner_profiles
--
-- Extends users with PG/hostel business identity. PG owners must submit
-- verification documents and wait for manual admin review before they can
-- create properties or listings.
--
-- The verification state machine enforced by this table:
--   unverified → pending (after submitting a document via submitDocument())
--   pending → verified   (after admin approveRequest())
--   pending → rejected   (after admin rejectRequest())
-- assertPgOwnerVerified() in src/db/utils/pgOwner.js throws 403 unless
-- verification_status = 'verified', blocking unverified owners from write
-- operations on properties and listings.
-- -----------------------------------------------------------------------------


CREATE TABLE IF NOT EXISTS pg_owner_profiles
(
    profile_id           UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              UUID                     NOT NULL UNIQUE REFERENCES users (user_id) ON DELETE RESTRICT,

    business_name        VARCHAR(255)             NOT NULL,
    owner_full_name      VARCHAR(255)             NOT NULL,
    business_description TEXT,

-- Public-facing contact number shown on listings. Deliberately separate
-- from the personal phone stored in users so PG owners control what is
-- publicly visible to students. Used to build the WhatsApp deep-link
-- (wa.me/91{phone}) returned when an interest request is accepted.

business_phone       VARCHAR(20),
    operating_since      SMALLINT,

    verification_status  verification_status_enum NOT NULL DEFAULT 'unverified',
    rejection_reason     TEXT,
    verified_at          TIMESTAMPTZ,
    verified_by          UUID                     REFERENCES users (user_id) ON DELETE SET NULL,

    created_at           TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
    deleted_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pg_owner_profiles_user_id ON pg_owner_profiles (user_id)
WHERE
    deleted_at IS NULL;

-- Admins query by verification_status constantly to work their review queue.
-- This index keeps getVerificationQueue() fast even when many PG owner profiles
-- exist.
CREATE INDEX IF NOT EXISTS idx_pg_owner_profiles_verification_status ON pg_owner_profiles (verification_status)
WHERE
    deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_pg_owner_profiles_updated_at
    BEFORE UPDATE ON pg_owner_profiles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- TABLE: user_preferences
--
-- Stores lifestyle preferences using the EAV (Entity-Attribute-Value) pattern.
-- Each row is one key-value preference pair for one user, e.g.:
--   user_id = 'abc...', preference_key = 'smoking', preference_value = 'non_smoker'
--
-- EAV is chosen here because adding a new preference type requires only an
-- INSERT, not an ALTER TABLE. This is the LEFT side of the compatibility scoring
-- JOIN used in scoreListingsForUser() (src/db/utils/compatibility.js), which
-- counts matching (key, value) pairs between a user's preferences and a
-- listing's preferences.
--
-- The UNIQUE constraint on (user_id, preference_key) enforces that a user can
-- only have one value per preference key at a time.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_preferences
(
    preference_id    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID        NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,

-- Example keys:   'smoking', 'food_habit', 'sleep_schedule', 'alcohol',
--                 'cleanliness_level', 'noise_tolerance', 'guest_policy'
preference_key VARCHAR(100) NOT NULL,

-- Example values: 'non_smoker', 'vegetarian', 'night_owl', 'early_bird',
--                 'okay', 'not_okay', '3' (for a 1-5 scale)

preference_value VARCHAR(100) NOT NULL,

    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_user_preference UNIQUE (user_id, preference_key)
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id ON user_preferences (user_id);

-- This composite index directly powers the compatibility JOIN. scoreListingsForUser()
-- joins user_preferences against listing_preferences on both preference_key AND
-- preference_value together. An index on the individual columns would not serve
-- this query as efficiently as this composite one.
CREATE INDEX IF NOT EXISTS idx_user_preferences_key_value ON user_preferences (
    preference_key,
    preference_value
);

CREATE OR REPLACE TRIGGER trg_user_preferences_updated_at
    BEFORE UPDATE ON user_preferences
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- TABLE: verification_requests
--
-- The document submission and admin review audit trail for PG owners.
-- Kept as a separate table (rather than columns on pg_owner_profiles) so the
-- complete history of every submission and every admin decision is always
-- preserved — submissions are never overwritten.
--
-- submitDocument() in verification.service.js inserts here and then updates
-- pg_owner_profiles.verification_status to 'pending' in the same transaction.
-- approveRequest() and rejectRequest() update this table and the profile in
-- the same transaction with AND status = 'pending' as a concurrency guard.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification_requests (
    request_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    user_id UUID NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
    document_type document_type_enum NOT NULL,
    document_url TEXT NOT NULL,
    status verification_status_enum NOT NULL DEFAULT 'pending',
    admin_notes TEXT,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ,
    reviewed_by UUID REFERENCES users (user_id) ON DELETE SET NULL,
    deleted_at TIMESTAMPTZ
);

-- Powers the admin verification queue: "show me all pending requests ordered
-- by oldest first" (oldest-first ordering is the anti-starvation guarantee —
-- new submissions never bury older ones). The composite index covers both the
-- WHERE status = 'pending' filter and the ORDER BY submitted_at ASC sort.
CREATE INDEX IF NOT EXISTS idx_verification_requests_status_submitted ON verification_requests (status, submitted_at)
WHERE
    deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_verification_requests_user_id ON verification_requests (user_id)
WHERE
    deleted_at IS NULL;

-- Database-level race-condition guard: at most one non-deleted pending request
-- per user may exist at a time, even if two concurrent HTTP requests arrive
-- simultaneously. PostgreSQL's unique index check is atomic and prevents both
-- from succeeding — one will get a 23505 unique-violation error.
CREATE UNIQUE INDEX IF NOT EXISTS uq_verification_requests_active_pending_per_user ON verification_requests (user_id)
WHERE
    deleted_at IS NULL
    AND status = 'pending';

-- =============================================================================
-- ZONE 2 — LISTINGS ZONE
--
-- Answers: what is being offered, by whom, and where?
-- Both student room postings (property_id IS NULL) and PG owner room postings
-- (property_id IS NOT NULL) live in the single `listings` table, distinguished
-- by whether property_id is populated. This avoids duplicating a near-identical
-- table structure for two similar content types.
--
-- Creation order: amenities → properties → junction tables → listings → children
-- =============================================================================

-- -----------------------------------------------------------------------------
-- TABLE: amenities
--
-- A master reference list of all possible amenities such as WiFi, AC, and CCTV.
-- Normalizing amenities into their own table (rather than storing them as an
-- array or JSON blob) means each amenity can be indexed, filtered, categorized,
-- and mapped to frontend icons independently. The seed script at
-- src/db/seeds/amenities.js populates 19 amenities across the three categories.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS amenities
(
    amenity_id UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
    name       VARCHAR(100)          NOT NULL UNIQUE,
    category   amenity_category_enum NOT NULL,

-- Stores a string like 'wifi' that maps to a Lucide React icon component
-- on the frontend. Keeping icon names in the DB means the frontend never
-- needs a hardcoded icon-name map — it reads the icon name from the API.

icon_name  VARCHAR(100),

    created_at TIMESTAMPTZ           NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ           NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE TRIGGER trg_amenities_updated_at
    BEFORE UPDATE ON amenities
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- TABLE: properties
--
-- The physical PG or hostel building record. Only verified PG owners create
-- these via assertPgOwnerVerified() + createProperty() in property.service.js.
-- A property is the parent; listings (individual rooms within it) are the
-- children. A property can have many listings.
--
-- The sync_location_geometry trigger automatically computes the PostGIS geometry
-- column from the latitude and longitude decimal columns. The geometry column
-- is used by ST_DWithin proximity queries in listing.service.js searchListings.
-- The lat/lng decimal columns are used for display in the UI.
--
-- average_rating and rating_count are denormalized caches updated automatically
-- by the update_rating_aggregates trigger in Zone 4. They are never written
-- directly by application code.
-- -----------------------------------------------------------------------------


CREATE TABLE IF NOT EXISTS properties
(
    property_id    UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id       UUID               NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,

    property_name  VARCHAR(255)       NOT NULL,
    description    TEXT,
    property_type  property_type_enum NOT NULL,

-- Address split into separate columns for independent filtering and indexing.
-- The city column is indexed to support property search by city.
address_line VARCHAR(500) NOT NULL,
city VARCHAR(100) NOT NULL,
locality VARCHAR(100),
landmark VARCHAR(255),
pincode VARCHAR(10),

-- Plain decimal lat/lng for display and map marker rendering.
latitude NUMERIC(10, 7), longitude NUMERIC(10, 7),

-- PostGIS geometry column used exclusively for spatial queries.
-- Auto-synced from latitude/longitude via the trigger below.
-- The GiST index on this column enables ST_DWithin proximity searches.
location GEOMETRY (POINT, 4326),
house_rules TEXT,
total_rooms SMALLINT,
status property_status_enum NOT NULL DEFAULT 'active',

-- Denormalized rating aggregates. Never written by application code —
-- updated automatically by update_rating_aggregates trigger.

average_rating NUMERIC(3, 2)      NOT NULL DEFAULT 0.00,
    rating_count   INTEGER            NOT NULL DEFAULT 0,

    created_at     TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
    deleted_at     TIMESTAMPTZ
);

-- GiST index is required by PostGIS for geometry columns. A regular B-Tree
-- index cannot index spatial data. This index enables fast ST_DWithin proximity
-- searches ("find properties within 3km") used in listing search.
CREATE INDEX IF NOT EXISTS idx_properties_location ON properties USING GIST (location)
WHERE
    deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_properties_city ON properties (city)
WHERE
    deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_properties_owner_id ON properties (owner_id)
WHERE
    deleted_at IS NULL;

-- Partial index covering only active, non-deleted properties. The WHERE
-- predicate matches the common access pattern for listing search results.
CREATE INDEX IF NOT EXISTS idx_properties_status ON properties (status)
WHERE
    status = 'active'
    AND deleted_at IS NULL;

-- Fires only when latitude or longitude changes, computing the derived geometry.
-- Restricting the trigger to UPDATE OF latitude, longitude prevents it from
-- firing unnecessarily on every other column update.
CREATE OR REPLACE TRIGGER trg_properties_sync_location
    BEFORE INSERT OR UPDATE OF latitude, longitude ON properties
    FOR EACH ROW EXECUTE FUNCTION sync_location_geometry();

CREATE OR REPLACE TRIGGER trg_properties_updated_at
    BEFORE UPDATE ON properties
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- TABLE: property_amenities
--
-- Junction table implementing the many-to-many relationship between properties
-- and amenities. A property can have many amenities; an amenity can belong to
-- many properties.
--
-- ON DELETE CASCADE for property_id: if a property is deleted, its amenity links
-- are automatically removed. ON DELETE RESTRICT for amenity_id: prevents deleting
-- a master amenity that is still referenced by at least one property.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS property_amenities (
    property_id UUID NOT NULL REFERENCES properties (property_id) ON DELETE CASCADE,
    amenity_id UUID NOT NULL REFERENCES amenities (amenity_id) ON DELETE RESTRICT,
    PRIMARY KEY (property_id, amenity_id)
);

-- The primary key index covers "what amenities does this property have?".
-- This additional reverse index covers "which properties have WiFi?" — the query
-- pattern used when filtering search results by amenity.
CREATE INDEX IF NOT EXISTS idx_property_amenities_amenity_id ON property_amenities (amenity_id);

-- -----------------------------------------------------------------------------
-- TABLE: listings
--
-- The most important table in the schema and the most queried. It serves both
-- student postings (property_id IS NULL) and PG owner room postings
-- (property_id IS NOT NULL) via a single nullable foreign key.
--
-- THE PAISE RULE: rent_per_month and deposit_amount are stored in PAISE
-- (smallest INR unit, where 1 rupee = 100 paise). Rs 8,500/month is stored as
-- 850000. The conversion happens ONLY in listing.service.js:
--   write path: rupees × 100 before INSERT or UPDATE
--   read path:  paise ÷ 100 before returning to caller
-- This eliminates floating-point arithmetic bugs entirely.
--
-- expires_at is set server-side to NOW() + INTERVAL '60 days' at creation.
-- It is never accepted from the request body. The Phase 5 cron job
-- (listingExpiry) bulk-updates listings where expires_at < NOW() to 'expired'.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS listings
(
    listing_id              UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
    posted_by               UUID              NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,

-- NULL = student listing. UUID = PG owner's room under a property.
-- This single nullable FK is what allows one table to serve two content types.
property_id UUID REFERENCES properties (property_id) ON DELETE RESTRICT,
listing_type listing_type_enum NOT NULL,
title VARCHAR(255) NOT NULL,
description TEXT,

-- Stored in PAISE (see THE PAISE RULE above). Divide by 100 before display.
rent_per_month INTEGER NOT NULL,
deposit_amount INTEGER NOT NULL DEFAULT 0,
rent_includes_utilities BOOLEAN NOT NULL DEFAULT FALSE,
is_negotiable BOOLEAN NOT NULL DEFAULT FALSE,
room_type room_type_enum NOT NULL,
bed_type bed_type_enum,
total_capacity SMALLINT NOT NULL DEFAULT 1,
current_occupants SMALLINT NOT NULL DEFAULT 0,

-- Database-level constraint that prevents current_occupants from ever
-- exceeding total_capacity regardless of application bugs.
CONSTRAINT chk_occupancy CHECK (
    current_occupants <= total_capacity
),
preferred_gender gender_enum,
available_from DATE NOT NULL,
available_until DATE,

-- Address fields only populated for student listings (listing_type = 'student_room').
-- PG listings inherit their location from their parent property row.
address_line VARCHAR(500),
city VARCHAR(100) NOT NULL,
locality VARCHAR(100),
landmark VARCHAR(255),
pincode VARCHAR(10),

-- lat/lng for student listings only. Geometry auto-synced by trigger.
latitude NUMERIC(10, 7),
longitude NUMERIC(10, 7),
location GEOMETRY (POINT, 4326),
status listing_status_enum NOT NULL DEFAULT 'active',
views_count INTEGER NOT NULL DEFAULT 0,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

-- Set to NOW() + INTERVAL '60 days' at INSERT time (never from the request body).
-- The cron job transitions listings where expires_at < NOW() to 'expired'.
expires_at              TIMESTAMPTZ,
    filled_at               TIMESTAMPTZ,
    deleted_at              TIMESTAMPTZ
);

-- Spatial index for proximity searches. Mirrors the same GiST index on
-- properties. The COALESCE(l.location, p.location) pattern in searchListings
-- means a student listing uses its own geometry while a PG listing inherits
-- the geometry from its parent property.
CREATE INDEX IF NOT EXISTS idx_listings_location ON listings USING GIST (location)
WHERE
    deleted_at IS NULL;

-- Composite index on (city, status) because nearly every search query filters
-- on both simultaneously. Partial index covers only active, non-deleted rows.
CREATE INDEX IF NOT EXISTS idx_listings_city_status ON listings (city, status)
WHERE
    status = 'active'
    AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_listings_rent ON listings (rent_per_month)
WHERE
    status = 'active'
    AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_listings_posted_by ON listings (posted_by)
WHERE
    deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_listings_property_id ON listings (property_id)
WHERE
    deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_listings_available_from ON listings (available_from)
WHERE
    status = 'active'
    AND deleted_at IS NULL;

-- Case-insensitive city prefix search index. searchListings in listing.service.js
-- uses LOWER(l.city) LIKE LOWER($n) || '%' to perform prefix matching. A regular
-- B-Tree or varchar_pattern_ops index cannot serve ILIKE queries. This functional
-- index on LOWER(city) matches the query's expression exactly, enabling a fast
-- B-Tree prefix scan (O(log N)) instead of a sequential scan (O(N)).
--
-- The partial WHERE predicate mirrors the query's status and deleted_at filters,
-- keeping the index small and ensuring the planner uses it for active-listing
-- searches. LOWER() is an immutable function, so PostgreSQL allows indexing it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_city_lower ON listings (LOWER(city))
WHERE
    status = 'active'
    AND deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_listings_sync_location
    BEFORE INSERT OR UPDATE OF latitude, longitude ON listings
    FOR EACH ROW EXECUTE FUNCTION sync_location_geometry();

CREATE OR REPLACE TRIGGER trg_listings_updated_at
    BEFORE UPDATE ON listings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- TABLE: listing_photos
--
-- Stores multiple photos per listing with one designated as the cover image
-- (the first photo shown on search result cards). The partial unique index
-- enforces at most one cover photo per listing at the database level —
-- a constraint that cannot be expressed with a standard UNIQUE clause.
--
-- During async photo processing, photo_url is set to a placeholder sentinel
-- 'processing:{photoId}'. The media processing worker (mediaProcessor.js)
-- replaces this with the final WebP URL after Sharp compression. Queries in
-- photo.service.js filter out placeholder rows with AND photo_url NOT LIKE
-- 'processing:%' to avoid serving unprocessed photo URLs to clients.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS listing_photos
(
    photo_id      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id    UUID        NOT NULL REFERENCES listings (listing_id) ON DELETE CASCADE,

-- Either the final storage URL or the 'processing:{photoId}' sentinel.
photo_url     TEXT        NOT NULL,
    is_cover      BOOLEAN     NOT NULL DEFAULT FALSE,
    display_order SMALLINT    NOT NULL DEFAULT 0,
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_listing_photos_listing_id ON listing_photos (listing_id)
WHERE
    deleted_at IS NULL;

-- Partial unique index: uniqueness is enforced only among rows where is_cover IS
-- TRUE AND deleted_at IS NULL. This is the correct way to express "at most one
-- cover photo per listing" — a standard UNIQUE constraint on (listing_id,
-- is_cover) would only allow one TRUE row AND one FALSE row, which is wrong.
CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_photos_one_cover ON listing_photos (listing_id)
WHERE
    is_cover = TRUE
    AND deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- TABLE: listing_preferences
--
-- The mirror image of user_preferences. Describes what kind of roommate or
-- tenant the listing poster WANTS. The compatibility score that appears on
-- search results is computed by counting matching (preference_key, preference_value)
-- pairs between this table and user_preferences, via a JOIN in
-- scoreListingsForUser() (src/db/utils/compatibility.js).
--
-- The UNIQUE constraint on (listing_id, preference_key) enforces one value per
-- preference key per listing — the same EAV contract as user_preferences.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS listing_preferences (
    preference_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    listing_id UUID NOT NULL REFERENCES listings (listing_id) ON DELETE CASCADE,
    preference_key VARCHAR(100) NOT NULL,
    preference_value VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_listing_preference UNIQUE (listing_id, preference_key)
);

CREATE INDEX IF NOT EXISTS idx_listing_preferences_listing_id ON listing_preferences (listing_id);

-- Mirrors idx_user_preferences_key_value. Both indexes are required for the
-- compatibility JOIN to be fast on both sides of the join condition.
CREATE INDEX IF NOT EXISTS idx_listing_preferences_key_value ON listing_preferences (
    preference_key,
    preference_value
);

CREATE OR REPLACE TRIGGER trg_listing_preferences_updated_at
    BEFORE UPDATE ON listing_preferences
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- TABLE: listing_amenities
--
-- Room-level amenities — a specific room within a PG might have AC or an
-- attached bathroom even when other rooms in the same property do not. This
-- is intentionally separate from property_amenities, which covers building-wide
-- facilities that all rooms share (e.g. CCTV, security guard).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS listing_amenities (
    listing_id UUID NOT NULL REFERENCES listings (listing_id) ON DELETE CASCADE,
    amenity_id UUID NOT NULL REFERENCES amenities (amenity_id) ON DELETE RESTRICT,
    PRIMARY KEY (listing_id, amenity_id)
);

-- Reverse index for "which listings have WiFi?" — the query pattern used in
-- the amenity filter portion of searchListings.
CREATE INDEX IF NOT EXISTS idx_listing_amenities_amenity_id ON listing_amenities (amenity_id);

-- -----------------------------------------------------------------------------
-- TABLE: saved_listings
--
-- The bookmark/shortlist feature. Students can save listings they are interested
-- in for later review. saveListing() in listing.service.js uses an
-- ON CONFLICT DO UPDATE pattern for idempotent re-saves: if a student re-saves
-- a listing they previously unsaved (soft-deleted), the deleted_at column is
-- cleared rather than inserting a duplicate row.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saved_listings (
    user_id UUID NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
    listing_id UUID NOT NULL REFERENCES listings (listing_id) ON DELETE CASCADE,
    saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, listing_id)
);

-- Forward lookup: "show me all listings I have saved" — powers getSavedListings().
CREATE INDEX IF NOT EXISTS idx_saved_listings_user_id ON saved_listings (user_id)
WHERE
    deleted_at IS NULL;

-- Reverse lookup: "how many users saved this listing?" — used for poster analytics.
CREATE INDEX IF NOT EXISTS idx_saved_listings_listing_id ON saved_listings (listing_id)
WHERE
    deleted_at IS NULL;

-- =============================================================================
-- ZONE 3 — INTERACTION ZONE
--
-- Answers: how do two strangers go from expressing interest to a confirmed
-- real-world interaction?
--
-- Three sequential stages:
--   1. interest_requests — intent (student taps "I'm interested")
--   2. connections       — proof (both parties confirm the interaction happened)
--   3. notifications     — awareness (each party is informed of state changes)
--
-- The connections table is the most architecturally significant table in this
-- zone. A rating cannot be INSERT-ed without a valid confirmed connection_id
-- because the NOT NULL FK on ratings.connection_id is enforced by PostgreSQL
-- itself — fake reviews are structurally impossible at the database level,
-- regardless of application bugs.
--
-- Creation order: interest_requests → connections → notifications
-- =============================================================================

-- -----------------------------------------------------------------------------
-- TABLE: interest_requests
--
-- Created when a student taps "I'm interested" on a listing. The state machine
-- has five states (described on request_status_enum above). The 'accepted'
-- transition is handled atomically by _acceptInterestRequest() in
-- interest.service.js, which in a single BEGIN/COMMIT block:
--   1. Updates the interest_request status to 'accepted'
--   2. INSERTs a new connections row
--   3. Calls expirePendingRequestsForListing() for all other pending requests
--
-- The partial unique index below prevents a student from having more than one
-- active (pending or accepted) request per listing, while still allowing
-- re-application after a decline, withdrawal, or system-driven expiration.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS interest_requests
(
    request_id UUID                NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),

-- The student who saw the listing and expressed interest.
sender_id UUID NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,

-- The listing they expressed interest in.
listing_id UUID NOT NULL REFERENCES listings (listing_id) ON DELETE CASCADE,

-- Optional intro message from the student to the poster.

message    TEXT,

    status     request_status_enum NOT NULL DEFAULT 'pending',

    created_at TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- Prevents a student from spamming a listing with multiple concurrent interest
-- requests. Only covers rows where status IN ('pending', 'accepted'), so expired,
-- declined, and withdrawn requests do not block future re-applications.
CREATE UNIQUE INDEX IF NOT EXISTS idx_interest_requests_no_duplicates ON interest_requests (sender_id, listing_id)
WHERE
    status IN ('pending', 'accepted')
    AND deleted_at IS NULL;

-- Powers "all requests for this listing" on the poster's dashboard. Composite
-- with status so the poster can filter by pending/accepted/declined efficiently.
CREATE INDEX IF NOT EXISTS idx_interest_requests_listing_id ON interest_requests (listing_id, status)
WHERE
    deleted_at IS NULL;

-- Powers "all requests I have sent" on the student's dashboard.
CREATE INDEX IF NOT EXISTS idx_interest_requests_sender_id ON interest_requests (sender_id, status)
WHERE
    deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_interest_requests_updated_at
    BEFORE UPDATE ON interest_requests
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- TABLE: connections
--
-- The trust anchor of the entire platform. A connection row is created only
-- after an interest request is accepted. Its confirmation_status only reaches
-- 'confirmed' after BOTH initiator_confirmed and counterpart_confirmed are
-- independently set to TRUE by each party, via the atomic single-UPDATE pattern
-- in connection.service.js confirmConnection().
--
-- connection_type determines which rating dimension scores are meaningful when
-- Zone 4 ratings are submitted for this connection.
--
-- interest_request_id is a nullable FK added here (originally introduced in the
-- Phase 3 migration as ALTER TABLE connections ADD COLUMN). It is included
-- directly in this CREATE TABLE definition as the authoritative schema. The
-- column is nullable because admin-created connections have no originating
-- interest request, and any pre-existing connections from before this was
-- introduced naturally have no value.
--
-- The unique index on interest_request_id (below) is the structural guarantee
-- that no two connections rows can reference the same interest request. This
-- complements the application-layer row lock used in _acceptInterestRequest().
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connections
(
    connection_id         UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),

-- For student_roommate: initiator = whoever sent the interest request.
-- For pg_stay: initiator = student, counterpart = PG owner.
initiator_id UUID NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
counterpart_id UUID NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,

-- The listing that brought these two parties together. Nullable for
-- admin-created connections. ON DELETE SET NULL preserves the connection
-- row (which is the primary trust record) even if the listing is hard-deleted.
listing_id UUID REFERENCES listings (listing_id) ON DELETE SET NULL,

-- Direct FK back to the interest request that triggered this connection.
-- Nullable for admin-created connections and for legacy rows that predate
-- this column. ON DELETE SET NULL preserves the connection even if the
-- interest request is eventually hard-deleted by the Phase 5 cleanup cron.
interest_request_id UUID REFERENCES interest_requests (request_id) ON DELETE SET NULL,
connection_type connection_type_enum NOT NULL,

-- Actual dates of the real-world interaction. Used to add credibility context
-- to ratings — a 6-month stay is more credible signal than a 2-day visit.
start_date DATE, end_date DATE,

-- Each party independently flips their own boolean via confirmConnection().
-- When both are TRUE, confirmation_status is updated to 'confirmed' in the
-- same atomic UPDATE statement.

initiator_confirmed   BOOLEAN                  NOT NULL DEFAULT FALSE,
    counterpart_confirmed BOOLEAN                  NOT NULL DEFAULT FALSE,

    confirmation_status   confirmation_status_enum NOT NULL DEFAULT 'pending',
    denial_reason         TEXT,

    created_at            TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
    deleted_at            TIMESTAMPTZ
);

-- Powers the rating eligibility gate query: "does a confirmed connection exist
-- between these two users?" Composite with confirmation_status to serve the
-- WHERE EXISTS check in submitRating() without a separate lookup.
CREATE INDEX IF NOT EXISTS idx_connections_initiator_id ON connections (
    initiator_id,
    confirmation_status
)
WHERE
    deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_connections_counterpart_id ON connections (
    counterpart_id,
    confirmation_status
)
WHERE
    deleted_at IS NULL;

-- Powers "all connections related to a specific listing" for analytics and
-- admin views.
CREATE INDEX IF NOT EXISTS idx_connections_listing_id ON connections (listing_id)
WHERE
    deleted_at IS NULL;

-- Unique partial index on interest_request_id: enforces that at most one live
-- (not soft-deleted) connections row can reference the same interest_request.
-- This is defence-in-depth alongside the application-layer FOR UPDATE row lock
-- in _acceptInterestRequest(). NULL values are excluded by the partial predicate
-- because admin-created connections have no originating request and should not
-- conflict with each other.
--
-- The CONCURRENTLY form avoids an AccessExclusiveLock on a live production table.
-- For fresh installs and test environments (where the table is empty when this
-- runs), the non-concurrent form would also be fine, but CONCURRENTLY is always
-- safe and is the right habit.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_connections_interest_request_id ON connections (interest_request_id)
WHERE
    interest_request_id IS NOT NULL
    AND deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_connections_updated_at
    BEFORE UPDATE ON connections
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- TABLE: notifications
--
-- The in-app event feed. Rows are inserted exclusively by the BullMQ
-- notification worker (notificationWorker.js) with 5-attempt exponential
-- backoff, never directly by service-layer code. This decoupling means a
-- notification failure never rolls back a business state transition.
--
-- The polymorphic reference pattern (entity_type + entity_id) allows a single
-- pair of columns to describe what object the notification is about, without
-- requiring multiple nullable FK columns for each possible entity type. For
-- example, entity_type = 'interest_request' + entity_id = a UUID means the
-- consuming client can navigate directly to that interest request.
--
-- idempotency_key is the BullMQ job ID. The UNIQUE constraint on it means that
-- if a worker retries a job after crashing post-INSERT but pre-acknowledgement,
-- the ON CONFLICT DO NOTHING clause makes the retry a silent no-op.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications
(
    notification_id   UUID                      PRIMARY KEY DEFAULT gen_random_uuid(),

-- NULL allowed for system-generated notifications with no human actor.
actor_id UUID REFERENCES users (user_id) ON DELETE SET NULL,
recipient_id UUID NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
notification_type notification_type_enum NOT NULL,

-- Polymorphic reference: describes what object this notification is about.
-- entity_type = 'listing'          → entity_id points to listings.listing_id
-- entity_type = 'connection'       → entity_id points to connections.connection_id
-- entity_type = 'interest_request' → entity_id points to interest_requests.request_id
entity_type VARCHAR(50), entity_id UUID,

-- Human-readable message stored by the worker from NOTIFICATION_MESSAGES map.
-- Stored at insert time so the feed shows the message that was current when
-- the notification was created, even if templates change later.
message TEXT,

-- BullMQ job ID used to make worker retries idempotent via ON CONFLICT DO NOTHING.

idempotency_key   VARCHAR(100) UNIQUE,

    is_read           BOOLEAN                   NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ               NOT NULL DEFAULT NOW(),
    deleted_at        TIMESTAMPTZ
);

-- Primary query for the notification bell badge: all unread notifications for a
-- user, newest first. Partial index on is_read = FALSE keeps it small — once a
-- notification is marked read it falls out of this index, so it never grows
-- unboundedly regardless of total notification history size.
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_unread ON notifications (recipient_id, created_at DESC)
WHERE
    is_read = FALSE
    AND deleted_at IS NULL;

-- Covers the full notification history page (read + unread combined).
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_all ON notifications (recipient_id, created_at DESC)
WHERE
    deleted_at IS NULL;

-- =============================================================================
-- ZONE 4 — REPUTATION ZONE
--
-- Answers: what do people think of each other and the places they stayed?
--
-- Two tables:
--   1. ratings        — review record anchored to a confirmed connection
--   2. rating_reports — moderation queue for flagged reviews
--
-- Zone 4 writes back to earlier zones via the update_rating_aggregates trigger,
-- which updates users.average_rating (Zone 1) and properties.average_rating
-- (Zone 2) automatically after every rating INSERT or visibility change.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- TABLE: ratings
--
-- Each row is one party's review of either another user or a property, anchored
-- to a confirmed real-world connection. The NOT NULL FK on connection_id is the
-- entire anti-fake-review system: PostgreSQL physically rejects any INSERT that
-- does not reference an existing confirmed connection, regardless of application
-- bugs or API manipulation.
--
-- DIMENSION SCORES: Four nullable dimension scores (cleanliness, communication,
-- reliability, value) plus one required overall_score. Not every dimension
-- applies to every review type — a student rating a fellow roommate doesn't
-- need a 'value_score'. The frontend decides which dimensions to show based
-- on reviewee_type and connection_type.
--
-- POLYMORPHIC REVIEWEE: reviewee_type + reviewee_id together point at either
-- users or properties. The application layer (submitRating in rating.service.js)
-- validates that reviewee_id exists in the correct table before INSERTing —
-- a standard FK cannot enforce this across two tables simultaneously.
--
-- is_visible allows admin moderation without physical deletion. When set to
-- FALSE by resolveReport(), the update_rating_aggregates trigger fires
-- automatically and removes the rating from all cached averages.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ratings
(
    rating_id           UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
    reviewer_id         UUID              NOT NULL REFERENCES users       (user_id)       ON DELETE RESTRICT,

-- NOT NULL is the anti-fake-review system. No confirmed connection → no rating.
connection_id UUID NOT NULL REFERENCES connections (connection_id) ON DELETE RESTRICT,
reviewee_type reviewee_type_enum NOT NULL,
reviewee_id UUID NOT NULL, -- polymorphic: points to users or properties

-- Required — this is the value cached in average_rating via trigger.
overall_score SMALLINT NOT NULL CHECK (overall_score BETWEEN 1 AND 5),

-- Nullable — not every dimension applies to every review type.
cleanliness_score SMALLINT CHECK (
    cleanliness_score BETWEEN 1 AND 5
),
communication_score SMALLINT CHECK (
    communication_score BETWEEN 1 AND 5
),
reliability_score SMALLINT CHECK (
    reliability_score BETWEEN 1 AND 5
),
value_score SMALLINT CHECK (value_score BETWEEN 1 AND 5),
review_text TEXT,

-- Controls visibility for admin moderation. When FALSE, the rating does not
-- appear in public feeds and is excluded from the average_rating cache.
-- The row is preserved for audit history and report cross-references.

is_visible          BOOLEAN           NOT NULL DEFAULT TRUE,

    created_at          TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ
);

-- Prevents one reviewer from submitting two ratings for the same connection
-- against the same reviewee. submitRating() uses ON CONFLICT on this index
-- to handle duplicate submissions atomically rather than with a prior read.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ratings_one_per_connection ON ratings (
    reviewer_id,
    connection_id,
    reviewee_id
)
WHERE
    deleted_at IS NULL;

-- Powers "all reviews about this user/property" on their public profile page.
-- Composite with reviewee_type so queries for user reviews and property reviews
-- hit the same index efficiently.
CREATE INDEX IF NOT EXISTS idx_ratings_reviewee ON ratings (
    reviewee_id,
    reviewee_type,
    is_visible
)
WHERE
    deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ratings_reviewer_id ON ratings (reviewer_id)
WHERE
    deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_ratings_updated_at
    BEFORE UPDATE ON ratings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- TRIGGER FUNCTION: update_rating_aggregates
--
-- Fires AFTER INSERT or AFTER UPDATE OF overall_score, is_visible, deleted_at
-- on the ratings table. It recalculates average_rating and rating_count for
-- the affected reviewee and writes the result back to users or properties.
--
-- This is the Zone 4 → Zone 1/2 feedback loop. Without it, every search result
-- query would need a live AVG() across ratings, which would be extremely slow
-- at scale. With it, average_rating on users and properties is always up-to-date
-- and available at zero JOIN cost.
--
-- Application code NEVER manually writes to users.average_rating or
-- properties.average_rating. If a rating is hidden by an admin (is_visible set
-- to FALSE via resolveReport()), this trigger fires automatically and removes
-- it from the cached average — no extra application code needed.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_rating_aggregates()
    RETURNS TRIGGER AS
$$
DECLARE
    v_avg   NUMERIC(3, 2);
    v_count INTEGER;
BEGIN
    IF NEW.reviewee_type = 'user' THEN

        -- Recalculate considering only visible, non-deleted ratings.
        SELECT ROUND(AVG(overall_score)::NUMERIC, 2), COUNT(*)
        INTO v_avg, v_count
        FROM ratings
        WHERE reviewee_id   = NEW.reviewee_id
          AND reviewee_type = 'user'
          AND is_visible    = TRUE
          AND deleted_at    IS NULL;

        -- Write the result back to the users table in Zone 1.
        UPDATE users
        SET average_rating = COALESCE(v_avg, 0.00),
            rating_count   = v_count
        WHERE user_id = NEW.reviewee_id;

    ELSIF NEW.reviewee_type = 'property' THEN

        SELECT ROUND(AVG(overall_score)::NUMERIC, 2), COUNT(*)
        INTO v_avg, v_count
        FROM ratings
        WHERE reviewee_id   = NEW.reviewee_id
          AND reviewee_type = 'property'
          AND is_visible    = TRUE
          AND deleted_at    IS NULL;

        -- Write the result back to the properties table in Zone 2.
        UPDATE properties
        SET average_rating = COALESCE(v_avg, 0.00),
            rating_count   = v_count
        WHERE property_id = NEW.reviewee_id;

    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Fires only when overall_score, is_visible, or deleted_at changes —
-- not on every update. This prevents unnecessary aggregate recalculations
-- when unrelated columns like review_text are edited.
CREATE OR REPLACE TRIGGER trg_ratings_update_aggregates
    AFTER INSERT OR UPDATE OF overall_score, is_visible, deleted_at ON ratings
    FOR EACH ROW EXECUTE FUNCTION update_rating_aggregates();

-- -----------------------------------------------------------------------------
-- TABLE: rating_reports
--
-- The moderation queue for flagged ratings. Any party to the underlying
-- connection can file a report. Admin resolution outcomes:
--   resolved_removed: sets ratings.is_visible = FALSE, triggering the
--     update_rating_aggregates function to recalculate cached averages.
--   resolved_kept:    closes the report without touching the rating.
-- Both outcomes are preserved — historical report data informs future automated
-- flagging improvements.
--
-- The partial unique index prevents the same reporter from filing two open
-- reports against the same rating. A resolved report does not block re-reporting
-- (the index's WHERE predicate covers only status = 'open' rows).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rating_reports (
    report_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    reporter_id UUID NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
    rating_id UUID NOT NULL REFERENCES ratings (rating_id) ON DELETE RESTRICT,
    reason report_reason_enum NOT NULL,
    explanation TEXT,
    status report_status_enum NOT NULL DEFAULT 'open',
    admin_notes TEXT,
    reviewed_at TIMESTAMPTZ,
    reviewed_by UUID REFERENCES users (user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- Prevents the same user from filing duplicate open reports against the same
-- rating. Resolved reports (status != 'open') are excluded so re-reporting
-- after resolution is allowed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_rating_reports_no_duplicates ON rating_reports (reporter_id, rating_id)
WHERE
    status = 'open'
    AND deleted_at IS NULL;

-- Admin moderation queue: all open reports sorted oldest first (anti-starvation
-- pattern identical to the verification queue). Composite with created_at to
-- serve the ORDER BY clause efficiently.
CREATE INDEX IF NOT EXISTS idx_rating_reports_status_created ON rating_reports (status, created_at)
WHERE
    deleted_at IS NULL;

-- Powers "all reports filed against this rating" for the admin rating detail view.
CREATE INDEX IF NOT EXISTS idx_rating_reports_rating_id ON rating_reports (rating_id)
WHERE
    deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_rating_reports_updated_at
    BEFORE UPDATE ON rating_reports
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();