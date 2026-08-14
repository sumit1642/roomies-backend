
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
CREATE EXTENSION IF NOT EXISTS postgis_tiger_geocoder;
DO $$ BEGIN CREATE TYPE account_status_enum AS ENUM ('active', 'suspended', 'banned', 'deactivated');

EXCEPTION WHEN duplicate_object THEN NULL;

END $$;

DO $$ BEGIN CREATE TYPE role_enum AS ENUM ('student', 'pg_owner', 'admin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE gender_enum AS ENUM ('male', 'female', 'other', 'prefer_not_to_say');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE verification_status_enum AS ENUM ('unverified', 'pending', 'verified', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE listing_type_enum AS ENUM ('student_room', 'pg_room', 'hostel_bed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE room_type_enum AS ENUM ('single', 'double', 'triple', 'entire_flat');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE bed_type_enum AS ENUM ('single_bed', 'double_bed', 'bunk_bed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE listing_status_enum AS ENUM ('active', 'filled', 'expired', 'deactivated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE property_type_enum AS ENUM ('pg', 'hostel', 'shared_apartment');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE property_status_enum AS ENUM ('active', 'inactive', 'under_review');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE request_status_enum AS ENUM ('pending', 'accepted', 'declined', 'withdrawn', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE confirmation_status_enum AS ENUM ('pending', 'confirmed', 'denied', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE connection_type_enum AS ENUM ('student_roommate', 'pg_stay', 'hostel_stay', 'visit_only');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE reviewee_type_enum AS ENUM ('user', 'property');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE report_reason_enum AS ENUM ('fake', 'abusive', 'conflict_of_interest', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE report_status_enum AS ENUM ('open', 'resolved_removed', 'resolved_kept');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE notification_type_enum AS ENUM (
    'interest_request_received',
    'interest_request_accepted',
    'interest_request_declined',
    'interest_request_withdrawn',
    'connection_confirmed',
    'connection_requested',
    'rating_received',
    'listing_expiring',
    'listing_expired',
    'listing_filled',
    'verification_approved',
    'verification_rejected',
    'new_message'
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE document_type_enum AS ENUM ('property_document', 'rental_agreement', 'owner_id', 'trade_license');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE amenity_category_enum AS ENUM ('utility', 'safety', 'comfort');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_location_geometry()
    RETURNS TRIGGER AS $$
BEGIN
    IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
        NEW.location = ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326);
    ELSE
        NEW.location = NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS institutions (
    institution_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    name VARCHAR(255) NOT NULL,
    city VARCHAR(100) NOT NULL,
    state VARCHAR(100) NOT NULL,
    email_domain VARCHAR(100) NOT NULL,
    type VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_institutions_email_domain ON institutions (email_domain)
WHERE
    deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_institutions_updated_at
    BEFORE UPDATE ON institutions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS users (
    user_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    email VARCHAR(255),
    phone VARCHAR(20),
    password_hash VARCHAR(255),
    google_id VARCHAR(255),
    account_status account_status_enum NOT NULL DEFAULT 'active',
    is_email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    is_phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
    average_rating NUMERIC(3, 2) NOT NULL DEFAULT 0.00,
    rating_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

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

CREATE INDEX IF NOT EXISTS idx_users_account_status ON users (account_status)
WHERE
    deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS user_roles (
    user_id UUID NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
    role_name role_enum NOT NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, role_name)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_role_name ON user_roles (role_name);

CREATE TABLE IF NOT EXISTS student_profiles (
    profile_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    user_id UUID NOT NULL UNIQUE REFERENCES users (user_id) ON DELETE RESTRICT,
    institution_id UUID REFERENCES institutions (institution_id) ON DELETE SET NULL,
    full_name VARCHAR(255) NOT NULL,
    date_of_birth DATE,
    gender gender_enum,
    profile_photo_url TEXT,
    bio TEXT,
    course VARCHAR(255),
    year_of_study SMALLINT,
    is_aadhaar_verified BOOLEAN NOT NULL DEFAULT FALSE,
    aadhaar_reference VARCHAR(255) UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_student_profiles_user_id ON student_profiles (user_id)
WHERE
    deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_student_profiles_institution ON student_profiles (institution_id)
WHERE
    deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_student_profiles_updated_at
    BEFORE UPDATE ON student_profiles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS pg_owner_profiles (
    profile_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    user_id UUID NOT NULL UNIQUE REFERENCES users (user_id) ON DELETE RESTRICT,
    business_name VARCHAR(255) NOT NULL,
    owner_full_name VARCHAR(255) NOT NULL,
    business_description TEXT,
    business_phone VARCHAR(20),
    operating_since SMALLINT,
    verification_status verification_status_enum NOT NULL DEFAULT 'unverified',
    rejection_reason TEXT,
    verified_at TIMESTAMPTZ,
    verified_by UUID REFERENCES users (user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pg_owner_profiles_user_id ON pg_owner_profiles (user_id)
WHERE
    deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pg_owner_profiles_verification_status ON pg_owner_profiles (verification_status)
WHERE
    deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_pg_owner_profiles_updated_at
    BEFORE UPDATE ON pg_owner_profiles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS user_preferences (
    preference_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    user_id UUID NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
    preference_key VARCHAR(100) NOT NULL,
    preference_value VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_user_preference UNIQUE (user_id, preference_key)
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id ON user_preferences (user_id);

CREATE INDEX IF NOT EXISTS idx_user_preferences_key_value ON user_preferences (
    preference_key,
    preference_value
);

CREATE OR REPLACE TRIGGER trg_user_preferences_updated_at
    BEFORE UPDATE ON user_preferences
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

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

CREATE INDEX IF NOT EXISTS idx_verification_requests_status_submitted ON verification_requests (status, submitted_at)
WHERE
    deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_verification_requests_user_id ON verification_requests (user_id)
WHERE
    deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_verification_requests_active_pending_per_user ON verification_requests (user_id)
WHERE
    deleted_at IS NULL
    AND status = 'pending';

CREATE TABLE IF NOT EXISTS amenities (
    amenity_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    name VARCHAR(100) NOT NULL UNIQUE,
    category amenity_category_enum NOT NULL,
    icon_name VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE TRIGGER trg_amenities_updated_at
    BEFORE UPDATE ON amenities
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS properties (
    property_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    owner_id UUID NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
    property_name VARCHAR(255) NOT NULL,
    description TEXT,
    property_type property_type_enum NOT NULL,
    address_line VARCHAR(500) NOT NULL,
    city VARCHAR(100) NOT NULL,
    locality VARCHAR(100),
    landmark VARCHAR(255),
    pincode VARCHAR(10),
    latitude NUMERIC(10, 7),
    longitude NUMERIC(10, 7),
    location GEOMETRY (POINT, 4326),
    house_rules TEXT,
    total_rooms SMALLINT,
    status property_status_enum NOT NULL DEFAULT 'active',
    average_rating NUMERIC(3, 2) NOT NULL DEFAULT 0.00,
    rating_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_properties_location ON properties USING GIST (location)
WHERE
    deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_properties_city ON properties (city)
WHERE
    deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_properties_owner_id ON properties (owner_id)
WHERE
    deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_properties_status ON properties (status)
WHERE
    status = 'active'
    AND deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_properties_sync_location
    BEFORE INSERT OR UPDATE OF latitude, longitude ON properties
    FOR EACH ROW EXECUTE FUNCTION sync_location_geometry();

CREATE OR REPLACE TRIGGER trg_properties_updated_at
    BEFORE UPDATE ON properties
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS property_amenities (
    property_id UUID NOT NULL REFERENCES properties (property_id) ON DELETE CASCADE,
    amenity_id UUID NOT NULL REFERENCES amenities (amenity_id) ON DELETE RESTRICT,
    PRIMARY KEY (property_id, amenity_id)
);

CREATE INDEX IF NOT EXISTS idx_property_amenities_amenity_id ON property_amenities (amenity_id);

CREATE TABLE IF NOT EXISTS listings (
    listing_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    posted_by UUID NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
    property_id UUID REFERENCES properties (property_id) ON DELETE RESTRICT,
    listing_type listing_type_enum NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    rent_per_month INTEGER NOT NULL,
    deposit_amount INTEGER NOT NULL DEFAULT 0,
    rent_includes_utilities BOOLEAN NOT NULL DEFAULT FALSE,
    is_negotiable BOOLEAN NOT NULL DEFAULT FALSE,
    room_type room_type_enum NOT NULL,
    bed_type bed_type_enum,
    total_capacity SMALLINT NOT NULL DEFAULT 1,
    current_occupants SMALLINT NOT NULL DEFAULT 0,
    CONSTRAINT chk_occupancy CHECK (
        current_occupants <= total_capacity
    ),
    preferred_gender gender_enum,
    available_from DATE NOT NULL,
    available_until DATE,
    address_line VARCHAR(500),
    city VARCHAR(100) NOT NULL,
    locality VARCHAR(100),
    landmark VARCHAR(255),
    pincode VARCHAR(10),
    latitude NUMERIC(10, 7),
    longitude NUMERIC(10, 7),
    location GEOMETRY (POINT, 4326),
    status listing_status_enum NOT NULL DEFAULT 'active',
    views_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    filled_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_listings_location ON listings USING GIST (location)
WHERE
    deleted_at IS NULL;

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

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_city_lower ON listings (LOWER(city))
-- CREATE INDEX  IF NOT EXISTS idx_listings_city_lower ON listings (LOWER(city))
WHERE
    status = 'active'
    AND deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_listings_sync_location
    BEFORE INSERT OR UPDATE OF latitude, longitude ON listings
    FOR EACH ROW EXECUTE FUNCTION sync_location_geometry();

CREATE OR REPLACE TRIGGER trg_listings_updated_at
    BEFORE UPDATE ON listings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS listing_photos (
    photo_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    listing_id UUID NOT NULL REFERENCES listings (listing_id) ON DELETE CASCADE,
    photo_url TEXT NOT NULL,
    is_cover BOOLEAN NOT NULL DEFAULT FALSE,
    display_order SMALLINT NOT NULL DEFAULT 0,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_listing_photos_listing_id ON listing_photos (listing_id)
WHERE
    deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_photos_one_cover ON listing_photos (listing_id)
WHERE
    is_cover = TRUE
    AND deleted_at IS NULL;

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

CREATE INDEX IF NOT EXISTS idx_listing_preferences_key_value ON listing_preferences (
    preference_key,
    preference_value
);

CREATE OR REPLACE TRIGGER trg_listing_preferences_updated_at
    BEFORE UPDATE ON listing_preferences
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS listing_amenities (
    listing_id UUID NOT NULL REFERENCES listings (listing_id) ON DELETE CASCADE,
    amenity_id UUID NOT NULL REFERENCES amenities (amenity_id) ON DELETE RESTRICT,
    PRIMARY KEY (listing_id, amenity_id)
);

CREATE INDEX IF NOT EXISTS idx_listing_amenities_amenity_id ON listing_amenities (amenity_id);

CREATE TABLE IF NOT EXISTS saved_listings (
    user_id UUID NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
    listing_id UUID NOT NULL REFERENCES listings (listing_id) ON DELETE CASCADE,
    saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, listing_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_listings_user_id ON saved_listings (user_id)
WHERE
    deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_saved_listings_listing_id ON saved_listings (listing_id)
WHERE
    deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS interest_requests (
    request_id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid (),
    sender_id UUID NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
    listing_id UUID NOT NULL REFERENCES listings (listing_id) ON DELETE CASCADE,
    message TEXT,
    status request_status_enum NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_interest_requests_no_duplicates ON interest_requests (sender_id, listing_id)
WHERE
    status IN ('pending', 'accepted')
    AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_interest_requests_listing_id ON interest_requests (listing_id, status)
WHERE
    deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_interest_requests_sender_id ON interest_requests (sender_id, status)
WHERE
    deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_interest_requests_updated_at
    BEFORE UPDATE ON interest_requests
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS connections (
    connection_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    initiator_id UUID NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
    counterpart_id UUID NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
    listing_id UUID REFERENCES listings (listing_id) ON DELETE SET NULL,
    interest_request_id UUID REFERENCES interest_requests (request_id) ON DELETE SET NULL,
    connection_type connection_type_enum NOT NULL,
    start_date DATE,
    end_date DATE,
    initiator_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
    counterpart_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
    confirmation_status confirmation_status_enum NOT NULL DEFAULT 'pending',
    denial_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

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

CREATE INDEX IF NOT EXISTS idx_connections_listing_id ON connections (listing_id)
WHERE
    deleted_at IS NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_connections_interest_request_id ON connections (interest_request_id)
-- CREATE UNIQUE INDEX  IF NOT EXISTS idx_connections_interest_request_id ON connections (interest_request_id)
WHERE
    interest_request_id IS NOT NULL
    AND deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_connections_updated_at
    BEFORE UPDATE ON connections
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS notifications (
    notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    actor_id UUID REFERENCES users (user_id) ON DELETE SET NULL,
    recipient_id UUID NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
    notification_type notification_type_enum NOT NULL,
    entity_type VARCHAR(50),
    entity_id UUID,
    message TEXT,
    idempotency_key VARCHAR(100) UNIQUE,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_unread ON notifications (recipient_id, created_at DESC)
WHERE
    is_read = FALSE
    AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_all ON notifications (recipient_id, created_at DESC)
WHERE
    deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ratings (
    rating_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    reviewer_id UUID NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
    connection_id UUID NOT NULL REFERENCES connections (connection_id) ON DELETE RESTRICT,
    reviewee_type reviewee_type_enum NOT NULL,
    reviewee_id UUID NOT NULL,
    overall_score SMALLINT NOT NULL CHECK (overall_score BETWEEN 1 AND 5),
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
    is_visible BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ratings_one_per_connection ON ratings (
    reviewer_id,
    connection_id,
    reviewee_id
)
WHERE
    deleted_at IS NULL;

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

CREATE OR REPLACE FUNCTION update_rating_aggregates()
    RETURNS TRIGGER AS $$
DECLARE
    v_avg NUMERIC(3, 2);
    v_count INTEGER;
BEGIN
    IF NEW.reviewee_type = 'user' THEN
        SELECT ROUND(AVG(overall_score)::NUMERIC, 2), COUNT(*)
        INTO v_avg, v_count
        FROM ratings
        WHERE reviewee_id   = NEW.reviewee_id
          AND reviewee_type = 'user'
          AND is_visible    = TRUE
          AND deleted_at    IS NULL;

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

        UPDATE properties
        SET average_rating = COALESCE(v_avg, 0.00),
            rating_count   = v_count
        WHERE property_id = NEW.reviewee_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_ratings_update_aggregates
    AFTER INSERT OR UPDATE OF overall_score, is_visible, deleted_at ON ratings
    FOR EACH ROW EXECUTE FUNCTION update_rating_aggregates();

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_rating_reports_no_duplicates ON rating_reports (reporter_id, rating_id)
WHERE
    status = 'open'
    AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_rating_reports_status_created ON rating_reports (status, created_at)
WHERE
    deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_rating_reports_rating_id ON rating_reports (rating_id)
WHERE
    deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_rating_reports_updated_at
    BEFORE UPDATE ON rating_reports
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Migration 002: Add verification event outbox pattern
-- Creates outbox table for async notification processing on verification status changes
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'notification_type_enum'
          AND e.enumlabel = 'verification_pending'
    ) THEN
        ALTER TYPE notification_type_enum ADD VALUE 'verification_pending';
    END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS verification_event_outbox (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    event_type VARCHAR(50) NOT NULL CHECK (
        event_type IN (
            'verification_approved',
            'verification_rejected',
            'verification_pending'
        )
    ),
    user_id UUID NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    request_id UUID NOT NULL REFERENCES verification_requests (request_id) ON DELETE CASCADE,
    rejection_reason TEXT,
    processed_at TIMESTAMPTZ,
    error_message TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_verification_outbox_unprocessed ON verification_event_outbox (created_at ASC)
WHERE
    processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_verification_outbox_user_id ON verification_event_outbox (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION verification_status_changed()
    RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    IF NEW.status = 'verified' THEN
        INSERT INTO verification_event_outbox (event_type, user_id, request_id)
        VALUES ('verification_approved', NEW.user_id, NEW.request_id);

    ELSIF NEW.status = 'rejected' THEN
        INSERT INTO verification_event_outbox (event_type, user_id, request_id, rejection_reason)
        VALUES ('verification_rejected', NEW.user_id, NEW.request_id, NEW.admin_notes);

    ELSIF NEW.status = 'pending' THEN
        INSERT INTO verification_event_outbox (event_type, user_id, request_id)
        VALUES ('verification_pending', NEW.user_id, NEW.request_id);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    DROP TRIGGER IF EXISTS trg_verification_status_changed ON verification_requests;
END;
$$;

CREATE TRIGGER trg_verification_status_changed
    AFTER UPDATE OF status ON verification_requests
    FOR EACH ROW
    EXECUTE FUNCTION verification_status_changed();

-- Active: 1777192065763@@127.0.0.1@5432@roomies_db
-- Migration 003: Add profile_photo_url to pg_owner_profiles
--
-- student_profiles already has this column from migration 001.
-- pg_owner_profiles was missing it; adding it here so PG owners can upload
-- a profile photo through the same endpoint pattern as students.

ALTER TABLE pg_owner_profiles
    ADD COLUMN IF NOT EXISTS profile_photo_url TEXT;

-- Active: 1777192065763@@127.0.0.1@5432@roomies_db
ALTER TYPE notification_type_enum ADD VALUE IF NOT EXISTS 'saved_search_alert';

CREATE TABLE IF NOT EXISTS saved_searches (
    search_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    user_id UUID NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
    name VARCHAR(100) NOT NULL,
    filters JSONB NOT NULL DEFAULT '{}',
    last_alerted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_saved_searches_user_id ON saved_searches (user_id)
WHERE
    deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_saved_searches_updated_at
    BEFORE UPDATE ON saved_searches
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Active: 1777192065763@@127.0.0.1@5432@roomies_db
-- Migration 005: Roommate matching support
--
-- Adds opt-in roommate-seeking flag and bio to student_profiles.
-- Creates roommate_blocks so students can hide specific users from their feed.

ALTER TABLE student_profiles
ADD COLUMN IF NOT EXISTS looking_for_roommate BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS roommate_bio TEXT,
ADD COLUMN IF NOT EXISTS looking_updated_at TIMESTAMPTZ;

-- Sparse index — only indexes rows that are actively seeking.
-- The roommate feed query filters on this exact condition so the index is hit on every feed request.
CREATE INDEX IF NOT EXISTS idx_student_roommate_lookup ON student_profiles (
    looking_updated_at DESC,
    user_id
)
WHERE
    looking_for_roommate = TRUE
    AND deleted_at IS NULL;

-- Block table — bidirectional blocking is handled at the service layer
-- by checking both (blocker=caller, blocked=candidate) and vice-versa.
CREATE TABLE IF NOT EXISTS roommate_blocks (
    blocker_id UUID NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
    blocked_id UUID NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (blocker_id, blocked_id),
    CONSTRAINT chk_no_self_block CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_roommate_blocks_blocker ON roommate_blocks (blocker_id);

CREATE INDEX IF NOT EXISTS idx_roommate_blocks_blocked ON roommate_blocks (blocked_id);

-- Active: 1777192065763@@127.0.0.1@5432@roomies_db
-- Migration 006: Proper rent index
--
-- rent_observations: one row per active listing event (created / renewed).
--   Written by a DB trigger on listings — no application code path can forget it.
--
-- rent_index: materialised p25/p50/p75 per (city, locality, room_type).
--   Refreshed nightly by cron/rentIndexRefresh.js.
--   Listings JOIN this table to expose rentDeviation in API responses.
--
-- Fix (originally migration 011): The trigger now also fires when expires_at
-- changes so that renewals (status stays 'active' but expires_at advances)
-- correctly record a 'listing_renewed' observation. The UPDATE condition was
-- broadened to: NEW.status = 'active' AND (OLD.status <> 'active' OR
-- NEW.expires_at IS DISTINCT FROM OLD.expires_at).

CREATE TABLE IF NOT EXISTS rent_observations (
    observation_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    listing_id UUID NOT NULL REFERENCES listings (listing_id) ON DELETE CASCADE,
    city VARCHAR(100) NOT NULL,
    locality VARCHAR(100), -- normalised to LOWER(TRIM(...)), NULL for city-wide
    room_type room_type_enum NOT NULL,
    rent_per_month INTEGER NOT NULL, -- paise, same unit as listings.rent_per_month
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- 'listing_created' | 'listing_renewed' — set by the trigger
    source VARCHAR(30) NOT NULL DEFAULT 'listing_created',
    CONSTRAINT chk_positive_rent CHECK (rent_per_month > 0)
);

-- Index optimised for the cron aggregation query: GROUP BY city, locality, room_type
-- filtered to observations within the rolling 180-day window.
CREATE INDEX IF NOT EXISTS idx_rent_obs_aggregation ON rent_observations (
    city,
    locality,
    room_type,
    observed_at DESC
);

-- Fast lookup for cascading hard-deletes (cleanup cron).
CREATE INDEX IF NOT EXISTS idx_rent_obs_listing_id ON rent_observations (listing_id);

-- Materialised rent index — upserted by cron, never written from app code.
-- locality IS NULL means the row is the city-wide fallback used when no
-- locality-specific data meets the minimum sample threshold.
CREATE TABLE IF NOT EXISTS rent_index (
    rent_index_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    city VARCHAR(100) NOT NULL,
    locality VARCHAR(100), -- NULL = city-wide fallback
    room_type room_type_enum NOT NULL,
    p25 INTEGER NOT NULL, -- 25th percentile, paise
    p50 INTEGER NOT NULL, -- median
    p75 INTEGER NOT NULL, -- 75th percentile
    sample_count INTEGER NOT NULL,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_rent_index UNIQUE (city, locality, room_type),
    CONSTRAINT chk_rent_index_order CHECK (
        p25 <= p50
        AND p50 <= p75
    )
);

CREATE INDEX IF NOT EXISTS idx_rent_index_lookup ON rent_index (city, locality, room_type);

-- Trigger function: fires after INSERT on listings (new listing goes active)
-- and after UPDATE when status flips to 'active' OR expires_at changes while
-- already active (i.e. a renewal). Runs inside the same transaction as the
-- listing write — observation is never lost.
--
-- Fix vs original: the UPDATE branch previously only fired when OLD.status <>
-- 'active', which meant renewals (status unchanged, only expires_at advancing)
-- were silently dropped. Now we also fire when expires_at changes.
CREATE OR REPLACE FUNCTION capture_rent_observation()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.status = 'active' AND NEW.deleted_at IS NULL THEN
        INSERT INTO rent_observations
            (listing_id, city, locality, room_type, rent_per_month, source)
        VALUES (
            NEW.listing_id,
            NEW.city,
            NULLIF(LOWER(TRIM(COALESCE(NEW.locality, ''))), ''),
            NEW.room_type,
            NEW.rent_per_month,
            'listing_created'
        );

    ELSIF TG_OP = 'UPDATE'
        AND NEW.status = 'active'
        AND NEW.deleted_at IS NULL
        AND (
            OLD.status <> 'active'
            OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
        )
    THEN
        INSERT INTO rent_observations
            (listing_id, city, locality, room_type, rent_per_month, source)
        VALUES (
            NEW.listing_id,
            NEW.city,
            NULLIF(LOWER(TRIM(COALESCE(NEW.locality, ''))), ''),
            NEW.room_type,
            NEW.rent_per_month,
            'listing_renewed'
        );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Watch both status and expires_at so renewals (expires_at advances while
-- status stays 'active') also fire the trigger.
DROP TRIGGER IF EXISTS trg_capture_rent_observation ON listings;

CREATE TRIGGER trg_capture_rent_observation
    AFTER INSERT OR UPDATE OF status, expires_at ON listings
    FOR EACH ROW EXECUTE FUNCTION capture_rent_observation();

-- Active: 1777192065763@@127.0.0.1@5432@roomies_db
-- Migration 007: Fix roommate_blocks FK cascade + redundant index + CHECK constraint
--
-- Fixes applied from migration 005:
--   1. Add CHECK constraint: looking_for_roommate = TRUE requires looking_updated_at IS NOT NULL
--   2. Change roommate_blocks FKs from ON DELETE RESTRICT to ON DELETE CASCADE
--   3. Drop redundant idx_roommate_blocks_blocker (covered by PK on blocker_id, blocked_id)
--
-- Revised approach (safe for environments that already have data in roommate_blocks):
--   Instead of DROP TABLE + recreate (which destroys all block rows), we use
--   ALTER TABLE to swap FK actions and add the CHECK constraint in-place.
--   A fresh environment that has no roommate_blocks table yet gets a CREATE TABLE.

-- Fix 1: Backfill timestamp — required before adding the CHECK constraint.
UPDATE student_profiles
SET looking_updated_at = NOW()
WHERE looking_for_roommate = TRUE
  AND looking_updated_at IS NULL;

-- Add CHECK constraint (safe now that all TRUE rows have a timestamp).
ALTER TABLE student_profiles
ADD CONSTRAINT chk_looking_has_timestamp CHECK (
    looking_for_roommate = FALSE
    OR looking_updated_at IS NOT NULL
);

-- Fix 2 + 3: Create roommate_blocks with CASCADE if it doesn't exist yet
-- (fresh environment), otherwise alter FKs in-place to preserve existing data.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'roommate_blocks'
    ) THEN
        -- Fresh environment: create with correct constraints from the start.
        CREATE TABLE roommate_blocks (
            blocker_id UUID NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
            blocked_id UUID NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (blocker_id, blocked_id),
            CONSTRAINT chk_no_self_block CHECK (blocker_id <> blocked_id)
        );
    ELSE
        -- Existing environment: swap RESTRICT FKs to CASCADE without touching data.
        ALTER TABLE roommate_blocks
            DROP CONSTRAINT IF EXISTS roommate_blocks_blocker_id_fkey,
            DROP CONSTRAINT IF EXISTS roommate_blocks_blocked_id_fkey;

        ALTER TABLE roommate_blocks
            ADD CONSTRAINT roommate_blocks_blocker_id_fkey
                FOREIGN KEY (blocker_id) REFERENCES users (user_id) ON DELETE CASCADE,
            ADD CONSTRAINT roommate_blocks_blocked_id_fkey
                FOREIGN KEY (blocked_id) REFERENCES users (user_id) ON DELETE CASCADE;

        -- Add self-block check only if it doesn't already exist.
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.check_constraints
            WHERE constraint_name = 'chk_no_self_block'
        ) THEN
            ALTER TABLE roommate_blocks
                ADD CONSTRAINT chk_no_self_block CHECK (blocker_id <> blocked_id);
        END IF;
    END IF;
END;
$$;

-- Fix 3: Drop redundant index (blocker_id is the leftmost column of the PK,
-- so the PK index already satisfies all blocker_id lookups).
DROP INDEX IF EXISTS idx_roommate_blocks_blocker;

-- Keep only the blocked_id index (needed for reverse-lookup: "who is blocking me").
CREATE INDEX IF NOT EXISTS idx_roommate_blocks_blocked ON roommate_blocks (blocked_id);


-- Active: 1777192065763@@127.0.0.1@5432@roomies_db
-- Migration 008: Drop redundant idx_rent_index_lookup on rent_index
--
-- The UNIQUE constraint uq_rent_index (city, locality, room_type) already
-- creates a B-tree index covering the same columns. The explicit index
-- idx_rent_index_lookup is redundant and wastes storage + write overhead.

DROP INDEX IF EXISTS idx_rent_index_lookup;

-- Active: 1777192065763@@127.0.0.1@5432@roomies_db
-- Migration 009: Composite partial index for roommate feed city-filter EXISTS subquery
--
-- The roommate feed's city filter uses an EXISTS subquery on listings:
--   WHERE l.posted_by = sp.user_id AND l.deleted_at IS NULL
--         AND l.status = 'active' AND LOWER(l.city) LIKE LOWER($n) ESCAPE '\'
--
-- The existing idx_listings_posted_by covers posted_by alone but not the
-- full predicate. This index covers the common access pattern.
--
-- Revised (originally migration 013): The original index keyed raw city but the
-- query uses LOWER(l.city) LIKE LOWER($n), so the planner could not use it.
-- The index is recreated as an expression index on LOWER(city) so the EXISTS
-- subquery is covered and the planner can use an index scan.

DROP INDEX IF EXISTS idx_listings_posted_by_status_city;

CREATE INDEX IF NOT EXISTS idx_listings_posted_by_status_city
    ON listings (posted_by, status, LOWER(city))
    WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION enforce_saved_search_cap()
RETURNS TRIGGER AS $$
DECLARE
    active_count INTEGER;
BEGIN
    IF NEW.deleted_at IS NOT NULL THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext(NEW.user_id::text));

    SELECT COUNT(*)::int
    INTO active_count
    FROM saved_searches
    WHERE user_id = NEW.user_id
      AND deleted_at IS NULL
      AND (TG_OP <> 'UPDATE' OR search_id <> NEW.search_id);

    IF active_count >= 10 THEN
        RAISE EXCEPTION 'You can save at most 10 searches'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'saved_searches_active_cap_per_user';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_saved_searches_cap ON saved_searches;

CREATE TRIGGER trg_saved_searches_cap
    BEFORE INSERT OR UPDATE OF user_id, deleted_at ON saved_searches
    FOR EACH ROW EXECUTE FUNCTION enforce_saved_search_cap();


-- Migration 011: enforce uniqueness of city-wide (locality IS NULL) rent_index rows
-- Fix: deduplicate existing NULL-locality rows before adding the NULLS NOT DISTINCT
-- constraint. Keeps the newest row (highest computed_at) per (city, locality, room_type)
-- to avoid ALTER TABLE failures on databases that already ran the refresh cron.
--
-- Why only NULL-locality rows can be duplicates:
--   The old uq_rent_index constraint used standard NULL-distinct semantics, where
--   each NULL is treated as unequal to every other NULL, so it allowed multiple
--   (city, NULL, room_type) rows. Locality-specific rows (locality IS NOT NULL)
--   were already protected by the old constraint and cannot have duplicates.

BEGIN;

-- Step 1: Remove duplicate city-wide (locality IS NULL) rows, keeping the newest.
DELETE FROM rent_index
WHERE rent_index_id IN (
    SELECT rent_index_id
    FROM (
        SELECT
            rent_index_id,
            ROW_NUMBER() OVER (
                PARTITION BY city, room_type
                ORDER BY computed_at DESC, rent_index_id
            ) AS rn
        FROM rent_index
        WHERE locality IS NULL
    ) ranked
    WHERE rn > 1
);

-- Step 2: Swap in the NULL-aware unique constraint.
ALTER TABLE rent_index
    DROP CONSTRAINT IF EXISTS uq_rent_index;

ALTER TABLE rent_index
    ADD CONSTRAINT uq_rent_index UNIQUE NULLS NOT DISTINCT (city, locality, room_type);

COMMIT;

-- Migration 012: Pincode reference table for proximity search v2
-- Migration 012: Pincode reference table for proximity search v2
--
-- One row per pincode (not per post office). Read-only reference data,
-- seeded once via `npm run seed:pincodes` and refreshed rarely (India Post
-- pincode boundaries are effectively static; new pincodes are occasionally
-- introduced by India Post, which would warrant a re-run of the seed).
--
-- See PRD_proximity_search_v2.md (v3) for full background. Key points that
-- explain the shape of this table:
--
--   - `office_count` and `resolution` are auditability columns: they record
--     how many raw CSV rows collapsed into this pincode, and whether the
--     centroid came from a real office-type priority signal ('priority')
--     or a fallback average across all offices ('averaged'). If a pincode's
--     centroid ever looks wrong in production, these tell us at a glance
--     which code path produced it.
--
--   - `swap_corrected` flags rows where the seed script detected the raw
--     CSV had latitude/longitude swapped (confirmed present in the real
--     dataset — e.g. a Telangana pincode with latitude=79.0, longitude=17.0,
--     which is nonsensical as given but a valid coordinate once swapped).
--     This lets us audit exactly which pincodes were auto-corrected rather
--     than re-deriving it later.
--
--   - The lat/lng CHECK constraints use India's actual geographic extent
--     (not a generic world bounding box) because we've now profiled the
--     real seed data against this exact box (profile_pincodes.py) and
--     confirmed all correctable rows fall inside it after swap-correction.
--     This makes the constraint a meaningful guard against any future
--     seed-script regression that reintroduces garbage or swapped
--     coordinates, rather than a decorative check that would accept
--     anything.

CREATE TABLE IF NOT EXISTS pincodes (
    pincode        CHAR(6) PRIMARY KEY,
    city           VARCHAR(100) NOT NULL,   -- representative office name / locality
    district       VARCHAR(100),
    state          VARCHAR(100) NOT NULL,
    latitude       NUMERIC(10, 7) NOT NULL,
    longitude      NUMERIC(10, 7) NOT NULL,
    location       GEOMETRY(POINT, 4326),
    office_count   INTEGER NOT NULL,
    resolution     VARCHAR(20) NOT NULL,
    swap_corrected BOOLEAN NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_pincode_format CHECK (pincode ~ '^[0-9]{6}$'),
    CONSTRAINT chk_pincode_latitude CHECK (latitude BETWEEN 6.0 AND 38.0),
    CONSTRAINT chk_pincode_longitude CHECK (longitude BETWEEN 68.0 AND 98.0),
    CONSTRAINT chk_pincode_office_count CHECK (office_count > 0),
    CONSTRAINT chk_pincode_resolution CHECK (resolution IN ('priority', 'averaged'))
);

CREATE INDEX IF NOT EXISTS idx_pincodes_location ON pincodes USING GIST (location);

-- Reuse the existing sync_location_geometry() trigger function from migration 001
-- so `location` is always derived consistently, same as listings/properties.
CREATE OR REPLACE TRIGGER trg_pincodes_sync_location
    BEFORE INSERT OR UPDATE OF latitude, longitude ON pincodes
    FOR EACH ROW EXECUTE FUNCTION sync_location_geometry();


-- Migration 013: Fix verification_pending outbox event never firing
--
-- Root cause: trg_verification_status_changed (migration 002) was defined as
--   AFTER UPDATE OF status ON verification_requests
-- but src/services/verification.service.js's submitDocument() creates the
-- initial request via a plain INSERT (status defaults to 'pending' via the
-- column default, it is never UPDATEd into that state). Because the trigger
-- only listens for UPDATE OF status, the very first submission never fires
-- it, so no 'verification_pending' row is ever written to
-- verification_event_outbox, and the "documents received" acknowledgement
-- email is silently never sent.
--
-- Approval/rejection ('pending' -> 'verified' / 'pending' -> 'rejected') are
-- genuine UPDATE OF status transitions and already worked correctly — this
-- migration does not change that behavior.
--
-- Fix: widen the trigger to fire on INSERT as well as UPDATE OF status, and
-- guard the UPDATE no-op check with TG_OP so it doesn't affect the INSERT path
-- (there is no OLD row on INSERT, so NEW.status IS NOT DISTINCT FROM OLD.status
-- would error/short-circuit incorrectly if evaluated unconditionally).

CREATE OR REPLACE FUNCTION verification_status_changed()
    RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    IF NEW.status = 'verified' THEN
        INSERT INTO verification_event_outbox (event_type, user_id, request_id)
        VALUES ('verification_approved', NEW.user_id, NEW.request_id);

    ELSIF NEW.status = 'rejected' THEN
        INSERT INTO verification_event_outbox (event_type, user_id, request_id, rejection_reason)
        VALUES ('verification_rejected', NEW.user_id, NEW.request_id, NEW.admin_notes);

    ELSIF NEW.status = 'pending' THEN
        INSERT INTO verification_event_outbox (event_type, user_id, request_id)
        VALUES ('verification_pending', NEW.user_id, NEW.request_id);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    DROP TRIGGER IF EXISTS trg_verification_status_changed ON verification_requests;
END;
$$;

CREATE TRIGGER trg_verification_status_changed
    AFTER INSERT OR UPDATE OF status ON verification_requests
    FOR EACH ROW
    EXECUTE FUNCTION verification_status_changed();


-- Migration 014: Fix verification_rejected outbox event carrying the wrong reason
--
-- Root cause: trg_verification_status_changed (migration 002) populates
-- verification_event_outbox.rejection_reason from NEW.admin_notes:
--
--   INSERT INTO verification_event_outbox (event_type, user_id, request_id, rejection_reason)
--   VALUES ('verification_rejected', NEW.user_id, NEW.request_id, NEW.admin_notes);
--
-- But the actual rejection reason shown to the PG owner (passed by the caller
-- as `rejectionReason` in src/services/verification.service.js's rejectRequest())
-- is only ever written to pg_owner_profiles.rejection_reason — a different
-- table the trigger has no visibility into. verification_requests never had
-- its own rejection_reason column, so admin_notes (a separate, admin-internal
-- field, populated only when the admin optionally supplies one) was used by
-- mistake. When the admin doesn't supply adminNotes (the common case), this
-- column is NULL, and the outbox — and therefore the rejection email — falls
-- back to the generic "Please review the requirements and resubmit." message,
-- silently discarding the real reason.
--
-- Fix: give verification_requests its own rejection_reason column, populate
-- it from the same value written to pg_owner_profiles.rejection_reason, and
-- point the trigger at it instead of admin_notes. admin_notes remains
-- untouched as admin-internal commentary, distinct from the reason shown to
-- the PG owner.
--
-- Existing rows: rejection_reason is backfilled from pg_owner_profiles for any
-- already-rejected requests, on a best-effort basis (matches the most recent
-- rejected request per user, since verification_requests doesn't retain a
-- direct link to which historical rejection produced the profile's current
-- reason). New rejections going forward are correct by construction because
-- the application code now writes the reason directly at rejection time.

ALTER TABLE verification_requests
    ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Best-effort backfill for pre-existing rejected requests: only affects the
-- single most recent rejected request per user (the one whose reason is
-- still visible on pg_owner_profiles today); older superseded rejections
-- cannot be recovered since the original per-request reason was never stored.
UPDATE verification_requests vr
SET rejection_reason = pop.rejection_reason
FROM pg_owner_profiles pop
WHERE vr.user_id = pop.user_id
  AND vr.status = 'rejected'
  AND vr.rejection_reason IS NULL
  AND pop.rejection_reason IS NOT NULL
  AND vr.request_id = (
      SELECT vr2.request_id
      FROM verification_requests vr2
      WHERE vr2.user_id = vr.user_id
        AND vr2.status = 'rejected'
      ORDER BY vr2.reviewed_at DESC NULLS LAST, vr2.submitted_at DESC
      LIMIT 1
  );

CREATE OR REPLACE FUNCTION verification_status_changed()
    RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    IF NEW.status = 'verified' THEN
        INSERT INTO verification_event_outbox (event_type, user_id, request_id)
        VALUES ('verification_approved', NEW.user_id, NEW.request_id);

    ELSIF NEW.status = 'rejected' THEN
        INSERT INTO verification_event_outbox (event_type, user_id, request_id, rejection_reason)
        VALUES ('verification_rejected', NEW.user_id, NEW.request_id, NEW.rejection_reason);

    ELSIF NEW.status = 'pending' THEN
        INSERT INTO verification_event_outbox (event_type, user_id, request_id)
        VALUES ('verification_pending', NEW.user_id, NEW.request_id);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    DROP TRIGGER IF EXISTS trg_verification_status_changed ON verification_requests;
END;
$$;

CREATE TRIGGER trg_verification_status_changed
    AFTER INSERT OR UPDATE OF status ON verification_requests
    FOR EACH ROW
    EXECUTE FUNCTION verification_status_changed();

-- Migration 015: Ensure SRID 4326 (WGS84) exists in spatial_ref_sys
--
-- Root cause: on some postgis/postgis Docker images (confirmed on
-- postgis/postgis:16-3.4-alpine), `CREATE EXTENSION postgis` installs the
-- spatial_ref_sys TABLE but does not always populate it with the ~8,500
-- standard EPSG rows the extension script is supposed to load. This is a
-- packaging/init quirk of that image, not an application bug — simple point
-- construction (ST_SetSRID, used by sync_location_geometry()'s trigger) does
-- not need a spatial_ref_sys row and works fine either way, which is why this
-- was invisible until a query that actually needs geodetic math
-- (ST_DWithin on a ::geography cast, used by listing.service.js's
-- proximity/lat-lng search) ran and failed with:
--   "Cannot find SRID (4326) in spatial_ref_sys"
--
-- Fix: insert the standard WGS84 (SRID 4326) definition directly if it's
-- missing. This is the only SRID this application ever uses (every
-- ST_SetSRID / ST_MakePoint call in the codebase is hardcoded to 4326), so a
-- single targeted row is sufficient — no need to reproduce the full EPSG
-- dataset. ON CONFLICT DO NOTHING makes this safe to run against an
-- environment where spatial_ref_sys is already correctly populated (e.g. a
-- non-alpine or differently-built postgis image).

INSERT INTO spatial_ref_sys (srid, auth_name, auth_srid, srtext, proj4text)
VALUES (
    4326,
    'EPSG',
    4326,
    'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]',
    '+proj=longlat +datum=WGS84 +no_defs'
)
ON CONFLICT (srid) DO NOTHING;
