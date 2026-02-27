-- =============================================================================
-- ROOMIES — DATABASE SCHEMA SETUP SCRIPT
--
-- How to run:
--   Step 1: sudo -u postgres psql
--   Step 2: CREATE DATABASE roomies_db WITH ENCODING='UTF8' TEMPLATE=template0;
--   Step 3: \c roomies_db
--   Step 4: Run this entire script
--
-- Safe to re-run — CREATE IF NOT EXISTS and CREATE OR REPLACE make every
-- statement idempotent.
-- =============================================================================


-- =============================================================================
-- SECTION 1 — EXTENSIONS
-- PostgreSQL ships lean and lets you opt into extra capabilities via
-- extensions — similar to installing npm packages, but at the database level.
-- Once installed they persist permanently; IF NOT EXISTS makes this re-runnable.
-- =============================================================================

-- PostGIS adds geographic column types and spatial indexing.
-- This is what powers "find listings within 3km of my college" queries.
CREATE EXTENSION IF NOT EXISTS postgis;

-- pgcrypto gives us gen_random_uuid() which we use as the default value
-- for every primary key. UUIDs don't reveal how many rows exist and
-- can't be guessed by incrementing a number.
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- =============================================================================
-- SECTION 2 — ENUMS
-- PostgreSQL enums are named types defined once and reused across tables.
-- PostgreSQL enforces allowed values at the database level.
-- =============================================================================

-- Tracks whether a user account is usable or has been actioned by an admin.
CREATE TYPE account_status_enum AS ENUM (
    'active', 'suspended', 'banned', 'deactivated'
);

-- The role a user plays on the platform. A user can hold multiple roles
-- simultaneously (handled via the user_roles junction table, not this column).
CREATE TYPE role_enum AS ENUM (
    'student', 'pg_owner', 'admin'
);

-- Used on both user profiles and listing preferences for roommate matching.
CREATE TYPE gender_enum AS ENUM (
    'male', 'female', 'other', 'prefer_not_to_say'
);

-- Tracks where a PG owner is in the manual document verification workflow.
CREATE TYPE verification_status_enum AS ENUM (
    'unverified', 'pending', 'verified', 'rejected'
);

-- Distinguishes whether a listing was posted by a student or a PG owner.
CREATE TYPE listing_type_enum AS ENUM (
    'student_room', 'pg_room', 'hostel_bed'
);

-- The physical configuration of the room being offered.
CREATE TYPE room_type_enum AS ENUM (
    'single', 'double', 'triple', 'entire_flat'
);

-- The type of bed in the room — relevant for student roommate searches.
CREATE TYPE bed_type_enum AS ENUM (
    'single_bed', 'double_bed', 'bunk_bed'
);

-- The lifecycle state of a listing from creation to removal.
CREATE TYPE listing_status_enum AS ENUM (
    'active',       -- visible and accepting interest requests
    'filled',       -- room has been taken, no longer accepting requests
    'expired',      -- passed the auto-expiry date (60 days by default)
    'deactivated'   -- manually hidden by the poster
);

-- The category of a PG owner's physical property (the building itself).
CREATE TYPE property_type_enum AS ENUM (
    'pg', 'hostel', 'shared_apartment'
);

-- The operational state of a PG property.
CREATE TYPE property_status_enum AS ENUM (
    'active', 'inactive', 'under_review'
);

-- Tracks where an interest request is in its conversation lifecycle.
CREATE TYPE request_status_enum AS ENUM (
    'pending', 'accepted', 'declined', 'withdrawn'
);

-- The nature of the real-world interaction recorded in the connections table.
-- This is what determines rating eligibility.
CREATE TYPE connection_type_enum AS ENUM (
    'student_roommate',  -- two students lived together
    'pg_stay',           -- student stayed at a PG
    'hostel_stay',       -- student stayed in a hostel
    'visit_only'         -- student visited but did not stay
);

-- Whether both parties have confirmed that the real-world interaction happened.
-- A rating can only be submitted once this reaches 'confirmed'.
CREATE TYPE confirmation_status_enum AS ENUM (
    'pending', 'confirmed', 'denied', 'expired'
);

-- Who or what is being reviewed — a person (student) or a place (PG property).
CREATE TYPE reviewee_type_enum AS ENUM (
    'user', 'property'
);

-- Why a user flagged a rating for admin review.
CREATE TYPE report_reason_enum AS ENUM (
    'fake', 'abusive', 'conflict_of_interest', 'other'
);

-- The outcome of an admin's review of a flagged rating.
CREATE TYPE report_status_enum AS ENUM (
    'open', 'resolved_removed', 'resolved_kept'
);

