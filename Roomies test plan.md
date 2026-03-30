# ROOMIES — Manual Testing Guide

**Phase 1 → Phase 4 · Thunder Client · Step-by-Step**

Everything you need to test the backend end-to-end: **Personas · SQL seeds · Request bodies · Expected responses**

---

## How to Use This Guide

This document is your single source of truth for the entire manual test run. It walks you through every HTTP request in
the exact order it must be sent, explains what to expect, and tells you exactly which values to copy and save for the
next step.

**Ground rules before you begin:**

- Thunder Client is your HTTP client. Every request is made there, one at a time.
- The base URL for every request is: `http://localhost:3000/api/v1`
- Wherever you see **📋 CAPTURE**, stop and save that value. You will need it in a later step.
- Wherever you see **⚠️**, read carefully — that note describes a common mistake or a known behaviour that might look
  like a bug but isn't.
- Wherever you see **📌**, it's an informational tip that helps you understand why something works the way it does.
- Steps are numbered globally across the entire document. Never skip a step — later steps depend on data created in
  earlier ones.

> **📌** Auth tokens expire in 15 minutes by default. If you take a long break, re-login with the relevant persona and
> get a fresh token before continuing.
>
> **⚠️** Run the server with `npm run dev` and keep it running throughout. The media worker and notification worker
> start automatically with the server.

---

## Section 1: Persona Reference

Below are all the fake-but-realistic personas used in this test. Keep this page bookmarked — you will come back to it
constantly.

### Admin — Sumit Verma

Sumit is the platform admin. He cannot be registered via API — he must be seeded directly into the database. He approves
PG owner verifications and resolves rating reports.

| Field         | Value                        |
| ------------- | ---------------------------- |
| **Full Name** | Sumit Verma                  |
| **Email**     | sumit.verma@roomies-admin.in |
| **Password**  | Admin@1234                   |
| **Role**      | admin                        |
| **City**      | Delhi (admin, no listings)   |

### PG Owner 1 — Meera Kapoor

Meera runs a women's PG in Koramangala, Bengaluru. She will be registered via the API, submit documents, get verified by
Sumit, then create 1 property and 2 listings.

| Field             | Value                  |
| ----------------- | ---------------------- |
| **Full Name**     | Meera Kapoor           |
| **Email**         | meera.kapoor@gmail.com |
| **Password**      | Meera@5678             |
| **Business Name** | Kapoor Ladies PG       |
| **Role**          | pg_owner               |
| **City**          | Bengaluru              |

### PG Owner 2 — Ranjit Singh

Ranjit runs a co-ed hostel in Karol Bagh, Delhi. He will also go through the full PG owner pipeline — register, submit
documents, get verified, then create 1 property and 2 listings.

| Field             | Value                      |
| ----------------- | -------------------------- |
| **Full Name**     | Ranjit Singh               |
| **Email**         | ranjit.singh1985@gmail.com |
| **Password**      | Ranjit@9876                |
| **Business Name** | Singh's Co-Ed Hostel       |
| **Role**          | pg_owner                   |
| **City**          | Delhi                      |

### Student 1 — Priya Sharma

Priya is from IIT Delhi — her email domain will trigger automatic institution verification, so she will **not** need an
OTP. She posts one `student_room` listing in Delhi and also sends interest in Ranjit's PG.

| Field              | Value                                                             |
| ------------------ | ----------------------------------------------------------------- |
| **Full Name**      | Priya Sharma                                                      |
| **Email**          | priya.sharma@iitd.ac.in                                           |
| **Password**       | Priya@2024                                                        |
| **Role**           | student                                                           |
| **Auto-verified?** | YES — `iitd.ac.in` domain triggers institution match              |
| **City**           | Delhi                                                             |
| **Listing**        | Posts 1 `student_room` in Hauz Khas, Delhi                        |
| **Sends interest** | Ranjit's PG listing → full pipeline (connection → confirm → rate) |

### Student 2 — Arjun Mehta

Arjun has a regular Gmail address. He will go through the OTP email verification flow. He posts one `student_room` in
Bengaluru and sends interest in Meera's PG.

| Field              | Value                                                            |
| ------------------ | ---------------------------------------------------------------- |
| **Full Name**      | Arjun Mehta                                                      |
| **Email**          | arjun.mehta97@gmail.com                                          |
| **Password**       | Arjun@5555                                                       |
| **Role**           | student                                                          |
| **Auto-verified?** | NO — must verify via OTP                                         |
| **City**           | Bengaluru                                                        |
| **Listing**        | Posts 1 `student_room` in Indiranagar, Bengaluru                 |
| **Sends interest** | Meera's PG listing → full pipeline (connection → confirm → rate) |

### Student 3 — Sneha Pillai

Sneha is a student who only looks for rooms — she does not post any listings herself. She sends interest in one of
Ranjit's Delhi listings and also saves some listings. She goes through OTP verification.

| Field              | Value                                         |
| ------------------ | --------------------------------------------- |
| **Full Name**      | Sneha Pillai                                  |
| **Email**          | sneha.pillai2003@gmail.com                    |
| **Password**       | Sneha@7777                                    |
| **Role**           | student                                       |
| **Auto-verified?** | NO — must verify via OTP                      |
| **City**           | Delhi                                         |
| **Listing**        | None — Sneha is a pure seeker                 |
| **Sends interest** | Ranjit's second Delhi listing → full pipeline |

---

## Section 2: Database Seeds (Run Before Any API Calls)

Some data cannot be created through the API and must be inserted directly into the database. Run the SQL below in
sequence using your PostgreSQL client (psql, TablePlus, DBeaver — your choice) before sending a single HTTP request.

> **⚠️** Always run these SQL statements against `roomies_db`, not the default `postgres` database. Confirm with
> `\c roomies_db` in psql before running.

### Seed A — Institution (iitd.ac.in)

This enables Priya's auto-verification. The amenity seed is handled by `npm run seed:amenities` — run that separately
from the command line.

```sql
INSERT INTO institutions (name, city, state, email_domain, type)
VALUES (
  'Indian Institute of Technology Delhi',
  'Delhi',
  'Delhi',
  'iitd.ac.in',
  'IIT'
) ON CONFLICT DO NOTHING;
```

### Seed B — Admin User (Sumit Verma)

This creates Sumit's account with a bcrypt hash for `Admin@1234` (cost 10) and grants him the admin role. The hash below
is pre-computed — do not regenerate it unless you change the password.

```sql
-- Step 1: Insert the user row
INSERT INTO users (email, password_hash, account_status, is_email_verified)
VALUES (
  'sumit.verma@roomies-admin.in',
  '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy',
  'active',
  TRUE
) RETURNING user_id;
```

**📋 CAPTURE: Copy the `user_id` returned above — you need it for the next INSERT.**

```sql
-- Step 2: Insert the admin role (replace <ADMIN_USER_ID> with the UUID above)
INSERT INTO user_roles (user_id, role_name)
VALUES ('<ADMIN_USER_ID>', 'admin');
```

