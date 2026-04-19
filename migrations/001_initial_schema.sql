-- Active: 1774765370673@@127.0.0.1@5432@roomies_db
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

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