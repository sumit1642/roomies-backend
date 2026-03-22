# Roomies Backend — Test Progress & Reference Sheet

**Base URL:** `http://localhost:3000/api/v1`
**Test started:** Phase 1 → Phase 4 end-to-end manual test via Thunder Client

> **Token reminder:** Access tokens expire in **15 minutes**. Re-login before each step if you've taken a break.

---

## Section 1: All Persona Credentials

### Admin — Sumit Verma

| Field | Value |
|---|---|
| Full Name | Sumit Verma |
| Email | sumit.verma@roomies-admin.in |
| Password | Admin@1234 |
| Role | admin |
| Phone | *(none)* |
| Note | Seeded directly via SQL — no registration endpoint |

---

### PG Owner 1 — Meera Kapoor

| Field | Value |
|---|---|
| Full Name | Meera Kapoor |
| Email | meera.kapoor@gmail.com |
| Password | Meera@5678 |
| Role | pg_owner |
| Business Name | Kapoor Ladies PG |
| Phone | 9845001234 *(set in profile update)* |
| City | Bengaluru |
| Locality | Koramangala |
| Operating Since | 2018 |
| Verification Status | verified |

---

### PG Owner 2 — Ranjit Singh

| Field | Value |
|---|---|
| Full Name | Ranjit Singh |
| Email | ranjit.singh1985@gmail.com |
| Password | Ranjit@9876 |
| Role | pg_owner |
| Business Name | Singh's Co-Ed Hostel |
| Phone | *(none set)* |
| City | Delhi |
| Locality | Karol Bagh |
| Verification Status | verified |

---

### Student 1 — Priya Sharma

| Field | Value |
|---|---|
| Full Name | Priya Sharma |
| Email | priya.sharma@iitd.ac.in |
| Password | Priya@2024 |
| Role | student |
| Phone | *(none)* |
| Gender | female |
| Date of Birth | 2002-05-14 |
| Course | B.Tech Computer Science |
| Year of Study | 3 |
| Institution | IIT Delhi (iitd.ac.in) |
| Email Verified | YES — auto-verified via institution domain match |
| City | Delhi |

---

### Student 2 — Arjun Mehta

| Field | Value |
|---|---|
| Full Name | Arjun Mehta |
| Email | arjun.mehta97@gmail.com |
| Password | Arjun@5555 |
| Role | student |
| Phone | *(none)* |
| Gender | male |
| Date of Birth | 1997-11-22 |
| Course | MBA |
| Year of Study | 2 |
| Institution | *(none — Gmail domain)* |
| Email Verified | YES — verified via OTP (OTP was: 238070) |
| City | Bengaluru |

---

### Student 3 — Sneha Pillai

| Field | Value |
|---|---|
| Full Name | Sneha Pillai |
| Email | sneha.pillai2003@gmail.com |
| Password | Sneha@7777 |
| Role | student |
| Phone | *(none)* |
| Gender | female |
| Date of Birth | 2003-03-08 |
| Course | LLB |
| Year of Study | 1 |
| Institution | *(none — Gmail domain)* |
| Email Verified | YES — verified via OTP (OTP was: 692211) |
| City | Delhi |

---

## Section 2: All Captured UUIDs

### Identity

| Variable | UUID |
|---|---|
| `SUMIT_USER_ID` | `0513b77d-8731-416f-9ce2-84612376ebd1` |
| `MEERA_USER_ID` | `614d440d-6019-4ab4-b406-1c7c0557de3b` |
| `RANJIT_USER_ID` | `0618fb69-d370-4f0b-90b6-b5de8d3ea26e` |
| `PRIYA_USER_ID` | `1927d309-3672-4d96-94e3-99682575f610` |
| `ARJUN_USER_ID` | `8237e29c-70d3-4bf5-a307-907f5d972cd6` |
| `SNEHA_USER_ID` | `c622dd4e-01aa-42ec-9354-11d491813861` |

### Verification Requests

| Variable | UUID |
|---|---|
| `MEERA_REQUEST_ID` | `939cb12d-1059-42a5-bbae-b72909f6c0a1` |
| `RANJIT_REQUEST_ID` | `53960034-7927-47c4-a3dd-dae847cea578` |

### Properties

| Variable | UUID |
|---|---|
| `MEERA_PROPERTY_ID` | `56a1aacd-0de2-43e3-b36f-ad6f13cda57a` |
| `RANJIT_PROPERTY_ID` | `7f78bab0-7331-4bde-9a06-9d9c8cd61c35` |

### Listings