> **📌** There is no profile table for admins (no `student_profiles` or `pg_owner_profiles` row). That is correct — the
> admin role is granted directly via `user_roles`.

### Seed C — Run Amenity Seed Script

From your terminal in the project root, run the following. This inserts all 19 amenities used in the listings:

```bash
npm run seed:amenities
```

> **📌** This script is idempotent — safe to run multiple times. It uses `ON CONFLICT DO NOTHING`.

---

## Section 3: Token Management in Thunder Client

Every protected endpoint requires a Bearer token in the `Authorization` header. Thunder Client makes this easy once you
understand the pattern.

**How to set the Authorization header:** In Thunder Client, open a request and click the **Auth** tab. Select **Bearer
Token** from the dropdown. Paste the `accessToken` value from the login response into the Token field. Thunder Client
automatically adds `Authorization: Bearer <token>` to the request.

### Personas and Their Tokens — Your Tracking Table

Fill this in as you go. Each login response gives you an `accessToken` and a `refreshToken`.

| Persona             | accessToken (save here)            | Key UUIDs to capture                 |
| ------------------- | ---------------------------------- | ------------------------------------ |
| Sumit (admin)       | Login first, then paste            | user_id from seed SQL                |
| Meera (PG owner 1)  | After registration                 | user_id, property_id, listing IDs    |
| Ranjit (PG owner 2) | After registration                 | user_id, property_id, listing IDs    |
| Priya (student 1)   | After registration (auto-verified) | user_id, interest IDs, connection ID |
| Arjun (student 2)   | After OTP verify                   | user_id, interest IDs, connection ID |
| Sneha (student 3)   | After OTP verify                   | user_id, interest IDs, connection ID |

> **⚠️** Access tokens expire in 15 minutes. If a request returns `401` with `'Token has expired'` mid-test, re-login
> with that persona and replace the token before retrying.

---

## PHASE 1: AUTH & IDENTITY

_Register all personas · Verify emails · Build profiles · Admin verification pipeline_

---

### PG Owner 1: Meera Kapoor

#### STEP 1 — Register Meera

**Method:** `POST` | **URL:** `http://localhost:3000/api/v1/auth/register`

```json
{
	"email": "meera.kapoor@gmail.com",
	"password": "Meera@5678",
	"role": "pg_owner",
	"fullName": "Meera Kapoor",
	"businessName": "Kapoor Ladies PG"
}
```

**Expected:** `201 Created` with `accessToken`, `refreshToken`, and user object in body.

> **📋 CAPTURE: Save `accessToken` as `MEERA_TOKEN`. Save `data.user.userId` as `MEERA_USER_ID`.**
>
> **📌** Cookies are also set automatically (HttpOnly). Thunder Client won't show them in the UI — that's fine, the body
> tokens are what matter for API testing.

---

#### STEP 2 — Login as Sumit (admin) to prepare for later verification steps

**Method:** `POST` | **URL:** `http://localhost:3000/api/v1/auth/login`

```json
{
	"email": "sumit.verma@roomies-admin.in",
	"password": "Admin@1234"
}
```

**Expected:** `200 OK` with `accessToken` in body.

> **📋 CAPTURE: Save `accessToken` as `SUMIT_TOKEN`. Save `data.user.userId` as `SUMIT_USER_ID`.**

---

#### STEP 3 — Meera submits a verification document

**Method:** `POST` | **Auth:** Bearer `MEERA_TOKEN` | **URL:**
`http://localhost:3000/api/v1/pg-owners/{MEERA_USER_ID}/documents`

Replace `{MEERA_USER_ID}` with the UUID you saved.

```json
{
	"documentType": "owner_id",
	"documentUrl": "https://storage.example.com/docs/meera-owner-id.pdf"
}
```

**Expected:** `201 Created`. The `verification_requests` row is now in the DB with `status = pending`.

> **📋 CAPTURE: Save `data.request_id` as `MEERA_REQUEST_ID`.**

---

#### STEP 4 — Sumit views the verification queue

**Method:** `GET` | **Auth:** Bearer `SUMIT_TOKEN` | **URL:** `http://localhost:3000/api/v1/admin/verification-queue`

**Expected:** `200 OK` with an array of pending requests. Meera's request should appear with oldest-first ordering.

> **📌** The queue uses keyset pagination — if there are more than 20 items, a `nextCursor` object is included. For now
> there is only one item, so `nextCursor` will be `null`.

---

#### STEP 5 — Sumit approves Meera's verification

**Method:** `POST` | **Auth:** Bearer `SUMIT_TOKEN` | **URL:**
`http://localhost:3000/api/v1/admin/verification-queue/{MEERA_REQUEST_ID}/approve`

```json
{
	"adminNotes": "Owner ID looks legitimate. Approved."
}
```

**Expected:** `200 OK` with `{ requestId, status: "verified" }`.

> **📌** This atomically updates both `verification_requests.status = 'verified'` and
> `pg_owner_profiles.verification_status = 'verified'` in one transaction.

---

#### STEP 6 — Meera updates her PG owner profile

**Method:** `PUT` | **Auth:** Bearer `MEERA_TOKEN` | **URL:**
`http://localhost:3000/api/v1/pg-owners/{MEERA_USER_ID}/profile`

```json
{
	"businessDescription": "A safe and comfortable PG exclusively for women in Koramangala. Homely food, 24/7 security, and fast WiFi.",
	"businessPhone": "9845001234",
	"operatingSince": 2018
}
```

**Expected:** `200 OK` with updated profile object.

---

### PG Owner 2: Ranjit Singh

#### STEP 7 — Register Ranjit

**Method:** `POST` | **URL:** `http://localhost:3000/api/v1/auth/register`

```json
{
	"email": "ranjit.singh1985@gmail.com",
	"password": "Ranjit@9876",
	"role": "pg_owner",
	"fullName": "Ranjit Singh",
	"businessName": "Singh's Co-Ed Hostel"
}
```

**Expected:** `201 Created`.

> **📋 CAPTURE: Save `accessToken` as `RANJIT_TOKEN`. Save `data.user.userId` as `RANJIT_USER_ID`.**

---

#### STEP 8 — Ranjit submits a verification document

**Method:** `POST` | **Auth:** Bearer `RANJIT_TOKEN` | **URL:**
`http://localhost:3000/api/v1/pg-owners/{RANJIT_USER_ID}/documents`

```json
{
	"documentType": "rental_agreement",
	"documentUrl": "https://storage.example.com/docs/ranjit-rental-agreement.pdf"
}
```

**Expected:** `201 Created`.

> **📋 CAPTURE: Save `data.request_id` as `RANJIT_REQUEST_ID`.**

---

#### STEP 9 — Sumit approves Ranjit's verification

**Method:** `POST` | **Auth:** Bearer `SUMIT_TOKEN` | **URL:**
`http://localhost:3000/api/v1/admin/verification-queue/{RANJIT_REQUEST_ID}/approve`

```json
{
	"adminNotes": "Rental agreement verified. Approved."
}
```

**Expected:** `200 OK`.

---

### Student 1: Priya Sharma (auto-verified via institution)

