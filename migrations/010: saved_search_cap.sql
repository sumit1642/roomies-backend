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