| Variable | UUID | Description |
|---|---|---|
| `MEERA_LISTING_1_ID` | `17e026a9-078d-4e22-b5dd-2d5cceab8ff4` | Shared room ₹7,500/mo — Koramangala |
| `MEERA_LISTING_2_ID` | `e3469589-c7ef-4e22-b797-c9a027b84c17` | Single room ₹12,000/mo — Koramangala |
| `RANJIT_LISTING_1_ID` | `6488da99-e624-4147-9a5a-e2b893e0d30a` | Hostel bed ₹5,000/mo — Karol Bagh |
| `RANJIT_LISTING_2_ID` | `5083c6b1-9e58-49d3-9db4-66ce9256da1e` | Double sharing ₹8,000/mo — Karol Bagh |
| `PRIYA_LISTING_ID` | `a5b57e2b-81f0-4bb5-a338-864ceea0ea1b` | student_room ₹9,500/mo — Hauz Khas, Delhi |
| `ARJUN_LISTING_ID` | `0b9c6973-1173-415d-905b-8b7db38faa4d` | student_room ₹11,000/mo — Indiranagar, Bengaluru |

### Interest Requests

| Variable | UUID | Pipeline |
|---|---|---|
| `PRIYA_INTEREST_ID` | `4df4d27a-a74b-4d00-bfa6-46eca5beea10` | Priya → Ranjit listing 1 |
| `ARJUN_INTEREST_ID` | *(not yet captured)* | Arjun → Meera listing 1 |
| `SNEHA_INTEREST_ID` | *(not yet captured)* | Sneha → Ranjit listing 2 |

### Connections

| Variable | UUID | Parties | Status |
|---|---|---|---|
| `PRIYA_CONNECTION_ID` | `5cba1362-6ab1-4616-b929-8f333797f9dd` | Priya ↔ Ranjit | **confirmed** ✅ |
| `ARJUN_CONNECTION_ID` | *(not yet captured)* | Arjun ↔ Meera | not started |
| `SNEHA_CONNECTION_ID` | *(not yet captured)* | Sneha ↔ Ranjit | not started |

### Ratings

| Variable | UUID | Description |
|---|---|---|
| `PRIYA_RATES_RANJIT_ID` | `cd503b1c-52e6-4fae-881f-a3fb39346e66` | Priya rates Ranjit (user) ✅ |
| `PRIYA_RATES_RANJIT_PROPERTY_ID` | `6fdee2ac-ae86-4bd8-9ca5-83fcc0a4354f` | Priya rates Ranjit's property ✅ |
| `ARJUN_RATES_MEERA_ID` | *(not yet captured)* | Arjun rates Meera (user) — needed for Phase 4 report test |

---

## Section 3: Property & Listing Details

### Meera's Property — Kapoor Ladies PG

Located at `12.9352, 77.6245` (Koramangala, Bengaluru). Women-only PG, 12 rooms, 10pm curfew. No male visitors past 8pm.

### Ranjit's Property — Singh's Co-Ed Hostel

Located at `28.6448, 77.1903` (Karol Bagh, Delhi — near metro station). Co-ed, 20 rooms, gate closes 11pm. No alcohol inside rooms.

### Priya's Student Room Listing

Located at `28.5494, 77.2001` (Hauz Khas Village, near IIT Delhi main gate). 2BHK share, female only, ₹9,500/mo.

### Arjun's Student Room Listing

Located at `12.9784, 77.6408` (CMH Road, Indiranagar, near metro). 3BHK share, male preferred, ₹11,000/mo.

---

## Section 4: Phase Completion Status

### Phase 1 — Auth & Identity ✅ COMPLETE

All 6 personas registered, verified, and profiles updated. Sumit can access the admin queue. Meera and Ranjit are both verified PG owners.

### Phase 2 — Properties & Listings ✅ COMPLETE

Both PG owner properties created. All 6 listings created (2 for Meera, 2 for Ranjit, 1 for Priya, 1 for Arjun). Search tests passed: city filter, rent range filter, and proximity search (3km around Karol Bagh metro) all returned correct results. Sneha saved Ranjit's first listing.

### Phase 3 — Interaction Pipeline 🔄 IN PROGRESS

**Pipeline 1: Priya → Ranjit listing 1 (hostel_stay)**
- ✅ Step 34: Priya sent interest
- ✅ Step 35: Ranjit viewed interests
- ✅ Step 36: Ranjit accepted → connection created
- ✅ Step 37: Priya confirmed
- ✅ Step 38: Ranjit confirmed → `confirmationStatus: confirmed`
- ✅ Step 39: Priya rates Ranjit (user) — `PRIYA_RATES_RANJIT_ID` = `cd503b1c-52e6-4fae-881f-a3fb39346e66`
- ✅ Step 40: Priya rates Ranjit's property — `6fdee2ac-ae86-4bd8-9ca5-83fcc0a4354f`
- ⏳ Step 41: Ranjit rates Priya — **CURRENTLY HERE**

**Pipeline 2: Arjun → Meera listing 1 (pg_stay)** — NOT STARTED (Steps 42–47)

**Pipeline 3: Sneha → Ranjit listing 2 (hostel_stay)** — NOT STARTED (Steps 48–52)