#### STEP 10 — Register Priya

**Method:** `POST` | **URL:** `http://localhost:3000/api/v1/auth/register`

```json
{
	"email": "priya.sharma@iitd.ac.in",
	"password": "Priya@2024",
	"role": "student",
	"fullName": "Priya Sharma"
}
```

**Expected:** `201 Created`. In the response, check that `data.user.isEmailVerified` is `true`.

> **📋 CAPTURE: Save `accessToken` as `PRIYA_TOKEN`. Save `data.user.userId` as `PRIYA_USER_ID`.**
>
> **📌** Priya's registration triggers a JOIN against the `institutions` table on `iitd.ac.in`. Since we seeded that
> domain in Seed A, she is auto-verified in the same transaction. She skips the OTP step entirely.

---

#### STEP 11 — Priya updates her student profile

**Method:** `PUT` | **Auth:** Bearer `PRIYA_TOKEN` | **URL:**
`http://localhost:3000/api/v1/students/{PRIYA_USER_ID}/profile`

```json
{
	"bio": "3rd year B.Tech CSE student at IIT Delhi. Non-smoker, vegetarian, early riser.",
	"course": "B.Tech Computer Science",
	"yearOfStudy": 3,
	"gender": "female",
	"dateOfBirth": "2002-05-14"
}
```

**Expected:** `200 OK` with updated profile.

---

### Student 2: Arjun Mehta (OTP verification flow)

#### STEP 12 — Register Arjun

**Method:** `POST` | **URL:** `http://localhost:3000/api/v1/auth/register`

```json
{
	"email": "arjun.mehta97@gmail.com",
	"password": "Arjun@5555",
	"role": "student",
	"fullName": "Arjun Mehta"
}
```

**Expected:** `201 Created`. `data.user.isEmailVerified` will be `false` because `gmail.com` is not a known institution
domain.

> **📋 CAPTURE: Save `accessToken` as `ARJUN_TOKEN`. Save `data.user.userId` as `ARJUN_USER_ID`.**

---

#### STEP 13 — Arjun sends an OTP to his email

**Method:** `POST` | **Auth:** Bearer `ARJUN_TOKEN` | **URL:** `http://localhost:3000/api/v1/auth/otp/send`

No body needed.

**Expected:** `200 OK` with message `'OTP sent to your email'`.

> **📌** The server uses Ethereal Mail in development. Check the server console output for a line like:
> `OTP email sent — preview URL: https://ethereal.email/message/...` Open that URL in a browser to see the actual OTP
> code.

---

#### STEP 14 — Arjun verifies his OTP

**Method:** `POST` | **Auth:** Bearer `ARJUN_TOKEN` | **URL:** `http://localhost:3000/api/v1/auth/otp/verify`

Replace `123456` with the actual OTP from Ethereal:

```json
{
	"otp": "123456"
}
```

**Expected:** `200 OK` with message `'Email verified successfully'`.

---

#### STEP 15 — Arjun updates his student profile

**Method:** `PUT` | **Auth:** Bearer `ARJUN_TOKEN` | **URL:**
`http://localhost:3000/api/v1/students/{ARJUN_USER_ID}/profile`

```json
{
	"bio": "2nd year MBA student at IIM Bangalore. Looking for a quiet flatmate. Non-smoker, occasionally drinks.",
	"course": "MBA",
	"yearOfStudy": 2,
	"gender": "male",
	"dateOfBirth": "1997-11-22"
}
```

**Expected:** `200 OK`.

---

### Student 3: Sneha Pillai (OTP verification flow)

#### STEP 16 — Register Sneha

**Method:** `POST` | **URL:** `http://localhost:3000/api/v1/auth/register`

```json
{
	"email": "sneha.pillai2003@gmail.com",
	"password": "Sneha@7777",
	"role": "student",
	"fullName": "Sneha Pillai"
}
```

**Expected:** `201 Created`.

> **📋 CAPTURE: Save `accessToken` as `SNEHA_TOKEN`. Save `data.user.userId` as `SNEHA_USER_ID`.**

---

#### STEP 17 — Sneha sends an OTP

**Method:** `POST` | **Auth:** Bearer `SNEHA_TOKEN` | **URL:** `http://localhost:3000/api/v1/auth/otp/send`

**Expected:** `200 OK`. Check server console for Ethereal preview URL.

---

#### STEP 18 — Sneha verifies her OTP

**Method:** `POST` | **Auth:** Bearer `SNEHA_TOKEN` | **URL:** `http://localhost:3000/api/v1/auth/otp/verify`

```json
{
	"otp": "123456"
}
```

**Expected:** `200 OK`.

---

#### STEP 19 — Sneha updates her profile

**Method:** `PUT` | **Auth:** Bearer `SNEHA_TOKEN` | **URL:**
`http://localhost:3000/api/v1/students/{SNEHA_USER_ID}/profile`

```json
{
	"bio": "1st year LLB student. Looking for a PG near Karol Bagh district courts. Night owl, vegetarian.",
	"course": "LLB",
	"yearOfStudy": 1,
	"gender": "female",
	"dateOfBirth": "2003-03-08"
}
```

**Expected:** `200 OK`.

---

#### STEP 20 — Verify GET /auth/me for each persona (spot-check)

**Method:** `GET` | Try this for each persona token | **URL:** `http://localhost:3000/api/v1/auth/me`

**Expected:** `200` with `userId`, `email`, `roles` array, and `isEmailVerified`. Confirm that Priya, Arjun, and Sneha
all show `roles: ["student"]`; Meera and Ranjit show `roles: ["pg_owner"]`; Sumit shows `roles: ["admin"]`; and Priya,
Arjun, and Sneha all have `isEmailVerified: true`.

---

## PHASE 2: PROPERTIES & LISTINGS

_Create properties · Post listings · Search by city, filters, and proximity_

In this phase the two PG owners create their properties and listings, and the two student listers post their
`student_room` listings. Coordinates are real Delhi and Bengaluru locations so proximity search actually works.

---

### Meera Kapoor — Property & Listings (Bengaluru)

#### STEP 21 — Meera creates her property

**Method:** `POST` | **Auth:** Bearer `MEERA_TOKEN` | **URL:** `http://localhost:3000/api/v1/properties`

```json
{
	"propertyName": "Kapoor Ladies PG",
	"description": "A well-maintained women-only PG in the heart of Koramangala. Homely food available. Strict 10pm curfew.",
	"propertyType": "pg",
	"addressLine": "27, 5th Cross, Koramangala 4th Block",
	"city": "Bengaluru",
	"locality": "Koramangala",
	"landmark": "Near Forum Mall",
	"pincode": "560034",
	"latitude": 12.9352,
	"longitude": 77.6245,
	"houseRules": "No male visitors past 8pm. No smoking on premises. Kitchen closes at 9pm.",
	"totalRooms": 12,
	"amenityIds": []
}
```

**Expected:** `201 Created`.