-- Every possible event type the notification system can fire.
-- Adding a new notification type later:
-- ALTER TYPE notification_type_enum ADD VALUE 'new_event_name';
CREATE TYPE notification_type_enum AS ENUM (
    'interest_request_received',
    'interest_request_accepted',
    'interest_request_declined',
    'connection_confirmed',
    'connection_requested',
    'rating_received',
    'listing_expiring',
    'listing_filled',
    'verification_approved',
    'verification_rejected',
    'new_message'
);

-- The kinds of documents a PG owner can upload to prove their identity.
CREATE TYPE document_type_enum AS ENUM (
    'property_document', 'rental_agreement', 'owner_id', 'trade_license'
);

-- Groups amenities into visual sections on the frontend listing page.
CREATE TYPE amenity_category_enum AS ENUM (
    'utility',   -- wifi, power backup, water supply
    'safety',    -- CCTV, security guard, gated entry
    'comfort'    -- AC, gym, common room, housekeeping
);


-- =============================================================================
-- SECTION 3 — SHARED TRIGGER FUNCTIONS
-- Logic lives in a separate reusable FUNCTION first, then a TRIGGER attaches
-- that function to a specific table event. One function powers triggers on
-- all tables that need it — DRY at the DB level.
-- CREATE OR REPLACE safely overwrites itself on re-runs.
-- =============================================================================

-- Automatically stamps the updated_at column on every row UPDATE.
-- NEW refers to the incoming row data after the update.
CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Automatically computes the PostGIS geometry column from plain latitude and
-- longitude numbers. The app layer only ever writes lat/lng decimals — this
-- trigger derives the spatial geometry automatically.
-- ST_MakePoint takes (longitude, latitude) — X axis first, then Y axis.
CREATE OR REPLACE FUNCTION sync_location_geometry()
    RETURNS TRIGGER AS $$
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
-- Answers: who is this person and how much do we trust them?
-- Every table in every other zone has a foreign key that traces back here.
-- users holds only universal login data; separate profile tables extend it
-- with role-specific fields.
--
-- Creation order:
-- institutions → users → user_roles → profile tables → preferences
-- =============================================================================


-- -----------------------------------------------------------------------------
-- TABLE: institutions
-- The verified college/university directory. When a student registers with an
-- email like priya@iitb.ac.in, the app extracts 'iitb.ac.in' and looks it up
-- here. A match means institution auto-verification happens instantly without
-- any manual review — the email domain is the proof of enrollment.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS institutions
(
    institution_id UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    name           VARCHAR(255) NOT NULL,
    city           VARCHAR(100) NOT NULL,
    state          VARCHAR(100) NOT NULL,

    -- The domain portion of a college email, e.g. 'iitb.ac.in'.
    -- No inline UNIQUE here — see the partial index below for why.
    email_domain   VARCHAR(100) NOT NULL,

    -- VARCHAR instead of enum because India has too many institution
    -- types to enumerate: deemed university, autonomous college, IIT,
    -- NIT, IIIT, private university, etc.
    type           VARCHAR(50),

    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- NULL means the record is active. A timestamp means it was deleted
    -- at that point in time but the row is kept for historical integrity.
    deleted_at     TIMESTAMPTZ
);

-- A partial unique index only enforces uniqueness on rows WHERE deleted_at IS NULL.
-- A domain can be re-used after the old institution is soft-deleted — correct behavior.
CREATE UNIQUE INDEX IF NOT EXISTS idx_institutions_email_domain
    ON institutions (email_domain)
    WHERE deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_institutions_updated_at
    BEFORE UPDATE ON institutions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- TABLE: users
-- The universal identity record. Every person on the platform — student,
-- PG owner, admin — has exactly one row here regardless of their role.
-- This table stores only what is universal: credentials and top-level flags.
-- Role-specific data lives in student_profiles and pg_owner_profiles below.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users
(
    user_id           UUID                PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Nullable because a user who signs in via Google OAuth for the first time
    -- may not provide an email immediately. No inline UNIQUE — soft-deleted
    -- users should be able to re-register.
    email             VARCHAR(255),
    phone             VARCHAR(20),

    -- NULL for OAuth-only users who have no password.
    password_hash     VARCHAR(255),

    -- Stores the unique ID from Google's OAuth system.
    google_id         VARCHAR(255),

    account_status    account_status_enum NOT NULL DEFAULT 'active',
    is_email_verified BOOLEAN             NOT NULL DEFAULT FALSE,
    is_phone_verified BOOLEAN             NOT NULL DEFAULT FALSE,

    -- Denormalized rating cache — updated via trigger whenever a rating is
    -- submitted. Trading storage for query speed on search result cards.
    average_rating    NUMERIC(3, 2)       NOT NULL DEFAULT 0.00,
    rating_count      INTEGER             NOT NULL DEFAULT 0,

    created_at        TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    deleted_at        TIMESTAMPTZ
);