**Notification & public rating checks** — NOT STARTED (Steps 53–57)

### Phase 4 — Reputation Moderation ❌ NOT STARTED (Steps 58–61)

---

## Section 5: Bugs Found & Fixed During This Session

### Bug 1 — `amenityIds is not iterable`
**File:** `src/services/listing.service.js` (~line 345)
**Fix:** Added `amenityIds = []` as default in the destructuring of the request body.

### Bug 2 — `invalid input syntax for type bigint: "NaN"`
**File:** `src/services/listing.service.js` (same destructuring block)
**Fix:** Added `limit = 20` as default so search queries don't send NaN to PostgreSQL.

### Bug 3 — PostGIS SRID 4326 missing from `spatial_ref_sys`
**Root cause:** `spatial_ref_sys` table was empty (PostGIS extension had corrupted state).
**Fix:** Dropped and recreated the PostGIS extension, then re-added the `location` geometry columns and indexes that CASCADE had dropped:
```sql
DROP EXTENSION IF EXISTS postgis CASCADE;
CREATE EXTENSION postgis;
ALTER TABLE properties ADD COLUMN location GEOMETRY(POINT, 4326);
ALTER TABLE listings ADD COLUMN location GEOMETRY(POINT, 4326);
-- Re-created indexes and ran UPDATE to backfill geometry from lat/lng
```

### Bug 4 — Proximity search returning empty results
**File:** `src/db/utils/spatial.js`
**Root cause:** Hostel/PG listings store `NULL` lat/lng and inherit location from their parent property. The original query only checked `l.location`, which was NULL for these listing types.
**Fix:** Added `LEFT JOIN properties p ON p.property_id = l.property_id` and used `COALESCE(l.location, p.location)` in the `ST_DWithin` call.

### Bug 5 — `column "idempotency_key" of relation "notifications" does not exist`
**Fix:** Migration SQL:
```sql
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(100) UNIQUE;
```

### Bug 6 — Bad bcrypt hash for Sumit (admin seed)
**Root cause:** Pre-computed hash in the test plan was invalid.
**Fix:** Regenerated hash at runtime and updated via SQL:
```bash
node -e "import('bcryptjs').then(b => b.default.hash('Admin@1234', 10).then(console.log))"
```

### Bug 7 — `ON CONFLICT` clause doesn't match partial index on `ratings`
**File:** `src/services/rating.service.js` (lines 81 and 128)
**Root cause:** The `ON CONFLICT` clause was missing the `WHERE deleted_at IS NULL` predicate required to match the partial unique index `idx_ratings_one_per_connection`.
**Fix (Option B — correct long-term fix):** Updated both conflict targets to include the partial index predicate:
```sql
ON CONFLICT (reviewer_id, connection_id, reviewee_id) WHERE deleted_at IS NULL DO NOTHING
```
This preserves soft-deletion semantics so that a soft-deleted rating does not permanently block re-rating on the same connection.

---

## Section 6: Next Steps

When resuming, the very next request is **Step 41 — Ranjit rates Priya**.

Login as Ranjit first, then:

**Method:** `POST`
**Auth:** Bearer `RANJIT_TOKEN`
**URL:** `http://localhost:3000/api/v1/ratings`
**Body:**
```json
{
  "connectionId": "5cba1362-6ab1-4616-b929-8f333797f9dd",
  "revieweeType": "user",
  "revieweeId": "1927d309-3672-4d96-94e3-99682575f610",
  "overallScore": 5,
  "cleanlinessScore": 5,
  "reliabilityScore": 5,
  "comment": "Priya was an excellent guest. Always on time with rent, very clean, and respectful of the house rules. Would happily host again."
}
```

Then continue with Pipelines 2 and 3 (Steps 42-52), notification checks (53-57), and Phase 4 moderation (58-61).

---

## Section 7: Quick Reference SQL

```sql
-- Check rating aggregates after Pipeline 1 completes
SELECT email, average_rating, rating_count
FROM users
WHERE email IN (
  'ranjit.singh1985@gmail.com',
  'meera.kapoor@gmail.com',
  'priya.sharma@iitd.ac.in'
);

-- Check property rating aggregate
SELECT property_name, average_rating, rating_count
FROM properties
WHERE property_id IN (
  '7f78bab0-7331-4bde-9a06-9d9c8cd61c35',  -- Ranjit's property
  '56a1aacd-0de2-43e3-b36f-ad6f13cda57a'   -- Meera's property
);

-- Check all connections and their status
SELECT connection_id, confirmation_status, initiator_confirmed, counterpart_confirmed
FROM connections
ORDER BY created_at DESC;

-- Check notification queue depth
-- redis-cli LLEN bull:notification-delivery:wait
```

---

*Last updated: Phase 3 in progress — Pipeline 1 Steps 39 and 40 complete. Stopped at Step 41 (Ranjit rates Priya).*