> **📋 CAPTURE: Save `data.property_id` as `MEERA_PROPERTY_ID`.**
>
> **📌** `amenityIds` is empty here because we need the actual UUIDs from the `amenities` table. To fetch them, run this
> SQL: `SELECT amenity_id, name FROM amenities ORDER BY category, name;` Pick the UUIDs for the amenities you want and
> use them in the `amenityIds` arrays below. For the purpose of this test, an empty `amenityIds` array works fine for
> all listings.

---

#### STEP 22 — Meera creates her first listing — shared room at ₹7,500/month

**Method:** `POST` | **Auth:** Bearer `MEERA_TOKEN` | **URL:** `http://localhost:3000/api/v1/listings`

```json
{
	"listingType": "pg_room",
	"propertyId": "{MEERA_PROPERTY_ID}",
	"title": "Shared Room for Women — Koramangala PG",
	"description": "Spacious double-sharing room with attached bathroom. Homely meals available at extra cost. Great connectivity to HSR Layout tech corridor.",
	"rentPerMonth": 7500,
	"depositAmount": 15000,
	"rentIncludesUtilities": true,
	"isNegotiable": false,
	"roomType": "double",
	"bedType": "single_bed",
	"totalCapacity": 2,
	"preferredGender": "female",
	"availableFrom": "2025-08-01",
	"amenityIds": [],
	"preferences": [
		{ "preferenceKey": "food_habit", "preferenceValue": "vegetarian" },
		{ "preferenceKey": "smoking", "preferenceValue": "non_smoker" },
		{ "preferenceKey": "sleep_schedule", "preferenceValue": "early_bird" }
	]
}
```

**Expected:** `201 Created`.

> **📋 CAPTURE: Save `data.listing_id` as `MEERA_LISTING_1_ID`.**

---

#### STEP 23 — Meera creates her second listing — single room at ₹12,000/month

**Method:** `POST` | **Auth:** Bearer `MEERA_TOKEN` | **URL:** `http://localhost:3000/api/v1/listings`

```json
{
	"listingType": "pg_room",
	"propertyId": "{MEERA_PROPERTY_ID}",
	"title": "Private Single Room — Premium PG for Women",
	"description": "Fully furnished single occupancy room with personal wardrobe and study table. Ideal for working women and post-grad students.",
	"rentPerMonth": 12000,
	"depositAmount": 24000,
	"rentIncludesUtilities": true,
	"isNegotiable": true,
	"roomType": "single",
	"bedType": "single_bed",
	"totalCapacity": 1,
	"preferredGender": "female",
	"availableFrom": "2025-07-15",
	"amenityIds": [],
	"preferences": [
		{ "preferenceKey": "smoking", "preferenceValue": "non_smoker" },
		{ "preferenceKey": "noise_tolerance", "preferenceValue": "low" }
	]
}
```

**Expected:** `201 Created`.

> **📋 CAPTURE: Save `data.listing_id` as `MEERA_LISTING_2_ID`.**

---

### Ranjit Singh — Property & Listings (Delhi)

#### STEP 24 — Ranjit creates his property

**Method:** `POST` | **Auth:** Bearer `RANJIT_TOKEN` | **URL:** `http://localhost:3000/api/v1/properties`

```json
{
	"propertyName": "Singh's Co-Ed Hostel",
	"description": "Budget-friendly co-ed hostel in Karol Bagh, centrally located near metro station. Separate floors for male and female residents.",
	"propertyType": "hostel",
	"addressLine": "14/6, Dev Nagar, Karol Bagh",
	"city": "Delhi",
	"locality": "Karol Bagh",
	"landmark": "Near Karol Bagh Metro Station",
	"pincode": "110005",
	"latitude": 28.6448,
	"longitude": 77.1903,
	"houseRules": "Gate closes at 11pm. No alcohol inside rooms. Common room available till 10pm.",
	"totalRooms": 20,
	"amenityIds": []
}
```

**Expected:** `201 Created`.

> **📋 CAPTURE: Save `data.property_id` as `RANJIT_PROPERTY_ID`.**

---

#### STEP 25 — Ranjit creates his first listing — hostel bed at ₹5,000/month

**Method:** `POST` | **Auth:** Bearer `RANJIT_TOKEN` | **URL:** `http://localhost:3000/api/v1/listings`

```json
{
	"listingType": "hostel_bed",
	"propertyId": "{RANJIT_PROPERTY_ID}",
	"title": "Hostel Bed for Male Students — Karol Bagh, Delhi",
	"description": "Bunk bed in a 4-sharing room. Walking distance from Karol Bagh metro. Power backup, WiFi, and daily housekeeping included.",
	"rentPerMonth": 5000,
	"depositAmount": 5000,
	"rentIncludesUtilities": true,
	"isNegotiable": false,
	"roomType": "triple",
	"bedType": "bunk_bed",
	"totalCapacity": 1,
	"preferredGender": "male",
	"availableFrom": "2025-07-01",
	"amenityIds": [],
	"preferences": [
		{ "preferenceKey": "smoking", "preferenceValue": "non_smoker" },
		{ "preferenceKey": "sleep_schedule", "preferenceValue": "night_owl" }
	]
}
```

**Expected:** `201 Created`.

> **📋 CAPTURE: Save `data.listing_id` as `RANJIT_LISTING_1_ID`.**

---

#### STEP 26 — Ranjit creates his second listing — double sharing at ₹8,000/month

**Method:** `POST` | **Auth:** Bearer `RANJIT_TOKEN` | **URL:** `http://localhost:3000/api/v1/listings`

```json
{
	"listingType": "hostel_bed",
	"propertyId": "{RANJIT_PROPERTY_ID}",
	"title": "Double Sharing Room — Co-Ed Hostel Karol Bagh",
	"description": "Two-sharing room on the co-ed floor. Attached bathroom, study table, and wardrobe. Close to Rajendra Place and Patel Nagar.",
	"rentPerMonth": 8000,
	"depositAmount": 8000,
	"rentIncludesUtilities": false,
	"isNegotiable": true,
	"roomType": "double",
	"bedType": "single_bed",
	"totalCapacity": 2,
	"preferredGender": "prefer_not_to_say",
	"availableFrom": "2025-08-01",
	"amenityIds": [],
	"preferences": [
		{ "preferenceKey": "noise_tolerance", "preferenceValue": "medium" },
		{ "preferenceKey": "guest_policy", "preferenceValue": "okay" }
	]
}
```

**Expected:** `201 Created`.

> **📋 CAPTURE: Save `data.listing_id` as `RANJIT_LISTING_2_ID`.**

---

### Student Listings

#### STEP 27 — Priya posts her student_room listing in Delhi

**Method:** `POST` | **Auth:** Bearer `PRIYA_TOKEN` | **URL:** `http://localhost:3000/api/v1/listings`