-- Partial unique indexes covering only non-deleted, non-null rows.
-- Multiple NULL emails are allowed simultaneously (OAuth users without email)
-- because in SQL, NULL != NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
    ON users (email)
    WHERE email IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone
    ON users (phone)
    WHERE phone IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id
    ON users (google_id)
    WHERE google_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_account_status
    ON users (account_status)
    WHERE deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- TABLE: user_roles
-- Maps users to their roles. A junction table handles the real edge case where
-- one person is both a student AND a PG owner.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_roles
(
    user_id     UUID        NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
    role_name   role_enum   NOT NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Composite PK: (user_id + role_name) must be unique.
    -- PostgreSQL auto-creates an index on this, so "what roles does user X have?"
    -- is already indexed.
    PRIMARY KEY (user_id, role_name)
);

-- Reverse index for the admin query "give me all users with the pg_owner role".
CREATE INDEX IF NOT EXISTS idx_user_roles_role_name
    ON user_roles (role_name);


-- -----------------------------------------------------------------------------
-- TABLE: student_profiles
-- Extends users with academic identity. UNIQUE on user_id enforces the
-- one-to-one relationship at the database level.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS student_profiles
(
    profile_id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

    -- UNIQUE here is what makes this a one-to-one relationship with users.
    user_id             UUID         NOT NULL UNIQUE
                                     REFERENCES users (user_id) ON DELETE RESTRICT,

    -- ON DELETE SET NULL: if an institution row is deleted, we null out this
    -- reference rather than deleting the student's profile along with it.
    institution_id      UUID         REFERENCES institutions (institution_id)
                                     ON DELETE SET NULL,

    full_name           VARCHAR(255) NOT NULL,
    date_of_birth       DATE,
    gender              gender_enum,
    profile_photo_url   TEXT,
    bio                 TEXT,
    course              VARCHAR(255),
    year_of_study       SMALLINT,

    -- We never store the raw 12-digit Aadhaar number. The UIDAI API returns a
    -- tokenized reference after OTP verification — that token is all we store.
    is_aadhaar_verified BOOLEAN      NOT NULL DEFAULT FALSE,
    aadhaar_reference   VARCHAR(255) UNIQUE,

    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_student_profiles_user_id
    ON student_profiles (user_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_student_profiles_institution
    ON student_profiles (institution_id)
    WHERE deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_student_profiles_updated_at
    BEFORE UPDATE ON student_profiles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- TABLE: pg_owner_profiles
-- Extends users with PG/hostel business identity. PG owners must submit
-- documents and wait for manual admin review.
-- State machine: unverified → pending → verified (or rejected).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pg_owner_profiles
(
    profile_id           UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              UUID                     NOT NULL UNIQUE
                                                  REFERENCES users (user_id) ON DELETE RESTRICT,

    business_name        VARCHAR(255)             NOT NULL,
    owner_full_name      VARCHAR(255)             NOT NULL,
    business_description TEXT,

    -- Public-facing contact number shown on listings — deliberately separate
    -- from the personal phone stored in users so owners control what's visible.
    business_phone       VARCHAR(20),
    operating_since      SMALLINT,

    verification_status  verification_status_enum NOT NULL DEFAULT 'unverified',
    rejection_reason     TEXT,
    verified_at          TIMESTAMPTZ,
    verified_by          UUID REFERENCES users (user_id) ON DELETE SET NULL,

    created_at           TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
    deleted_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pg_owner_profiles_user_id
    ON pg_owner_profiles (user_id)
    WHERE deleted_at IS NULL;

-- Admins query by verification_status constantly to work their review queue.
CREATE INDEX IF NOT EXISTS idx_pg_owner_profiles_verification_status
    ON pg_owner_profiles (verification_status)
    WHERE deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_pg_owner_profiles_updated_at
    BEFORE UPDATE ON pg_owner_profiles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- TABLE: user_preferences
-- Stores lifestyle preferences using the EAV (Entity-Attribute-Value) pattern.
-- Adding a new preference is an INSERT, not a schema change.
-- UNIQUE on (user_id, preference_key) enforces one value per preference type.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_preferences
(
    preference_id    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID         NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,

    -- Example keys:   'smoking', 'food_habit', 'sleep_schedule', 'alcohol',
    --                 'cleanliness_level', 'noise_tolerance', 'guest_policy',
    --                 'has_pets', 'pet_allergies', 'has_vehicle'
    preference_key   VARCHAR(100) NOT NULL,

    -- Example values: 'non_smoker', 'vegetarian', 'night_owl', 'early_bird',
    --                 'okay', 'not_okay', '3' (for a 1–5 scale)
    preference_value VARCHAR(100) NOT NULL,

    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_user_preference UNIQUE (user_id, preference_key)
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id
    ON user_preferences (user_id);

-- This composite index directly powers compatibility scoring. The scoring query
-- JOINs this table against listing_preferences on both key AND value together.
CREATE INDEX IF NOT EXISTS idx_user_preferences_key_value
    ON user_preferences (preference_key, preference_value);

CREATE OR REPLACE TRIGGER trg_user_preferences_updated_at
    BEFORE UPDATE ON user_preferences
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- TABLE: verification_requests
-- The document submission and admin review audit trail for PG owners.
-- A separate table (rather than just columns on the profile) means we always
-- have a full history of every submission and every decision.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification_requests
(
    request_id    UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID                     NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,

    document_type document_type_enum       NOT NULL,
    document_url  TEXT                     NOT NULL,

    status        verification_status_enum NOT NULL DEFAULT 'pending',
    admin_notes   TEXT,

    submitted_at  TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
    reviewed_at   TIMESTAMPTZ,
    reviewed_by   UUID                     REFERENCES users (user_id) ON DELETE SET NULL,

    deleted_at    TIMESTAMPTZ
);

-- Composite index powers the admin queue view:
-- "show me all pending requests ordered by oldest first."
CREATE INDEX IF NOT EXISTS idx_verification_requests_status_submitted
    ON verification_requests (status, submitted_at)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_verification_requests_user_id
    ON verification_requests (user_id)
    WHERE deleted_at IS NULL;


-- =============================================================================
-- ZONE 2 — LISTINGS ZONE
-- Answers: what is being offered, by whom, and where?
-- Both student postings and PG owner room postings live in the same listings
-- table. property_id nullable: NULL = student listing, UUID = PG room.
--
-- Creation order: amenities → properties → junction tables → listings → children
-- =============================================================================


-- -----------------------------------------------------------------------------
-- TABLE: amenities
-- A master reference list of all possible amenities like wifi, AC, CCTV.
-- Normalized so amenities can be indexed, filtered, categorized, and mapped
-- to frontend icons independently.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS amenities
(
    amenity_id UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
    name       VARCHAR(100)          NOT NULL UNIQUE,
    category   amenity_category_enum NOT NULL,

    -- Stores a string like 'wifi-icon' that maps to a React icon component.
    -- Keeping this in the DB means the frontend never needs a hardcoded map.
    icon_name  VARCHAR(100),

    created_at TIMESTAMPTZ           NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ           NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE TRIGGER trg_amenities_updated_at
    BEFORE UPDATE ON amenities
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- TABLE: properties
-- The physical PG or hostel building. Only PG owners create these.
-- A property is the parent; listings (individual rooms) are children.
-- Address split into separate columns for independent filtering and indexing.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS properties
(
    property_id    UUID                 PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id       UUID                 NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,

    property_name  VARCHAR(255)         NOT NULL,
    description    TEXT,
    property_type  property_type_enum   NOT NULL,

    address_line   VARCHAR(500)         NOT NULL,
    city           VARCHAR(100)         NOT NULL,
    locality       VARCHAR(100),
    landmark       VARCHAR(255),
    pincode        VARCHAR(10),

    -- Plain decimal lat/lng for display purposes (shown in the UI, passed to maps).
    latitude       NUMERIC(10, 7),
    longitude      NUMERIC(10, 7),

    -- PostGIS geometry column used exclusively for spatial queries like
    -- "find properties within 3km". Auto-synced with lat/lng via trigger.
    location       GEOMETRY(Point, 4326),

    house_rules    TEXT,
    total_rooms    SMALLINT,
    status         property_status_enum NOT NULL DEFAULT 'active',

    -- Denormalized rating cache — same pattern as users.average_rating.
    average_rating NUMERIC(3, 2)        NOT NULL DEFAULT 0.00,
    rating_count   INTEGER              NOT NULL DEFAULT 0,

    created_at     TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
    deleted_at     TIMESTAMPTZ
);

-- GiST index is required by PostGIS for geometry columns.
-- A regular B-Tree index cannot index spatial data.
CREATE INDEX IF NOT EXISTS idx_properties_location
    ON properties USING GIST (location)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_properties_city
    ON properties (city)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_properties_owner_id
    ON properties (owner_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_properties_status
    ON properties (status)
    WHERE status = 'active' AND deleted_at IS NULL;

-- Fires only when latitude or longitude changes, recomputes the geometry.
CREATE OR REPLACE TRIGGER trg_properties_sync_location
    BEFORE INSERT OR UPDATE OF latitude, longitude
    ON properties
    FOR EACH ROW EXECUTE FUNCTION sync_location_geometry();

CREATE OR REPLACE TRIGGER trg_properties_updated_at
    BEFORE UPDATE ON properties
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- TABLE: property_amenities
-- Junction table: many-to-many between properties and amenities.
-- Composite PK prevents a property from having the same amenity listed twice.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS property_amenities
(
    -- CASCADE: if a property is deleted, its amenity links go with it.
    property_id UUID NOT NULL REFERENCES properties (property_id) ON DELETE CASCADE,

    -- RESTRICT: prevents deleting an amenity that is still in use.
    amenity_id  UUID NOT NULL REFERENCES amenities (amenity_id) ON DELETE RESTRICT,

    PRIMARY KEY (property_id, amenity_id)
);

-- The PK index covers "what amenities does this property have?".
-- This reverse index covers "which properties have wifi?" — used in search filters.
CREATE INDEX IF NOT EXISTS idx_property_amenities_amenity_id
    ON property_amenities (amenity_id);


-- -----------------------------------------------------------------------------
-- TABLE: listings
-- The most important table in the schema. Serves both student postings and
-- PG room postings via nullable property_id.
--
-- Money is stored in PAISE (smallest INR unit) to avoid floating-point bugs.
-- Rs 8,500/month is stored as 850000. Node.js divides by 100 for display.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS listings
(
    listing_id              UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
    posted_by               UUID                NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,

    -- NULL = student listing.  UUID = PG owner's room under a property.
    property_id             UUID                REFERENCES properties (property_id) ON DELETE RESTRICT,

    listing_type            listing_type_enum   NOT NULL,
    title                   VARCHAR(255)        NOT NULL,
    description             TEXT,

    -- Stored in PAISE. Rs 8,500/month = 850000. Always divide by 100 before display.
    rent_per_month          INTEGER             NOT NULL,
    deposit_amount          INTEGER             NOT NULL DEFAULT 0,
    rent_includes_utilities BOOLEAN             NOT NULL DEFAULT FALSE,
    is_negotiable           BOOLEAN             NOT NULL DEFAULT FALSE,

    room_type               room_type_enum      NOT NULL,
    bed_type                bed_type_enum,

    total_capacity          SMALLINT            NOT NULL DEFAULT 1,
    current_occupants       SMALLINT            NOT NULL DEFAULT 0,

    -- Prevents current_occupants from ever exceeding total_capacity.
    CONSTRAINT chk_occupancy CHECK (current_occupants <= total_capacity),

    preferred_gender        gender_enum,

    available_from          DATE                NOT NULL,
    available_until         DATE,

    -- Address fields only populated for student listings. PG listings
    -- inherit their location from the parent property row.
    address_line            VARCHAR(500),
    city                    VARCHAR(100)        NOT NULL,
    locality                VARCHAR(100),
    landmark                VARCHAR(255),
    pincode                 VARCHAR(10),

    latitude                NUMERIC(10, 7),
    longitude               NUMERIC(10, 7),
    location                GEOMETRY(Point, 4326),

    status                  listing_status_enum NOT NULL DEFAULT 'active',
    views_count             INTEGER             NOT NULL DEFAULT 0,

    created_at              TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    expires_at              TIMESTAMPTZ,
    filled_at               TIMESTAMPTZ,
    deleted_at              TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_listings_location
    ON listings USING GIST (location)
    WHERE deleted_at IS NULL;

-- Composite index: city + status together because nearly every search query
-- filters on both simultaneously.
CREATE INDEX IF NOT EXISTS idx_listings_city_status
    ON listings (city, status)
    WHERE status = 'active' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_listings_rent
    ON listings (rent_per_month)
    WHERE status = 'active' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_listings_posted_by
    ON listings (posted_by)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_listings_property_id
    ON listings (property_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_listings_available_from
    ON listings (available_from)
    WHERE status = 'active' AND deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_listings_sync_location
    BEFORE INSERT OR UPDATE OF latitude, longitude
    ON listings
    FOR EACH ROW EXECUTE FUNCTION sync_location_geometry();

CREATE OR REPLACE TRIGGER trg_listings_updated_at
    BEFORE UPDATE ON listings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- TABLE: listing_photos
-- Stores multiple photos per listing with one designated as the cover image.
-- The partial unique index enforces at most one cover photo per listing at the
-- database level — not just application layer.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS listing_photos
(
    photo_id      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id    UUID        NOT NULL REFERENCES listings (listing_id) ON DELETE CASCADE,

    photo_url     TEXT        NOT NULL,
    is_cover      BOOLEAN     NOT NULL DEFAULT FALSE,
    display_order SMALLINT    NOT NULL DEFAULT 0,

    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_listing_photos_listing_id
    ON listing_photos (listing_id)
    WHERE deleted_at IS NULL;

-- Partial unique index: uniqueness is only enforced among rows where is_cover IS TRUE.
CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_photos_one_cover
    ON listing_photos (listing_id)
    WHERE is_cover = TRUE AND deleted_at IS NULL;


-- -----------------------------------------------------------------------------
-- TABLE: listing_preferences
-- Mirror image of user_preferences. Describes what kind of roommate the poster
-- WANTS. Compatibility score = count of matching (key, value) pairs between
-- user_preferences and listing_preferences.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS listing_preferences
(
    preference_id    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id       UUID         NOT NULL REFERENCES listings (listing_id) ON DELETE CASCADE,

    preference_key   VARCHAR(100) NOT NULL,
    preference_value VARCHAR(100) NOT NULL,

    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_listing_preference UNIQUE (listing_id, preference_key)
);

CREATE INDEX IF NOT EXISTS idx_listing_preferences_listing_id
    ON listing_preferences (listing_id);

CREATE INDEX IF NOT EXISTS idx_listing_preferences_key_value
    ON listing_preferences (preference_key, preference_value);

CREATE OR REPLACE TRIGGER trg_listing_preferences_updated_at
    BEFORE UPDATE ON listing_preferences
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- TABLE: listing_amenities
-- Room-level amenities — a specific room within a PG might have AC or an
-- attached bathroom even when other rooms in the same property don't.
-- Separate from property_amenities which covers building-wide facilities.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS listing_amenities
(
    listing_id UUID NOT NULL REFERENCES listings (listing_id) ON DELETE CASCADE,
    amenity_id UUID NOT NULL REFERENCES amenities (amenity_id) ON DELETE RESTRICT,

    PRIMARY KEY (listing_id, amenity_id)
);

CREATE INDEX IF NOT EXISTS idx_listing_amenities_amenity_id
    ON listing_amenities (amenity_id);


-- -----------------------------------------------------------------------------
-- TABLE: saved_listings
-- The bookmark/shortlist feature. Composite PK prevents double-saving.
-- Reverse index lets us show posters how many people saved their listing.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saved_listings
(
    user_id    UUID        NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
    listing_id UUID        NOT NULL REFERENCES listings (listing_id) ON DELETE CASCADE,

    saved_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,

    PRIMARY KEY (user_id, listing_id)
);

-- "Show me all listings I have saved" — forward lookup from user.
CREATE INDEX IF NOT EXISTS idx_saved_listings_user_id
    ON saved_listings (user_id)
    WHERE deleted_at IS NULL;

-- "How many users saved this listing?" — reverse lookup from listing.
CREATE INDEX IF NOT EXISTS idx_saved_listings_listing_id
    ON saved_listings (listing_id)
    WHERE deleted_at IS NULL;


-- =============================================================================
-- ZONE 3 — INTERACTION ZONE
-- Answers: how do two people go from strangers to a confirmed real-world
-- interaction?
--
-- Three stages:
--   1. interest_requests  — intent
--   2. connections        — proof (trust anchor for Zone 4)
--   3. notifications      — event feed
--
-- The connections table is the most architecturally significant table in this
-- zone. A rating cannot be inserted without a valid confirmed connection_id —
-- fake reviews are structurally impossible at the database level.
--
-- Creation order: interest_requests → connections → notifications
-- =============================================================================


-- -----------------------------------------------------------------------------
-- TABLE: interest_requests
-- Created when a user taps "I'm interested" on a listing.
-- State machine: pending → accepted / declined / withdrawn
--
-- Partial unique index prevents duplicate active requests per (sender, listing)
-- pair. Declined/withdrawn requests don't block future re-applications.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS interest_requests
(
    request_id  UUID                 PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The user who saw the listing and expressed interest.
    sender_id   UUID                 NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,

    -- The listing they're interested in.
    listing_id  UUID                 NOT NULL REFERENCES listings (listing_id) ON DELETE CASCADE,

    -- Optional intro message: "Hi, I'm a 3rd year CS student, non-smoker..."
    message     TEXT,

    status      request_status_enum  NOT NULL DEFAULT 'pending',

    created_at  TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ
);

-- Prevents a user from spamming the same listing with multiple active requests.
-- The partial index only covers rows where status is pending or accepted.
CREATE UNIQUE INDEX IF NOT EXISTS idx_interest_requests_no_duplicates
    ON interest_requests (sender_id, listing_id)
    WHERE status IN ('pending', 'accepted') AND deleted_at IS NULL;

-- Used to load "all requests for this listing" on the poster's dashboard.
CREATE INDEX IF NOT EXISTS idx_interest_requests_listing_id
    ON interest_requests (listing_id, status)
    WHERE deleted_at IS NULL;

-- Used to load "all requests I have sent" on the sender's dashboard.
CREATE INDEX IF NOT EXISTS idx_interest_requests_sender_id
    ON interest_requests (sender_id, status)
    WHERE deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_interest_requests_updated_at
    BEFORE UPDATE ON interest_requests
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- TABLE: connections
-- The trust anchor of the entire platform. Represents a confirmed real-world
-- interaction between two parties — both sides must independently confirm.
--
-- Confirmation flow:
--   1. interest_request gets accepted
--   2. Initiator confirms → initiator_confirmed = TRUE
--   3. Counterpart confirms → counterpart_confirmed = TRUE
--   4. App sets confirmation_status = 'confirmed'
--   5. Ratings can now be submitted against this connection_id
--
-- connection_type determines which rating dimensions are meaningful.
-- start_date/end_date add credibility context to ratings.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connections
(
    connection_id         UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),

    -- For student_roommate: initiator = whoever sent the interest request.
    -- For pg_stay: initiator = student, counterpart = PG owner.
    initiator_id          UUID                     NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
    counterpart_id        UUID                     NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,

    -- The listing that brought these two parties together. Nullable for
    -- admin-created connections.
    listing_id            UUID                     REFERENCES listings (listing_id) ON DELETE SET NULL,

    connection_type       connection_type_enum     NOT NULL,

    -- Actual dates of the real-world interaction.
    -- A 6-month stay is more credible signal than a 2-day visit.
    start_date            DATE,
    end_date              DATE,

    -- Independent confirmation flags — each party flips their own boolean.
    initiator_confirmed   BOOLEAN                  NOT NULL DEFAULT FALSE,
    counterpart_confirmed BOOLEAN                  NOT NULL DEFAULT FALSE,

    confirmation_status   confirmation_status_enum NOT NULL DEFAULT 'pending',

    denial_reason         TEXT,

    created_at            TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
    deleted_at            TIMESTAMPTZ
);

-- Used to check "does a confirmed connection exist between these two users?"
-- before allowing a rating to be submitted. This is the eligibility gate query.
CREATE INDEX IF NOT EXISTS idx_connections_initiator_id
    ON connections (initiator_id, confirmation_status)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_connections_counterpart_id
    ON connections (counterpart_id, confirmation_status)
    WHERE deleted_at IS NULL;

-- Used to load all connections related to a specific listing.
CREATE INDEX IF NOT EXISTS idx_connections_listing_id
    ON connections (listing_id)
    WHERE deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_connections_updated_at
    BEFORE UPDATE ON connections
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- TABLE: notifications
-- The in-app event feed. actor_id + recipient_id captures social context:
-- "actor did something that recipient should know about."
--
-- entity_id + entity_type form a polymorphic reference — a single pair of
-- columns that can point to any table. Cleaner than multiple nullable FK columns.
-- entity_type = 'listing'          → entity_id points to listings
-- entity_type = 'connection'       → entity_id points to connections
-- entity_type = 'interest_request' → entity_id points to interest_requests
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications
(
    notification_id   UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),

    -- NULL allowed for system-generated notifications with no human actor.
    actor_id          UUID                     REFERENCES users (user_id) ON DELETE SET NULL,

    recipient_id      UUID                     NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,

    notification_type notification_type_enum   NOT NULL,

    -- Polymorphic reference: describes what object this notification is about.
    entity_type       VARCHAR(50),
    entity_id         UUID,

    -- Short human-readable message shown in the notification UI.
    message           TEXT,

    is_read           BOOLEAN                  NOT NULL DEFAULT FALSE,

    created_at        TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
    deleted_at        TIMESTAMPTZ
);

-- Primary query for the notification bell: all unread notifications for a user,
-- newest first. Partial index on is_read=FALSE keeps it small and fast.
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_unread
    ON notifications (recipient_id, created_at DESC)
    WHERE is_read = FALSE AND deleted_at IS NULL;

-- Used for loading the full notification history page (read + unread).
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_all
    ON notifications (recipient_id, created_at DESC)
    WHERE deleted_at IS NULL;


-- =============================================================================
-- ZONE 4 — REPUTATION ZONE
-- Answers: what do people think of each other and the places they stayed?
--
-- Two tables:
--   1. ratings        — review record anchored to a confirmed connection
--   2. rating_reports — moderation queue for flagged reviews
--
-- Zone 4 writes back to earlier zones via trigger:
--   → Updates users.average_rating and users.rating_count (Zone 1)
--   → Updates properties.average_rating and properties.rating_count (Zone 2)
-- =============================================================================


-- -----------------------------------------------------------------------------
-- TABLE: ratings
-- Core reputation record. Each row is one person's review of either another
-- user or a property, anchored to a confirmed real-world connection.
--
-- DIMENSION SCORES vs OVERALL SCORE:
-- Four nullable dimension scores (cleanliness, communication, reliability,
-- value) plus one required overall_score. Not every dimension applies to every
-- review — a student rating a fellow roommate doesn't need a 'value_score'.
-- The app decides which dimensions to display based on reviewee_type and
-- connection_type.
--
-- POLYMORPHIC REVIEWEE (reviewee_type + reviewee_id):
-- reviewee_type = 'user'     → reviewee_id points to users.user_id
-- reviewee_type = 'property' → reviewee_id points to properties.property_id
-- Integrity check happens in application code since a standard FK can only
-- reference one table.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ratings
(
    rating_id      UUID                 PRIMARY KEY DEFAULT gen_random_uuid(),

    reviewer_id    UUID                 NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,

    -- NOT NULL is the entire anti-fake-review system in one constraint.
    -- If no confirmed connection exists, PostgreSQL rejects the INSERT.
    connection_id  UUID                 NOT NULL REFERENCES connections (connection_id) ON DELETE RESTRICT,

    reviewee_type  reviewee_type_enum   NOT NULL,
    reviewee_id    UUID                 NOT NULL,

    -- Required — this is what gets cached in average_rating via trigger.
    overall_score  SMALLINT             NOT NULL
        CHECK (overall_score BETWEEN 1 AND 5),

    -- Nullable — not every dimension applies to every review type.
    cleanliness_score   SMALLINT        CHECK (cleanliness_score BETWEEN 1 AND 5),
    communication_score SMALLINT        CHECK (communication_score BETWEEN 1 AND 5),
    reliability_score   SMALLINT        CHECK (reliability_score BETWEEN 1 AND 5),
    value_score         SMALLINT        CHECK (value_score BETWEEN 1 AND 5),

    review_text    TEXT,

    -- Controls visibility without deleting the row. When an admin resolves a
    -- report as 'resolved_removed', is_visible = FALSE. The row is preserved
    -- for audit history and report references.
    is_visible     BOOLEAN              NOT NULL DEFAULT TRUE,

    created_at     TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
    deleted_at     TIMESTAMPTZ
);

-- One rating per (reviewer, connection, reviewee) combination.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ratings_one_per_connection
    ON ratings (reviewer_id, connection_id, reviewee_id)
    WHERE deleted_at IS NULL;

-- Used to load "all reviews about this user" on their public profile page.
CREATE INDEX IF NOT EXISTS idx_ratings_reviewee
    ON ratings (reviewee_id, reviewee_type, is_visible)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ratings_reviewer_id
    ON ratings (reviewer_id)
    WHERE deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_ratings_updated_at
    BEFORE UPDATE ON ratings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- TRIGGER FUNCTION: update_rating_aggregates
-- Fires after INSERT or UPDATE on ratings (only when overall_score or
-- is_visible changes). Recalculates average_rating and rating_count for the
-- affected user or property and writes the result back to users or properties.
--
-- This closes the Zone 4 → Zone 1/2 feedback loop. Without it,
-- users.average_rating would always stay at 0.00 and you'd have to compute
-- AVG() on every search result query — extremely slow at scale.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_rating_aggregates()
    RETURNS TRIGGER AS $$
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

-- Fires only when overall_score or is_visible changes — not on every update.
CREATE OR REPLACE TRIGGER trg_ratings_update_aggregates
    AFTER INSERT OR UPDATE OF overall_score, is_visible
    ON ratings
    FOR EACH ROW EXECUTE FUNCTION update_rating_aggregates();


-- -----------------------------------------------------------------------------
-- TABLE: rating_reports
-- Moderation queue for flagged ratings.
-- Outcomes: resolved_removed (rating hidden) or resolved_kept (rating stays).
-- Both outcomes are preserved — patterns in report data improve future
-- automated flagging.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rating_reports
(
    report_id   UUID                 PRIMARY KEY DEFAULT gen_random_uuid(),

    reporter_id UUID                 NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,

    rating_id   UUID                 NOT NULL REFERENCES ratings (rating_id) ON DELETE RESTRICT,

    reason      report_reason_enum   NOT NULL,

    explanation TEXT,

    status      report_status_enum   NOT NULL DEFAULT 'open',

    admin_notes TEXT,
    reviewed_at TIMESTAMPTZ,
    reviewed_by UUID                 REFERENCES users (user_id) ON DELETE SET NULL,

    created_at  TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ
);

-- Prevents the same user from filing duplicate open reports against the same rating.
-- Resolved reports don't block re-reporting.
CREATE UNIQUE INDEX IF NOT EXISTS idx_rating_reports_no_duplicates
    ON rating_reports (reporter_id, rating_id)
    WHERE status = 'open' AND deleted_at IS NULL;

-- Admin moderation queue: all open reports sorted oldest first.
CREATE INDEX IF NOT EXISTS idx_rating_reports_status_created
    ON rating_reports (status, created_at)
    WHERE deleted_at IS NULL;

-- "All reports filed against this rating" — for admin rating detail view.
CREATE INDEX IF NOT EXISTS idx_rating_reports_rating_id
    ON rating_reports (rating_id)
    WHERE deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_rating_reports_updated_at
    BEFORE UPDATE ON rating_reports
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =============================================================================
-- SANITY CHECK QUERIES
--
--   \dt       list all tables       (expect 19 tables)
--   \dT       list all enum types   (expect 15 types)
--   \df       list all functions    (expect 3 functions)
--   \d ratings
--   \d+ ratings
--   \d connections
-- =============================================================================