```json
{
	"listingType": "student_room",
	"title": "Room for Female Flatmate — Hauz Khas, Delhi",
	"description": "Looking for a female flatmate to share my 2BHK near IIT Delhi gate. Fully furnished, great natural light, peaceful locality.",
	"rentPerMonth": 9500,
	"depositAmount": 19000,
	"rentIncludesUtilities": false,
	"isNegotiable": true,
	"roomType": "single",
	"bedType": "double_bed",
	"totalCapacity": 1,
	"preferredGender": "female",
	"availableFrom": "2025-08-01",
	"addressLine": "C-12, Hauz Khas Village, New Delhi",
	"city": "Delhi",
	"locality": "Hauz Khas",
	"landmark": "Near IIT Delhi Main Gate",
	"pincode": "110016",
	"latitude": 28.5494,
	"longitude": 77.2001,
	"amenityIds": [],
	"preferences": [
		{ "preferenceKey": "food_habit", "preferenceValue": "vegetarian" },
		{ "preferenceKey": "smoking", "preferenceValue": "non_smoker" },
		{ "preferenceKey": "cleanliness_level", "preferenceValue": "high" }
	]
}
```

**Expected:** `201 Created`.

> **📋 CAPTURE: Save `data.listing_id` as `PRIYA_LISTING_ID`.**

---

#### STEP 28 — Arjun posts his student_room listing in Bengaluru

**Method:** `POST` | **Auth:** Bearer `ARJUN_TOKEN` | **URL:** `http://localhost:3000/api/v1/listings`

```json
{
	"listingType": "student_room",
	"title": "Room in 3BHK — Indiranagar, Bengaluru",
	"description": "Looking for a chill flatmate in our 3BHK in Indiranagar. Two of us already living here. Male preferred but open to discuss. Great neighbourhood, close to 100 Feet Road.",
	"rentPerMonth": 11000,
	"depositAmount": 22000,
	"rentIncludesUtilities": false,
	"isNegotiable": false,
	"roomType": "single",
	"bedType": "single_bed",
	"totalCapacity": 1,
	"preferredGender": "male",
	"availableFrom": "2025-07-20",
	"addressLine": "3rd Floor, 104 CMH Road, Indiranagar",
	"city": "Bengaluru",
	"locality": "Indiranagar",
	"landmark": "Near Indiranagar Metro Station",
	"pincode": "560038",
	"latitude": 12.9784,
	"longitude": 77.6408,
	"amenityIds": [],
	"preferences": [
		{ "preferenceKey": "alcohol", "preferenceValue": "okay" },
		{ "preferenceKey": "noise_tolerance", "preferenceValue": "medium" }
	]
}
```

**Expected:** `201 Created`.

> **📋 CAPTURE: Save `data.listing_id` as `ARJUN_LISTING_ID`.**

---

### Search Tests

#### STEP 29 — Search listings by city (Delhi)

**Method:** `GET` | **Auth:** Bearer `PRIYA_TOKEN` | **URL:** `http://localhost:3000/api/v1/listings?city=Delhi`

**Expected:** `200` with `items` array. Should show Priya's listing and both of Ranjit's Delhi listings. Each item
includes a `compatibilityScore` — Priya may score higher on Ranjit's listings if preferences overlap.

> **📌** The search endpoint requires authentication — pass any valid token.

---

#### STEP 30 — Search listings by city + rent range

**Method:** `GET` | **Auth:** Bearer `SNEHA_TOKEN` | **URL:**
`http://localhost:3000/api/v1/listings?city=Delhi&minRent=4000&maxRent=9000`

**Expected:** Only listings with `rentPerMonth` between ₹4,000 and ₹9,000 appear. Ranjit's ₹5,000 bed should be
included; Priya's ₹9,500 room should be excluded.

---

#### STEP 31 — Proximity search near Karol Bagh metro

**Method:** `GET` | **Auth:** Bearer `SNEHA_TOKEN` | **URL:**
`http://localhost:3000/api/v1/listings?lat=28.6448&lng=77.1903&radius=3000`

**Expected:** Ranjit's two Delhi listings should appear since his property is at those exact coordinates. Priya's Hauz
Khas listing is ~10km away, so it should be excluded from a 3km radius.

> **📌** `radius` is in metres. `3000` = 3km. The PostGIS geography cast ensures metres are used, not degrees.

---

#### STEP 32 — Sneha saves Ranjit's first listing

**Method:** `POST` | **Auth:** Bearer `SNEHA_TOKEN` | **URL:**
`http://localhost:3000/api/v1/listings/{RANJIT_LISTING_1_ID}/save`

No body needed.

**Expected:** `200 OK` with `{ listingId, saved: true }`.

---

#### STEP 33 — Sneha views her saved listings

**Method:** `GET` | **Auth:** Bearer `SNEHA_TOKEN` | **URL:** `http://localhost:3000/api/v1/listings/me/saved`

**Expected:** `200` with `items` array containing Ranjit's first listing.

---

## PHASE 3: INTERACTION PIPELINE

_Interest requests → Connections → Two-sided confirmation → Notifications → Ratings_

This is the most complex phase. Three full pipelines run in parallel — one per student. Follow each pipeline to
completion before moving to the next. The full pipeline is: student sends interest → PG owner accepts → both parties
confirm → both parties rate each other.

---

### Pipeline 1: Priya → Ranjit's first listing (hostel bed)

#### STEP 34 — Priya sends interest in Ranjit's first listing

**Method:** `POST` | **Auth:** Bearer `PRIYA_TOKEN` | **URL:**
`http://localhost:3000/api/v1/listings/{RANJIT_LISTING_1_ID}/interests`

```json
{
	"message": "Hi Ranjit ji, I am Priya, a 3rd year IIT Delhi student. I am looking for a hostel near Karol Bagh for a semester. I am a non-smoker and keep things very tidy."
}
```

**Expected:** `201 Created` with `interestRequestId`, `status: 'pending'`.

> **📋 CAPTURE: Save `data.interestRequestId` as `PRIYA_INTEREST_ID`.**

---

#### STEP 35 — Ranjit views interest requests on his first listing

**Method:** `GET` | **Auth:** Bearer `RANJIT_TOKEN` | **URL:**
`http://localhost:3000/api/v1/listings/{RANJIT_LISTING_1_ID}/interests`

**Expected:** `200` with an `items` array. Priya's request appears with sender details and her rating (`0.00`
initially).

---

#### STEP 36 — Ranjit accepts Priya's interest request

**Method:** `PATCH` | **Auth:** Bearer `RANJIT_TOKEN` | **URL:**
`http://localhost:3000/api/v1/interests/{PRIYA_INTEREST_ID}/status`

```json
{
	"status": "accepted"
}
```

**Expected:** `200 OK`. The response includes `connectionId` and a `whatsappLink` (`null` if Priya has no phone number
set, which she doesn't — that is fine and expected).

> **📋 CAPTURE: Save `data.connectionId` as `PRIYA_CONNECTION_ID`.**
>
> **📌** At this moment, three things happened atomically in the DB: (1) `interest_requests` row updated to
> `'accepted'`, (2) a `connections` row was created with `connection_type = 'hostel_stay'`, (3) all other pending
> requests for this listing are bulk-expired. Post-commit, a notification is queued to Priya.

---

#### STEP 37 — Priya confirms the connection (she moved in)

**Method:** `POST` | **Auth:** Bearer `PRIYA_TOKEN` | **URL:**
`http://localhost:3000/api/v1/connections/{PRIYA_CONNECTION_ID}/confirm`

No body needed.

**Expected:** `200 OK`. `initiatorConfirmed` becomes `true`. `confirmationStatus` remains `'pending'` until both sides
confirm.

---

#### STEP 38 — Ranjit confirms the connection

**Method:** `POST` | **Auth:** Bearer `RANJIT_TOKEN` | **URL:**
`http://localhost:3000/api/v1/connections/{PRIYA_CONNECTION_ID}/confirm`

No body needed.

**Expected:** `200 OK`. `confirmationStatus` flips to `'confirmed'`. Both parties get a `connection_confirmed`
notification queued.

> **📌** The atomic `CASE WHEN` SQL sets both `counterpartConfirmed = TRUE` and flips the status in a single `UPDATE` —
> no read-then-write race.

---

#### STEP 39 — Priya rates Ranjit (user rating)

**Method:** `POST` | **Auth:** Bearer `PRIYA_TOKEN` | **URL:** `http://localhost:3000/api/v1/ratings`

```json
{
	"connectionId": "{PRIYA_CONNECTION_ID}",
	"revieweeType": "user",
	"revieweeId": "{RANJIT_USER_ID}",
	"overallScore": 4,
	"cleanlinessScore": 4,
	"communicationScore": 5,
	"reliabilityScore": 4,
	"comment": "Ranjit ji was very helpful and responsive. The hostel was clean and well-maintained. Only minor issue was the hot water timing."
}
```

**Expected:** `201 Created` with `ratingId` and `createdAt`.

> **📋 CAPTURE: Save `data.ratingId` as `PRIYA_RATES_RANJIT_ID`.**
>
> **📌** The DB trigger `update_rating_aggregates` fires automatically and updates Ranjit's `average_rating` and
> `rating_count` on the `users` table. No application code needed.

---

#### STEP 40 — Priya rates the property

**Method:** `POST` | **Auth:** Bearer `PRIYA_TOKEN` | **URL:** `http://localhost:3000/api/v1/ratings`

```json
{
	"connectionId": "{PRIYA_CONNECTION_ID}",
	"revieweeType": "property",
	"revieweeId": "{RANJIT_PROPERTY_ID}",
	"overallScore": 4,
	"cleanlinessScore": 4,
	"valueScore": 5,
	"comment": "Great location near metro. Good value for money. The wifi could be faster."
}
```

**Expected:** `201 Created`.

> **📌** The `WHERE EXISTS` JOIN verifies that `RANJIT_PROPERTY_ID` is actually associated with the confirmed connection
> via the `listings` table — it's not possible to rate an arbitrary property using this connection.

---

#### STEP 41 — Ranjit rates Priya (user rating)

**Method:** `POST` | **Auth:** Bearer `RANJIT_TOKEN` | **URL:** `http://localhost:3000/api/v1/ratings`

```json
{
	"connectionId": "{PRIYA_CONNECTION_ID}",
	"revieweeType": "user",
	"revieweeId": "{PRIYA_USER_ID}",
	"overallScore": 5,
	"cleanlinessScore": 5,
	"reliabilityScore": 5,
	"comment": "Priya was an excellent guest. Always on time with rent, very clean, and respectful of the house rules. Would happily host again."
}
```

**Expected:** `201 Created`.

---

### Pipeline 2: Arjun → Meera's first listing (shared room)

#### STEP 42 — Arjun sends interest in Meera's first listing

**Method:** `POST` | **Auth:** Bearer `ARJUN_TOKEN` | **URL:**
`http://localhost:3000/api/v1/listings/{MEERA_LISTING_1_ID}/interests`

```json
{
	"message": "Hello, I am Arjun, a 2nd year MBA student. I am looking for accommodation near HSR Layout for my internship. I am vegetarian and a non-smoker, so your preferences match mine exactly."
}
```

**Expected:** `201 Created`.

> **📋 CAPTURE: Save `data.interestRequestId` as `ARJUN_INTEREST_ID`.**
>
> **⚠️** Meera's listing has `preferredGender` set to `'female'`. Arjun is male. The API does **not** enforce gender at
> the interest request stage — it is a preference, not a hard block. The PG owner decides.

---

#### STEP 43 — Meera accepts Arjun's interest

**Method:** `PATCH` | **Auth:** Bearer `MEERA_TOKEN` | **URL:**
`http://localhost:3000/api/v1/interests/{ARJUN_INTEREST_ID}/status`

```json
{
	"status": "accepted"
}
```

**Expected:** `200 OK` with `connectionId`.

> **📋 CAPTURE: Save `data.connectionId` as `ARJUN_CONNECTION_ID`.**

---

#### STEP 44 — Arjun confirms the connection

**Method:** `POST` | **Auth:** Bearer `ARJUN_TOKEN` | **URL:**
`http://localhost:3000/api/v1/connections/{ARJUN_CONNECTION_ID}/confirm`

**Expected:** `200 OK`. `confirmationStatus` still `'pending'`.

---

#### STEP 45 — Meera confirms the connection

**Method:** `POST` | **Auth:** Bearer `MEERA_TOKEN` | **URL:**
`http://localhost:3000/api/v1/connections/{ARJUN_CONNECTION_ID}/confirm`

**Expected:** `200 OK`. `confirmationStatus` flips to `'confirmed'`.

---

#### STEP 46 — Arjun rates Meera (user rating)

**Method:** `POST` | **Auth:** Bearer `ARJUN_TOKEN` | **URL:** `http://localhost:3000/api/v1/ratings`

```json
{
	"connectionId": "{ARJUN_CONNECTION_ID}",
	"revieweeType": "user",
	"revieweeId": "{MEERA_USER_ID}",
	"overallScore": 2,
	"communicationScore": 2,
	"reliabilityScore": 3,
	"comment": "Meera was strict about her rules but was not always responsive to maintenance issues. Room was clean but the food quality dropped over time. Overall an okay experience."
}
```

**Expected:** `201 Created`.

> **📋 CAPTURE: Save `data.ratingId` as `ARJUN_RATES_MEERA_ID` — we will use this in the Phase 4 report test.**

---

#### STEP 47 — Meera rates Arjun (user rating)

**Method:** `POST` | **Auth:** Bearer `MEERA_TOKEN` | **URL:** `http://localhost:3000/api/v1/ratings`

```json
{
	"connectionId": "{ARJUN_CONNECTION_ID}",
	"revieweeType": "user",
	"revieweeId": "{ARJUN_USER_ID}",
	"overallScore": 3,
	"cleanlinessScore": 3,
	"reliabilityScore": 4,
	"comment": "Arjun was generally polite but did not always follow the kitchen closing time rule. Rent was always on time."
}
```

**Expected:** `201 Created`.

---

### Pipeline 3: Sneha → Ranjit's second listing (double sharing)

#### STEP 48 — Sneha sends interest in Ranjit's second listing

**Method:** `POST` | **Auth:** Bearer `SNEHA_TOKEN` | **URL:**
`http://localhost:3000/api/v1/listings/{RANJIT_LISTING_2_ID}/interests`

```json
{
	"message": "Hello, I am Sneha, a 1st year LLB student. I need a room near Karol Bagh for at least 6 months. I am a quiet person and will follow all house rules."
}
```

**Expected:** `201 Created`.

> **📋 CAPTURE: Save `data.interestRequestId` as `SNEHA_INTEREST_ID`.**

---

#### STEP 49 — Ranjit accepts Sneha's interest

**Method:** `PATCH` | **Auth:** Bearer `RANJIT_TOKEN` | **URL:**
`http://localhost:3000/api/v1/interests/{SNEHA_INTEREST_ID}/status`

```json
{
	"status": "accepted"
}
```

**Expected:** `200 OK` with `connectionId`.

> **📋 CAPTURE: Save `data.connectionId` as `SNEHA_CONNECTION_ID`.**

---

#### STEP 50 — Both Sneha and Ranjit confirm this connection

First, Sneha confirms — **Method:** `POST` | **Auth:** Bearer `SNEHA_TOKEN` | **URL:**
`http://localhost:3000/api/v1/connections/{SNEHA_CONNECTION_ID}/confirm`

Then, Ranjit confirms — **Method:** `POST` | **Auth:** Bearer `RANJIT_TOKEN` | **URL:**
`http://localhost:3000/api/v1/connections/{SNEHA_CONNECTION_ID}/confirm`

**Expected:** After both confirmations, `confirmationStatus = 'confirmed'`.

---

#### STEP 51 — Sneha rates Ranjit (user rating)

**Method:** `POST` | **Auth:** Bearer `SNEHA_TOKEN` | **URL:** `http://localhost:3000/api/v1/ratings`

```json
{
	"connectionId": "{SNEHA_CONNECTION_ID}",
	"revieweeType": "user",
	"revieweeId": "{RANJIT_USER_ID}",
	"overallScore": 5,
	"cleanlinessScore": 5,
	"communicationScore": 5,
	"valueScore": 4,
	"comment": "Ranjit ji is one of the best hostel owners I have stayed with. Always available, very understanding about student schedules. Highly recommend."
}
```

**Expected:** `201 Created`.

---

#### STEP 52 — Ranjit rates Sneha

**Method:** `POST` | **Auth:** Bearer `RANJIT_TOKEN` | **URL:** `http://localhost:3000/api/v1/ratings`

```json
{
	"connectionId": "{SNEHA_CONNECTION_ID}",
	"revieweeType": "user",
	"revieweeId": "{SNEHA_USER_ID}",
	"overallScore": 5,
	"reliabilityScore": 5,
	"comment": "Sneha was a wonderful guest. No issues whatsoever. Always paid on time and respected everyone in the hostel."
}
```

**Expected:** `201 Created`.

---

### Notification & Public Rating Checks

#### STEP 53 — Check Ranjit's notification feed

**Method:** `GET` | **Auth:** Bearer `RANJIT_TOKEN` | **URL:** `http://localhost:3000/api/v1/notifications`

**Expected:** Multiple notifications — `interest_request_received` (from Priya and Sneha), `connection_confirmed`
(twice), `rating_received` (multiple).

---

#### STEP 54 — Check unread count

**Method:** `GET` | **Auth:** Bearer `RANJIT_TOKEN` | **URL:** `http://localhost:3000/api/v1/notifications/unread-count`

**Expected:** `200` with `{ count: N }` where N reflects all unread notifications.

---

#### STEP 55 — Mark all notifications as read

**Method:** `POST` | **Auth:** Bearer `RANJIT_TOKEN` | **URL:** `http://localhost:3000/api/v1/notifications/mark-read`

```json
{
	"all": true
}
```

**Expected:** `200` with `{ updated: N }`.

---

#### STEP 56 — Check Ranjit's public ratings (no auth needed)

**Method:** `GET` | No Auth header needed | **URL:** `http://localhost:3000/api/v1/ratings/user/{RANJIT_USER_ID}`

**Expected:** `200` with paginated ratings from Priya and Sneha. Ranjit's `average_rating` on his user record should now
reflect the average of those scores.

> **📌** The `update_rating_aggregates` trigger updated `users.average_rating` automatically when each rating was
> inserted. You can verify with: `SELECT average_rating, rating_count FROM users WHERE user_id = '<RANJIT_USER_ID>';`

---

#### STEP 57 — Check the property's public ratings

**Method:** `GET` | No Auth needed | **URL:** `http://localhost:3000/api/v1/ratings/property/{RANJIT_PROPERTY_ID}`

**Expected:** `200` with Priya's property rating visible. The property's `average_rating` should also be updated on the
`properties` table.

---

## PHASE 4: REPUTATION MODERATION

_Report a rating · Admin reviews the report queue · Resolve the report_

Phase 4 is implemented and testable. The three endpoints are: `POST` a report against a rating, `GET` the admin report
queue, and `PATCH` a report to resolve it. Meera will report Arjun's harsh 2-star review as `'fake'`, and Sumit will
resolve it.

> **📌** Only a party to the connection that the rating references can report that rating. Meera is the reviewee on
> `ARJUN_RATES_MEERA_ID` and is therefore a party to that connection — she can correctly report a rating she received.

---

#### STEP 58 — Meera reports Arjun's 2-star review of her

**Method:** `POST` | **Auth:** Bearer `MEERA_TOKEN` | **URL:**
`http://localhost:3000/api/v1/ratings/{ARJUN_RATES_MEERA_ID}/report`

```json
{
	"reason": "fake",
	"explanation": "This rating does not reflect the actual stay. The guest had a personal disagreement unrelated to the accommodation. I have WhatsApp messages proving the food quality complaint is fabricated."
}
```

**Expected:** `201 Created` with `reportId`.

> **📋 CAPTURE: Save `data.reportId` as `MEERA_REPORT_ID`.**

---

#### STEP 59 — Sumit views the admin report queue

**Method:** `GET` | **Auth:** Bearer `SUMIT_TOKEN` | **URL:** `http://localhost:3000/api/v1/admin/report-queue`

**Expected:** `200` with paginated report list. Each item includes the full rating text, reporter's profile, and
reviewee's profile — so Sumit can make a decision without a second request.

---

#### STEP 60 — Sumit resolves the report as 'resolved_kept' (keeps the rating visible)

**Method:** `PATCH` | **Auth:** Bearer `SUMIT_TOKEN` | **URL:**
`http://localhost:3000/api/v1/admin/reports/{MEERA_REPORT_ID}/resolve`

```json
{
	"resolution": "resolved_kept",
	"adminNotes": "Rating reviewed. Content is subjective but not abusive or fabricated. Rating remains visible."
}
```

**Expected:** `200 OK`. The report status becomes `'resolved_kept'`. Arjun's rating remains visible and Meera's average
is unchanged.

---

#### STEP 61 — (Optional) Re-submit a new report and resolve with removal

To test the `'resolved_removed'` path, Meera can submit a second report on Arjun's rating — the first report is now
closed, so a new open report is allowed by the partial unique index. Then Sumit resolves with:

```json
{
	"resolution": "resolved_removed",
	"adminNotes": "Upon further review, the rating contains misleading claims. Removing."
}
```

**Expected:** `200 OK`. `ratings.is_visible` flips to `FALSE`. The DB trigger fires automatically, removing the rating
from Meera's average. Verify with:

```sql
SELECT average_rating, rating_count FROM users WHERE user_id = '<MEERA_USER_ID>';
```

> **📌** The `rating_count` should decrease by 1 and `average_rating` should recalculate automatically without any
> application code.

---

## Section 5: Edge Case & Error Tests

These tests verify the system rejects bad input gracefully. Each one should return a `4xx` error — if it returns `2xx`,
something is wrong.

| Test Scenario                         | Token          | Method + URL                                            | What to Expect                                                                                                              |
| ------------------------------------- | -------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Duplicate interest request            | `SNEHA_TOKEN`  | `POST /api/v1/listings/{RANJIT_LISTING_2_ID}/interests` | Sneha already has an accepted request for this listing. Expected: **409 Conflict**.                                         |
| Rate before connection is confirmed   | `PRIYA_TOKEN`  | `POST /api/v1/ratings`                                  | Submit a rating with a `connectionId` whose status is still `'pending'`. Expected: **422 Unprocessable Entity**.            |
| Duplicate rating                      | `PRIYA_TOKEN`  | `POST /api/v1/ratings`                                  | Priya already rated Ranjit on `PRIYA_CONNECTION_ID`. Submitting again returns: **409 Conflict**.                            |
| Rate your own self                    | `RANJIT_TOKEN` | `POST /api/v1/ratings`                                  | `revieweeId = RANJIT_USER_ID` using `RANJIT_CONNECTION_ID`. Expected: **422** — self-rating blocked.                        |
| Access admin route without admin role | `PRIYA_TOKEN`  | `GET /api/v1/admin/verification-queue`                  | Expected: **403 Forbidden**.                                                                                                |
| Invalid UUID in path param            | `PRIYA_TOKEN`  | `GET /api/v1/listings/not-a-uuid`                       | Expected: **400 Validation failed** (Zod catches non-UUID).                                                                 |
| OTP verify with wrong code            | `SNEHA_TOKEN`  | `POST /api/v1/auth/otp/verify` body: `{"otp":"000000"}` | Expected: **400** with `'Incorrect OTP — 4 attempts remaining'`.                                                            |
| Expired listing interest              | `ARJUN_TOKEN`  | `POST /api/v1/listings/{MEERA_LISTING_2_ID}/interests`  | First mark `MEERA_LISTING_2_ID` as `'filled'` using Meera's token, then Arjun tries to express interest. Expected: **422**. |
| Non-owner update listing              | `ARJUN_TOKEN`  | `PUT /api/v1/listings/{PRIYA_LISTING_ID}`               | Arjun tries to update Priya's listing. Expected: **404** (ownership enforced via `WHERE posted_by` clause — not 403).       |
| Delete property with active listing   | `MEERA_TOKEN`  | `DELETE /api/v1/properties/{MEERA_PROPERTY_ID}`         | Meera's listings are still active. Expected: **409** — `'Deactivate or remove all active listings first'`.                  |

---

## Section 6: UUID & Token Tracker

Fill this in as you run each step. Having all values in one place prevents you from scrolling back through hundreds of
response bodies mid-test.

| Variable Name           | Captured At Step          | Your Value (fill in) |
| ----------------------- | ------------------------- | -------------------- |
| `SUMIT_USER_ID`         | Seed B SQL `RETURNING`    |                      |
| `SUMIT_TOKEN`           | Step 2 (login)            |                      |
| `MEERA_USER_ID`         | Step 1 (register)         |                      |
| `MEERA_TOKEN`           | Step 1 (register)         |                      |
| `MEERA_REQUEST_ID`      | Step 3 (doc submit)       |                      |
| `MEERA_PROPERTY_ID`     | Step 21 (create property) |                      |
| `MEERA_LISTING_1_ID`    | Step 22                   |                      |
| `MEERA_LISTING_2_ID`    | Step 23                   |                      |
| `RANJIT_USER_ID`        | Step 7 (register)         |                      |
| `RANJIT_TOKEN`          | Step 7 (register)         |                      |
| `RANJIT_REQUEST_ID`     | Step 8 (doc submit)       |                      |
| `RANJIT_PROPERTY_ID`    | Step 24                   |                      |
| `RANJIT_LISTING_1_ID`   | Step 25                   |                      |
| `RANJIT_LISTING_2_ID`   | Step 26                   |                      |
| `PRIYA_USER_ID`         | Step 10 (register)        |                      |
| `PRIYA_TOKEN`           | Step 10 (register)        |                      |
| `PRIYA_LISTING_ID`      | Step 27                   |                      |
| `ARJUN_USER_ID`         | Step 12 (register)        |                      |
| `ARJUN_TOKEN`           | Step 12 (register)        |                      |
| `ARJUN_LISTING_ID`      | Step 28                   |                      |
| `SNEHA_USER_ID`         | Step 16 (register)        |                      |
| `SNEHA_TOKEN`           | Step 16 (register)        |                      |
| `PRIYA_INTEREST_ID`     | Step 34                   |                      |
| `PRIYA_CONNECTION_ID`   | Step 36                   |                      |
| `PRIYA_RATES_RANJIT_ID` | Step 39                   |                      |
| `ARJUN_INTEREST_ID`     | Step 42                   |                      |
| `ARJUN_CONNECTION_ID`   | Step 43                   |                      |
| `ARJUN_RATES_MEERA_ID`  | Step 46                   |                      |
| `SNEHA_INTEREST_ID`     | Step 48                   |                      |
| `SNEHA_CONNECTION_ID`   | Step 49                   |                      |
| `MEERA_REPORT_ID`       | Step 58 (Phase 4)         |                      |

---

## Section 7: Quick Reference — Common Checks

### Health check (run anytime)

```
GET http://localhost:3000/api/v1/health
```

Expected when healthy:

```json
{ "status": "ok", "services": { "database": "ok", "redis": "ok" } }
```

### Verify DB trigger updated rating aggregates

```sql
SELECT user_id, email, average_rating, rating_count FROM users
WHERE email IN ('ranjit.singh1985@gmail.com', 'meera.kapoor@gmail.com');
```

Ranjit should have an average around 4.5 (Priya gave 4, Sneha gave 5). Meera may vary depending on whether you resolved
Arjun's report as `resolved_removed` or `resolved_kept`.

### Check notification queue depth (Redis CLI)

```bash
redis-cli LLEN bull:notification-delivery:wait
```

Should be `0` or near `0` if the notification worker is processing normally.

### Quick connection status check (SQL)

```sql
SELECT connection_id, confirmation_status, initiator_confirmed, counterpart_confirmed
FROM connections ORDER BY created_at DESC LIMIT 5;
```

All three connections should show `confirmation_status = 'confirmed'` after the confirmation steps.
