# Roomies API Reference

`docs/API.md` is the API front door. The detailed endpoint-by-endpoint documentation lives in `docs/api/`.

## Base URLs

- Local development: `http://localhost:3000/api/v1`
- Production: `https://<your-domain-or-app-service-host>/api/v1`

All endpoints return JSON. File upload endpoints accept `multipart/form-data` requests but still return JSON responses.

## Transport Modes

Roomies supports two auth transports at the same time.

### Cookie Mode

Intended for browser clients.

- Auth endpoints set `accessToken` and `refreshToken` as `HttpOnly` cookies.
- Browser responses receive a safe JSON body that includes session metadata and user identity, but not raw token
  strings.
- The browser should rely on cookies instead of manually storing bearer tokens.

Typical auth success body in cookie mode:

```json
{
	"status": "success",
	"data": {
		"user": {
			"userId": "11111111-1111-4111-8111-111111111111",
			"email": "priya@iitb.ac.in",
			"roles": ["student"],
			"isEmailVerified": true
		},
		"sid": "22222222-2222-4222-8222-222222222222"
	}
}
```

### Bearer Mode

Intended for Android, mobile, and non-browser API clients.

- Send `X-Client-Transport: bearer` on auth endpoints.
- Send `Authorization: Bearer <access-token>` on protected endpoints.
- Auth responses include raw `accessToken` and `refreshToken` strings in the JSON body.

Typical auth success body in bearer mode:

```json
{
	"status": "success",
	"data": {
		"accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
		"refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
		"sid": "22222222-2222-4222-8222-222222222222",
		"user": {
			"userId": "11111111-1111-4111-8111-111111111111",
			"email": "priya@iitb.ac.in",
			"roles": ["student"],
			"isEmailVerified": true
		}
	}
}
```

## Global Auth Rules

- Protected endpoints accept cookie auth and bearer auth unless a feature doc says otherwise.
- Silent refresh happens only when the expired access token came from the `accessToken` cookie.
- Expired bearer tokens do not silently refresh. They return `401`.
- Users may have multiple roles. The `roles` array in the auth payload is authoritative.

## Gate-Driven Route Behavior

Some routes apply dedicated gate middleware before controller/service logic runs.

- Contact reveal routes apply quota and eligibility gates.
- Admin routes apply an `admin` role gate at router level.
- Some ownership/party checks intentionally return privacy-preserving `404` responses instead of `403`.

When documenting or integrating a route with a gate, treat the gate response as a first-class endpoint outcome.

## Common Response Envelopes

Success with data:

```json
{
	"status": "success",
	"data": {}
}
```

Success with message:

```json
{
	"status": "success",
	"message": "Logged out"
}
```

Operational error:

```json
{
	"status": "error",
	"message": "Listing not found"
}
```

Validation error:

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "body.email",
			"message": "Must be a valid email address"
		}
	]
}
```

More examples live in [api/conventions.md](./api/conventions.md).

## Roles and Access Model

- `student` Can maintain a student profile, create `student_room` listings, send interest requests, save listings,
  confirm connections, and submit ratings.
- `pg_owner` Can maintain a PG owner profile, submit verification documents, create properties, create `pg_room` and
  `hostel_bed` listings, manage incoming interest requests, confirm connections, and receive ratings.
- `admin` Can review PG owner verification requests and moderate rating reports.
- Mixed-role users A single user can hold multiple roles. Route-level access checks look at the JWT role array, and
  service-layer ownership checks still apply.

## Pagination Conventions

Most feed-style endpoints use keyset pagination.

Common query params:

- `limit`
- `cursorTime`
- `cursorId`

Typical response shape:

```json
{
	"status": "success",
	"data": {
		"items": [],
		"nextCursor": {
			"cursorTime": "2026-04-11T07:15:00.000Z",
			"cursorId": "33333333-3333-4333-8333-333333333333"
		}
	}
}
```

If there is no next page, `nextCursor` is `null`.

## Background Jobs That Affect API Behavior

The API process also runs cron jobs. These are not called directly by frontend clients, but they can change what API
endpoints return.

- Listing expiry cron marks aged listings unavailable/expired.
- Expiry-warning cron enqueues warning notifications before listing expiry.
- Hard-delete cleanup cron permanently removes aged soft-deleted rows.

Frontend clients should expect list/detail endpoints to reflect these lifecycle updates between two reads, even when no
user action occurred.

## How To Read The Feature Docs

Each feature doc includes:

- request contract details
- concrete JSON request bodies
- concrete success bodies
- validation, auth, conflict, not-found, and business-rule error examples
- scenario tables explaining why different responses happen

## Feature Docs

- [Shared Conventions](./api/conventions.md)
- [Auth](./api/auth.md)
- [Profiles and Contact Reveal](./api/profiles-and-contact.md)
- [Properties](./api/properties.md)
- [Listings](./api/listings.api.md)
- [Interests](./api/interests.md)
- [Connections](./api/connections.md)
- [Notifications](./api/notifications.md)
- [Ratings and Reports](./api/ratings-and-reports.md)
- [Preferences](./api/preferences.md)
- [Admin](./api/admin.md)
- [Health](./api/health.md)

**Response:**

```json
{
	"status": "success",
	"data": {
		"userId": "uuid",
		"sid": "uuid",
		"email": "priya@iitb.ac.in",
		"roles": ["student"],
		"isEmailVerified": true,
		"accountStatus": "active"
	}
}
```

---

### POST /auth/google/callback

Authenticates via Google. The client obtains a Google ID token via Google One Tap or GoogleSignIn SDK and POSTs it here.
The server verifies the token signature — the frontend never handles the OAuth redirect flow.

**No auth required.**

**Request body:**

```json
{
	"idToken": "google-id-token-string",
	"role": "student",
	"fullName": "Priya Sharma",
	"businessName": "Sunrise PG"
}
```

`role`, `fullName`, and `businessName` are only required for first-time registration. Returning users omit them.

**Response:** `200` with token payload.

**Three internal paths:** returning user (found by Google ID), account linking (found by email, links Google ID), new
registration.

---

## 3. Student Profiles

### GET /students/:userId/profile

**Auth required.**

Returns the student's profile. `email` is only included when the requesting user is the profile owner.

**Response:**

```json
{
	"status": "success",
	"data": {
		"profile_id": "uuid",
		"user_id": "uuid",
		"full_name": "Priya Sharma",
		"date_of_birth": "2001-08-15",
		"gender": "female",
		"profile_photo_url": "https://...",
		"bio": "CS student at IIT Bombay",
		"course": "B.Tech Computer Science",
		"year_of_study": 2,
		"institution_id": "uuid",
		"is_aadhaar_verified": false,
		"email": "priya@iitb.ac.in",
		"is_email_verified": true,
		"average_rating": 4.5,
		"rating_count": 3,
		"created_at": "2025-01-01T00:00:00.000Z"
	}
}
```

`email` is `null` for non-owner viewers.

**Errors:** `404` if profile not found.

---

### PUT /students/:userId/profile

**Auth required.** Only the profile owner can update.

**Request body** (all fields optional):

```json
{
	"fullName": "Priya Sharma",
	"bio": "CS student",
	"course": "B.Tech Computer Science",
	"yearOfStudy": 2,
	"gender": "female",
	"dateOfBirth": "2001-08-15"
}
```

| Field         | Type   | Constraints                                    |
| ------------- | ------ | ---------------------------------------------- |
| `fullName`    | string | Min 2, max 255 chars                           |
| `bio`         | string | Max 500 chars                                  |
| `course`      | string | Max 255 chars                                  |
| `yearOfStudy` | number | Integer 1–7                                    |
| `gender`      | string | `male`, `female`, `other`, `prefer_not_to_say` |
| `dateOfBirth` | string | `YYYY-MM-DD` format                            |

**Response:** Updated profile object.

**Errors:** `403` if not the profile owner. `400` if no valid fields provided.

---

## 4. PG Owner Profiles

### GET /pg-owners/:userId/profile

**Auth required.**

`business_phone` and `email` are only included for the profile owner.

**Response:**

```json
{
	"status": "success",
	"data": {
		"profile_id": "uuid",
		"user_id": "uuid",
		"business_name": "Sunrise PG",
		"owner_full_name": "Rajesh Kumar",
		"business_description": "Clean rooms near campus",
		"business_phone": "+919876543210",
		"operating_since": 2018,
		"verification_status": "verified",
		"verified_at": "2025-01-10T00:00:00.000Z",
		"email": "rajesh@sunrise.in",
		"is_email_verified": true,
		"average_rating": 4.2,
		"rating_count": 12,
		"created_at": "2025-01-01T00:00:00.000Z"
	}
}
```

`verification_status` values: `"unverified"`, `"pending"`, `"verified"`, `"rejected"`.

**Errors:** `404` if profile not found.

---

### PUT /pg-owners/:userId/profile

**Auth required.** Role: `pg_owner`. Only profile owner can update.

**Request body** (all fields optional):

```json
{
	"businessName": "Sunrise PG",
	"ownerFullName": "Rajesh Kumar",
	"businessDescription": "Clean rooms near campus",
	"businessPhone": "+919876543210",
	"operatingSince": 2018
}
```

| Field            | Type   | Constraints                       |
| ---------------- | ------ | --------------------------------- |
| `businessPhone`  | string | 7–15 digits, optional leading `+` |
| `operatingSince` | number | Integer 1900–current year         |

**Response:** Updated profile object.

---

### POST /pg-owners/:userId/documents

Submits a verification document. Sets `verification_status` to `"pending"`.

**Auth required.** Role: `pg_owner`. Only profile owner can submit.

**Request body:**

```json
{
	"documentType": "property_document",
	"documentUrl": "https://storage.example.com/doc.pdf"
}
```

`documentType` values: `"property_document"`, `"rental_agreement"`, `"owner_id"`, `"trade_license"`.

**Response:** `201` with the created verification request record.

**Errors:** `409` if a pending request already exists.

---

## 5. Contact Reveal

These endpoints are the only way to see a user's contact details (email and WhatsApp). Standard profile endpoints never
expose this information.

**Two access tiers:**

| Caller                                   | Gets                   | Quota                  |
| ---------------------------------------- | ---------------------- | ---------------------- |
| Verified user (`isEmailVerified = true`) | Email + WhatsApp phone | Unlimited              |
| Guest / unverified user                  | Email only             | 10 reveals per 30 days |

On the 11th reveal attempt by a guest, the API returns `401` with `code: "CONTACT_REVEAL_LIMIT_REACHED"` and a
`loginRedirect` field. Quota is tracked via Redis (IP + User-Agent fingerprint) with an HttpOnly cookie fallback.

### GET /students/:userId/contact/reveal

**Auth optional** (`optionalAuthenticate`).

**Success response:**

```json
{
	"status": "success",
	"data": {
		"user_id": "uuid",
		"full_name": "Priya Sharma",
		"email": "priya@iitb.ac.in",
		"whatsapp_phone": "+919876543210"
	}
}
```

`whatsapp_phone` is omitted for guests and unverified users.

**Limit reached response** (`401`):

```json
{
	"status": "error",
	"message": "Free contact reveal limit reached. Please log in or sign up to continue.",
	"code": "CONTACT_REVEAL_LIMIT_REACHED",
	"loginRedirect": "/login/signup"
}
```

---

### GET /pg-owners/:userId/contact/reveal

Same behaviour as student contact reveal. `whatsapp_phone` is the `business_phone` from the PG owner's profile.

**Success response:**

```json
{
	"status": "success",
	"data": {
		"user_id": "uuid",
		"owner_full_name": "Rajesh Kumar",
		"business_name": "Sunrise PG",
		"email": "rajesh@sunrise.in",
		"whatsapp_phone": "+919876543210"
	}
}
```

---

## 6. Admin — Verification

All admin endpoints require authentication and the `admin` role. Auth is enforced at the router level — there is no
unprotected route under `/admin`.

### GET /admin/verification-queue

Returns pending PG owner verification requests, oldest first (anti-starvation).

**Auth required.** Role: `admin`.

**Query params:** Standard pagination (`cursorTime`, `cursorId`, `limit`). See [Section 19](#19-pagination).

**Response:**

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"request_id": "uuid",
				"user_id": "uuid",
				"document_type": "property_document",
				"document_url": "https://...",
				"submitted_at": "2025-01-15T10:00:00.000Z",
				"business_name": "Sunrise PG",
				"owner_full_name": "Rajesh Kumar",
				"verification_status": "pending",
				"email": "rajesh@sunrise.in"
			}
		],
		"nextCursor": { "cursorTime": "...", "cursorId": "..." }
	}
}
```

---

### POST /admin/verification-queue/:requestId/approve

Approves a verification request. Sets `verification_status = "verified"` on the PG owner's profile.

**Auth required.** Role: `admin`.

**Request body:**

```json
{ "adminNotes": "All documents verified" }
```

**Response:**

```json
{ "status": "success", "data": { "requestId": "uuid", "status": "verified" } }
```

**Errors:** `409` if request is already resolved.

---

### POST /admin/verification-queue/:requestId/reject

Rejects a verification request.

**Auth required.** Role: `admin`.

**Request body:**

```json
{
	"rejectionReason": "Document is expired",
	"adminNotes": "Driving license expired in 2023"
}
```

`rejectionReason` is required. `adminNotes` is optional.

**Response:**

```json
{ "status": "success", "data": { "requestId": "uuid", "status": "rejected" } }
```

**Errors:** `409` if already resolved.

---

## 7. Properties

Properties are physical PG or hostel buildings. Only verified PG owners can create/update/delete them.

### POST /properties

**Auth required.** Role: `pg_owner`. Account must have `verification_status = "verified"`.

**Request body:**

```json
{
	"propertyName": "Sunrise PG",
	"description": "Clean rooms near IIT Bombay",
	"propertyType": "pg",
	"addressLine": "12 Hostel Road, Powai",
	"city": "Mumbai",
	"locality": "Powai",
	"landmark": "Near IIT Main Gate",
	"pincode": "400076",
	"latitude": 19.1334,
	"longitude": 72.9133,
	"houseRules": "No smoking. Gates close at 11 PM.",
	"totalRooms": 20,
	"amenityIds": ["uuid1", "uuid2"]
}
```

| Field                    | Type   | Required        | Notes                                    |
| ------------------------ | ------ | --------------- | ---------------------------------------- |
| `propertyName`           | string | ✅              | Min 2, max 255                           |
| `propertyType`           | string | ✅              | `"pg"`, `"hostel"`, `"shared_apartment"` |
| `addressLine`            | string | ✅              | Min 5, max 500                           |
| `city`                   | string | ✅              | Min 2, max 100                           |
| `latitude` / `longitude` | number | both or neither | Enables proximity search                 |
| `amenityIds`             | uuid[] | ✅              | Can be empty array                       |

**Response:** `201` with property object including joined amenity details.

---

### GET /properties

Lists the authenticated PG owner's own properties.

**Auth required.** Role: `pg_owner`.

**Query params:** Standard pagination. Optional `city` filter.

**Response:**

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"property_id": "uuid",
				"property_name": "Sunrise PG",
				"property_type": "pg",
				"city": "Mumbai",
				"locality": "Powai",
				"status": "active",
				"average_rating": 4.2,
				"rating_count": 12,
				"amenity_count": 8,
				"active_listing_count": 5,
				"created_at": "..."
			}
		],
		"nextCursor": null
	}
}
```

---

### GET /properties/:propertyId

**Auth required.** Readable by any authenticated user (students need this for listing detail pages).

**Response:** Full property object with amenity array.

**Errors:** `404` if not found.

---

### PUT /properties/:propertyId

**Auth required.** Role: `pg_owner`. Only the owner can update.

All fields are optional. When city, address, or coordinates change, those values are automatically cascaded to all
linked `pg_room` and `hostel_bed` listings in the same transaction.

**Request body:** Same fields as `POST /properties`, all optional. `amenityIds` replaces the full amenity list when
provided.

**Response:** Updated property with amenities.

**Errors:** `404` if not found or not owner. `400` if no valid fields provided.

---

### DELETE /properties/:propertyId

Soft-deletes the property.

**Auth required.** Role: `pg_owner`. Only owner can delete.

**Errors:** `409` if any active listings exist under this property (deactivate them first).

**Response:**

```json
{ "status": "success", "data": { "propertyId": "uuid", "deleted": true } }
```

---

## 8. Listings

Listings are individual rooms. Both students (creating `student_room`) and verified PG owners (creating `pg_room` or
`hostel_bed`) use these endpoints.

**The paise rule:** Rent and deposit are stored in paise internally. All API responses return values in rupees (divided
by 100). The API also accepts rupees as input — conversion is handled server-side.

### POST /listings

**Auth required.** Students create `student_room`; verified PG owners create `pg_room` or `hostel_bed`.

**Request body:**

```json
{
	"listingType": "pg_room",
	"propertyId": "uuid",
	"title": "Furnished single room with AC",
	"description": "Quiet room on 3rd floor",
	"rentPerMonth": 8500,
	"depositAmount": 17000,
	"rentIncludesUtilities": false,
	"isNegotiable": true,
	"roomType": "single",
	"bedType": "single_bed",
	"totalCapacity": 1,
	"preferredGender": "female",
	"availableFrom": "2025-02-01",
	"availableUntil": "2025-12-31",
	"addressLine": "12 Hostel Road",
	"city": "Mumbai",
	"locality": "Powai",
	"latitude": 19.1334,
	"longitude": 72.9133,
	"amenityIds": ["uuid1", "uuid2"],
	"preferences": [{ "preferenceKey": "smoking", "preferenceValue": "non_smoker" }]
}
```

| Field                   | Type     | Required                        | Notes                                                                         |
| ----------------------- | -------- | ------------------------------- | ----------------------------------------------------------------------------- |
| `listingType`           | string   | ✅                              | `"student_room"`, `"pg_room"`, `"hostel_bed"`                                 |
| `propertyId`            | uuid     | ✅ if `pg_room` or `hostel_bed` | Must belong to the caller                                                     |
| `title`                 | string   | ✅                              | Min 5, max 255                                                                |
| `rentPerMonth`          | number   | ✅                              | Integer rupees, min 0                                                         |
| `depositAmount`         | number   |                                 | Integer rupees, default 0                                                     |
| `roomType`              | string   | ✅                              | `"single"`, `"double"`, `"triple"`, `"entire_flat"`                           |
| `bedType`               | string   |                                 | `"single_bed"`, `"double_bed"`, `"bunk_bed"`                                  |
| `totalCapacity`         | number   |                                 | Integer 1–20, default 1                                                       |
| `availableFrom`         | string   | ✅                              | `YYYY-MM-DD` format                                                           |
| `addressLine`, `city`   | string   | ✅ if `student_room`            | Location for student listings                                                 |
| `latitude`, `longitude` | number   | both or neither                 | Only for `student_room`; not accepted for pg/hostel (inherited from property) |
| `amenityIds`            | uuid[]   |                                 | Array of amenity UUIDs                                                        |
| `preferences`           | object[] |                                 | `{ preferenceKey, preferenceValue }` pairs                                    |

**Response:** `201` with full listing detail including amenities, preferences, photos, and property info.

`expires_at` is set server-side to `NOW() + 60 days` — never sent by the client.

---

### GET /listings

Search listings. All query params are optional.

**Auth required.**

**Query params:**

| Param                             | Type   | Notes                                                              |
| --------------------------------- | ------ | ------------------------------------------------------------------ |
| `city`                            | string | Case-insensitive prefix match                                      |
| `minRent`                         | number | Rupees                                                             |
| `maxRent`                         | number | Rupees                                                             |
| `roomType`                        | string | `single`, `double`, `triple`, `entire_flat`                        |
| `bedType`                         | string | `single_bed`, `double_bed`, `bunk_bed`                             |
| `preferredGender`                 | string | `male`, `female`, `other`, `prefer_not_to_say`                     |
| `listingType`                     | string | `student_room`, `pg_room`, `hostel_bed`                            |
| `availableFrom`                   | string | `YYYY-MM-DD` — listings available on or before this date           |
| `lat`, `lng`                      | number | Both required together for proximity search                        |
| `radius`                          | number | Metres, default 5000, max 50000                                    |
| `amenityIds`                      | string | Comma-separated UUIDs — listings must have ALL specified amenities |
| `cursorTime`, `cursorId`, `limit` |        | Standard pagination                                                |

**Response:**

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"listing_id": "uuid",
				"listing_type": "pg_room",
				"title": "Furnished single room with AC",
				"city": "Mumbai",
				"locality": "Powai",
				"rentPerMonth": 8500,
				"depositAmount": 17000,
				"room_type": "single",
				"preferred_gender": "female",
				"available_from": "2025-02-01",
				"status": "active",
				"property_name": "Sunrise PG",
				"average_rating": 4.2,
				"cover_photo_url": "https://...",
				"compatibilityScore": 3,
				"created_at": "..."
			}
		],
		"nextCursor": { "cursorTime": "...", "cursorId": "..." }
	}
}
```

`compatibilityScore` is the count of matching preferences between the listing and the authenticated user's preferences.
Higher = better match.

---

### GET /listings/:listingId

Returns full listing detail including amenities, preferences, all photos, and parent property info.

**Auth required.** Increments `views_count` asynchronously (fire-and-forget).

**Response:**

```json
{
	"status": "success",
	"data": {
		"listing_id": "uuid",
		"posted_by": "uuid",
		"property_id": "uuid",
		"listing_type": "pg_room",
		"title": "Furnished single room with AC",
		"description": "...",
		"rentPerMonth": 8500,
		"depositAmount": 17000,
		"rent_includes_utilities": false,
		"is_negotiable": true,
		"room_type": "single",
		"bed_type": "single_bed",
		"total_capacity": 1,
		"current_occupants": 0,
		"preferred_gender": "female",
		"available_from": "2025-02-01",
		"available_until": "2025-12-31",
		"city": "Mumbai",
		"locality": "Powai",
		"status": "active",
		"views_count": 47,
		"expires_at": "2025-03-15T00:00:00.000Z",
		"created_at": "...",
		"poster_name": "Rajesh Kumar",
		"poster_rating": 4.2,
		"poster_rating_count": 12,
		"amenities": [{ "amenityId": "uuid", "name": "WiFi", "category": "utility", "iconName": "wifi" }],
		"preferences": [{ "preferenceKey": "smoking", "preferenceValue": "non_smoker" }],
		"photos": [{ "photoId": "uuid", "photoUrl": "https://...", "isCover": true, "displayOrder": 0 }],
		"property": {
			"propertyId": "uuid",
			"propertyName": "Sunrise PG",
			"propertyType": "pg",
			"addressLine": "12 Hostel Road",
			"city": "Mumbai",
			"averageRating": 4.1,
			"ratingCount": 8
		}
	}
}
```

**Errors:** `404` if not found.

---

### PUT /listings/:listingId

**Auth required.** Only the poster can update.

All body fields are optional. `amenityIds` and `preferences` replace their full sets when provided. For `pg_room` and
`hostel_bed` listings, location fields (`addressLine`, `city`, `locality`, `landmark`, `pincode`, `latitude`,
`longitude`) are rejected — update the parent property instead.

**Errors:** `404` if not found or not owner. `422` if forbidden location fields are sent for property-linked listing
types.

---

### PATCH /listings/:listingId/status

Poster-initiated status transitions.

**Auth required.** Only the poster can change status.

**Request body:**

```json
{ "status": "deactivated" }
```

Allowed transitions:

| From          | To                      |
| ------------- | ----------------------- |
| `active`      | `filled`, `deactivated` |
| `deactivated` | `active`                |

`filled` and `expired` are terminal — no transition out of them. `expired` is only set by the cron job. Deactivating or
filling a listing automatically expires all pending interest requests on it.

**Errors:** `422` if transition is not allowed. `409` if status changed concurrently.

---

### DELETE /listings/:listingId

Soft-deletes the listing and expires all pending interest requests.

**Auth required.** Only the poster can delete.

**Response:**

```json
{ "status": "success", "data": { "listingId": "uuid", "deleted": true } }
```

---

## 9. Listing Photos

Photos are uploaded asynchronously. The upload endpoint returns `202 Accepted` immediately. The actual processing (Sharp
compression → WebP → storage write) happens in a background worker. Poll `GET /listings/:listingId/photos` to check when
processing is complete.

**Never render a `photoUrl` that starts with `processing:`** — this is a placeholder sentinel for photos still being
processed.

### POST /listings/:listingId/photos

Upload a photo. Sends the file as `multipart/form-data` with field name `photo`.

**Auth required.** Only the listing poster can upload.

**Accepted file types:** JPEG, PNG, WebP. Max size: 10MB.

**Response:** `202 Accepted`

```json
{
	"status": "success",
	"data": { "photoId": "uuid", "status": "processing" }
}
```

---

### GET /listings/:listingId/photos

Returns all processed (non-placeholder) photos for a listing, ordered by `displayOrder`.

**Auth required.**

**Response:**

```json
{
	"status": "success",
	"data": [
		{
			"photoId": "uuid",
			"photoUrl": "https://...",
			"isCover": true,
			"displayOrder": 0,
			"createdAt": "..."
		}
	]
}
```

---

### DELETE /listings/:listingId/photos/:photoId

Soft-deletes the photo and deletes it from storage. If the deleted photo was the cover, the next photo by `displayOrder`
is automatically elected as cover.

**Auth required.** Only the listing poster can delete.

**Response:**

```json
{ "status": "success", "data": { "photoId": "uuid", "deleted": true } }
```

---

### PATCH /listings/:listingId/photos/:photoId/cover

Sets a specific photo as the listing's cover image. Clears the existing cover in the same operation.

**Auth required.** Only the listing poster.

**Response:**

```json
{ "status": "success", "data": { "photoId": "uuid", "isCover": true } }
```

---

### PUT /listings/:listingId/photos/reorder

Reorders all photos. The payload must include every active photo for the listing (no partial reorders).

**Auth required.** Only the listing poster.

**Request body:**

```json
{
	"photos": [
		{ "photoId": "uuid-a", "displayOrder": 0 },
		{ "photoId": "uuid-b", "displayOrder": 1 },
		{ "photoId": "uuid-c", "displayOrder": 2 }
	]
}
```

All `photoId` values and all `displayOrder` values must be unique within the payload.

**Response:** Array of all photos in the new order.

**Errors:** `422` if payload has duplicate IDs or orders, unknown photo IDs, or doesn't include all photos.

---

## 10. Listing Preferences

Preferences describe what the poster wants in a roommate/tenant. They are matched against the authenticated user's own
preferences to compute `compatibilityScore` in search results.

### GET /listings/:listingId/preferences

**Auth required.**

**Response:**

```json
{
	"status": "success",
	"data": [
		{ "preferenceKey": "smoking", "preferenceValue": "non_smoker" },
		{ "preferenceKey": "food_habit", "preferenceValue": "vegetarian" }
	]
}
```

---

### PUT /listings/:listingId/preferences

Replaces the full preference set for the listing.

**Auth required.** Only the listing poster.

**Request body:**

```json
{
	"preferences": [
		{ "preferenceKey": "smoking", "preferenceValue": "non_smoker" },
		{ "preferenceKey": "food_habit", "preferenceValue": "vegetarian" }
	]
}
```

An empty array clears all preferences.

**Response:** Updated preferences array.

---

## 11. Saved Listings

Students can save listings to review later.

### POST /listings/:listingId/save

**Auth required.** Role: `student`.

Idempotent — re-saving a previously unsaved listing restores it. Only active, non-expired listings can be saved.

**Response:**

```json
{ "status": "success", "data": { "listingId": "uuid", "saved": true } }
```

**Errors:** `404` if listing not found. `422` if listing is expired or inactive.

---

### DELETE /listings/:listingId/save

**Auth required.** Role: `student`.

Idempotent — unsaving a listing that was already unsaved is a no-op.

**Response:**

```json
{ "status": "success", "data": { "listingId": "uuid", "saved": false } }
```

---

### GET /listings/me/saved

Returns the authenticated student's saved listings. Silently omits soft-deleted and expired listings.

**Auth required.** Role: `student`.

**Query params:** Standard pagination (on `saved_at DESC`).

**Response:**

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"listing_id": "uuid",
				"listing_type": "pg_room",
				"title": "Furnished single room",
				"city": "Mumbai",
				"rentPerMonth": 8500,
				"depositAmount": 17000,
				"room_type": "single",
				"saved_at": "2025-01-15T10:00:00.000Z",
				"cover_photo_url": "https://...",
				"average_rating": 4.2
			}
		],
		"nextCursor": null
	}
}
```

---

## 12. Interest Requests

### POST /listings/:listingId/interests

A student expresses interest in a listing. Only one pending or accepted interest request per student per listing is
allowed.

**Auth required.** Role: `student`. A student cannot express interest in their own listing.

**Request body** (optional):

```json
{ "message": "Hi, I'm looking for a room from February." }
```

**Response:** `201`

```json
{
	"status": "success",
	"data": {
		"interestRequestId": "uuid",
		"studentId": "uuid",
		"listingId": "uuid",
		"message": "Hi, I'm looking for a room from February.",
		"status": "pending",
		"createdAt": "..."
	}
}
```

**Errors:** `404` if listing not found. `409` if already has a pending/accepted request. `422` if listing is expired or
not active.

---

### GET /listings/:listingId/interests

Returns all interest requests for a listing. Only the listing poster can view this.

**Auth required.** Only the poster can call this.

**Query params:** `status` filter (any `request_status_enum` value). Standard pagination.

**Response:**

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"interestRequestId": "uuid",
				"studentId": "uuid",
				"status": "pending",
				"message": "Hi, I'm looking for a room.",
				"createdAt": "...",
				"updatedAt": "...",
				"student": {
					"userId": "uuid",
					"fullName": "Priya Sharma",
					"profilePhotoUrl": "https://...",
					"averageRating": 4.5
				}
			}
		],
		"nextCursor": null
	}
}
```

**Errors:** `403` if not the listing owner.

---

### GET /interests/me

Returns the authenticated student's own interest requests across all listings.

**Auth required.** Role: `student`.

**Query params:** `status` filter. Standard pagination.

**Response:**

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"interestRequestId": "uuid",
				"listingId": "uuid",
				"status": "accepted",
				"message": "...",
				"createdAt": "...",
				"listing": {
					"listingId": "uuid",
					"title": "Furnished single room",
					"city": "Mumbai",
					"listingType": "pg_room",
					"rentPerMonth": 8500
				}
			}
		],
		"nextCursor": null
	}
}
```

---

### GET /interests/:interestId

Full detail for one interest request. Both the sender and the listing poster can view it.

**Auth required.**

**Response:**

```json
{
	"status": "success",
	"data": {
		"interestRequestId": "uuid",
		"studentId": "uuid",
		"listingId": "uuid",
		"message": "...",
		"status": "pending",
		"createdAt": "...",
		"updatedAt": "...",
		"listing": {
			"listingId": "uuid",
			"title": "...",
			"city": "Mumbai",
			"listingType": "pg_room"
		},
		"student": {
			"userId": "uuid",
			"fullName": "Priya Sharma",
			"profilePhotoUrl": "https://..."
		}
	}
}
```

**Errors:** `404` if not found or caller is not a party.

---

### PATCH /interests/:interestId/status

Triggers a status transition on an interest request.

**Auth required.** Both parties use this endpoint — the service determines the allowed action based on the caller's
role.

**Request body:**

```json
{ "status": "accepted" }
```

**Allowed values:** `"accepted"` (poster only), `"declined"` (poster only), `"withdrawn"` (sender only).

**Response for `accepted`:**

```json
{
	"status": "success",
	"data": {
		"interestRequestId": "uuid",
		"studentId": "uuid",
		"listingId": "uuid",
		"status": "accepted",
		"connectionId": "uuid",
		"whatsappLink": "https://wa.me/919876543210?text=...",
		"listingFilled": false
	}
}
```

`whatsappLink` is `null` if the poster has no phone number on file. `listingFilled: true` when this acceptance exhausted
the listing's capacity (useful for showing "Room is now full" messaging).

**Response for `declined` or `withdrawn`:**

```json
{
	"status": "success",
	"data": {
		"interestRequestId": "uuid",
		"studentId": "uuid",
		"listingId": "uuid",
		"status": "declined"
	}
}
```

**Errors:** `404` if not found or not a party. `409` if request is not in `pending` status. `422` if transition is
invalid.

---

## 13. Connections

A connection is created automatically when a poster accepts an interest request. There is no `POST /connections`
endpoint.

### POST /connections/:connectionId/confirm

Either party calls this to record that the real-world interaction (e.g. the student actually moved in) happened from
their side. Once both parties confirm, `confirmation_status` becomes `"confirmed"` and ratings become submittable.

**Auth required.** Both parties can call this.

**Response:**

```json
{
	"status": "success",
	"data": {
		"connectionId": "uuid",
		"initiatorConfirmed": true,
		"counterpartConfirmed": false,
		"confirmationStatus": "pending",
		"updatedAt": "..."
	}
}
```

When both flags become `true`, `confirmationStatus` becomes `"confirmed"` in the same response.

**Errors:** `404` if not found or caller is not a party.

---

### GET /connections/me

Returns all connections for the authenticated user, newest first.

**Auth required.**

**Query params:**

| Param                | Type   | Notes                                                      |
| -------------------- | ------ | ---------------------------------------------------------- |
| `confirmationStatus` | string | `pending`, `confirmed`, `denied`, `expired`                |
| `connectionType`     | string | `student_roommate`, `pg_stay`, `hostel_stay`, `visit_only` |
| Standard pagination  |        |                                                            |

**Response:**

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"connectionId": "uuid",
				"connectionType": "pg_stay",
				"confirmationStatus": "confirmed",
				"initiatorConfirmed": true,
				"counterpartConfirmed": true,
				"startDate": null,
				"endDate": null,
				"createdAt": "...",
				"listing": {
					"listingId": "uuid",
					"title": "Furnished single room",
					"city": "Mumbai",
					"rentPerMonth": 8500,
					"listingType": "pg_room"
				},
				"otherParty": {
					"userId": "uuid",
					"fullName": "Rajesh Kumar",
					"profilePhotoUrl": "https://...",
					"averageRating": 4.2
				}
			}
		],
		"nextCursor": null
	}
}
```

---

### GET /connections/:connectionId

Full detail for one connection. Both parties can see each other's confirmation status.

**Auth required.** Only parties to the connection can view it.

**Response:**

```json
{
  "status": "success",
  "data": {
    "connectionId": "uuid",
    "connectionType": "pg_stay",
    "confirmationStatus": "confirmed",
    "initiatorConfirmed": true,
    "counterpartConfirmed": true,
    "interestRequestId": "uuid",
    "createdAt": "...",
    "listing": { ... },
    "otherParty": {
      "userId": "uuid",
      "fullName": "Rajesh Kumar",
      "profilePhotoUrl": "https://...",
      "averageRating": 4.20,
      "ratingCount": 5
    }
  }
}
```

**Errors:** `404` if not found or caller is not a party.

---

## 14. Notifications

### GET /notifications

Returns the notification feed for the authenticated user, newest first.

**Auth required.**

**Query params:**

| Param               | Type    | Notes                                    |
| ------------------- | ------- | ---------------------------------------- |
| `isRead`            | boolean | `true` or `false` — filter by read state |
| Standard pagination |         |                                          |

**Response:**

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"notificationId": "uuid",
				"actorId": "uuid",
				"type": "interest_request_received",
				"entityType": "interest_request",
				"entityId": "uuid",
				"message": "Someone expressed interest in your listing",
				"isRead": false,
				"createdAt": "..."
			}
		],
		"nextCursor": null
	}
}
```

**Notification types:**

| Type                         | Trigger                                                      |
| ---------------------------- | ------------------------------------------------------------ |
| `interest_request_received`  | A student sends an interest request                          |
| `interest_request_accepted`  | Poster accepts the request                                   |
| `interest_request_declined`  | Poster declines the request                                  |
| `interest_request_withdrawn` | Student withdraws the request                                |
| `connection_confirmed`       | Both parties have confirmed                                  |
| `rating_received`            | A rating was submitted for you                               |
| `listing_expiring`           | Your listing will expire within 7 days (or has just expired) |
| `listing_filled`             | Your listing's last slot was just filled                     |
| `verification_approved`      | Admin approved your verification (planned)                   |
| `verification_rejected`      | Admin rejected your verification (planned)                   |
| `new_message`                | Reserved for future messaging phase                          |

Use `entityType` and `entityId` to navigate the user to the relevant page.

---

### GET /notifications/unread-count

Returns the unread count for the bell badge. Fast — hits a partial index.

**Auth required.**

**Response:**

```json
{ "status": "success", "data": { "count": 5 } }
```

---

### POST /notifications/mark-read

Marks notifications as read. Idempotent — marking already-read notifications is a no-op.

**Auth required.**

**Request body — mark all:**

```json
{ "all": true }
```

**Request body — mark specific:**

```json
{ "notificationIds": ["uuid1", "uuid2"] }
```

`all` and `notificationIds` are mutually exclusive. `all` can only be `true` (sending `false` is a validation error).

**Response:**

```json
{ "status": "success", "data": { "updated": 5 } }
```

---

## 15. Ratings

Ratings can only be submitted after a connection's `confirmationStatus = "confirmed"`. A reviewer can rate their
counterparty (as a `user`) and/or the property where the stay happened (as a `property`).

### POST /ratings

**Auth required.**

**Request body:**

```json
{
	"connectionId": "uuid",
	"revieweeType": "user",
	"revieweeId": "uuid",
	"overallScore": 4,
	"cleanlinessScore": 5,
	"communicationScore": 4,
	"reliabilityScore": 4,
	"valueScore": 3,
	"comment": "Great host, very responsive."
}
```

| Field                | Type   | Required | Notes                                                  |
| -------------------- | ------ | -------- | ------------------------------------------------------ |
| `connectionId`       | uuid   | ✅       | Must be a confirmed connection where caller is a party |
| `revieweeType`       | string | ✅       | `"user"` or `"property"`                               |
| `revieweeId`         | uuid   | ✅       | The user or property being reviewed                    |
| `overallScore`       | number | ✅       | Integer 1–5                                            |
| `cleanlinessScore`   | number |          | Integer 1–5                                            |
| `communicationScore` | number |          | Integer 1–5                                            |
| `reliabilityScore`   | number |          | Integer 1–5                                            |
| `valueScore`         | number |          | Integer 1–5                                            |
| `comment`            | string |          | Max 2000 chars                                         |

**Response:** `201`

```json
{ "status": "success", "data": { "ratingId": "uuid", "createdAt": "..." } }
```

**Errors:** `404` if connection not found or caller not a party. `409` if already rated this reviewee on this
connection. `422` if connection not confirmed, or reviewee is not a valid party to the connection.

---

### GET /ratings/user/:userId

Public rating history for any user. **No auth required.**

**Query params:** Standard pagination.

**Response:**

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"ratingId": "uuid",
				"overallScore": 4,
				"cleanlinessScore": 5,
				"communicationScore": 4,
				"reliabilityScore": 4,
				"valueScore": 3,
				"comment": "Great host.",
				"createdAt": "...",
				"reviewer": {
					"fullName": "Priya Sharma",
					"profilePhotoUrl": "https://..."
				}
			}
		],
		"nextCursor": null
	}
}
```

---

### GET /ratings/property/:propertyId

Public rating history for a property. **No auth required.**

Same response shape as `GET /ratings/user/:userId`.

**Errors:** `404` if property not found.

---

### GET /ratings/connection/:connectionId

Both ratings for a connection from the caller's perspective. Only the two parties can access this.

**Auth required.**

**Response:**

```json
{
  "status": "success",
  "data": {
    "myRatings": [ { ...ratingObject } ],
    "theirRatings": [ { ...ratingObject } ]
  }
}
```

**Errors:** `404` if connection not found or caller not a party.

---

### GET /ratings/me/given

The authenticated user's full history of ratings they have submitted.

**Auth required.**

**Response:** Paginated list. Each item includes `isVisible` (whether the rating is visible to the public) and
`reviewee` details.

---

## 16. Reports

Any party to a connection can report a rating on that connection.

### POST /ratings/:ratingId/report

**Auth required.**

**Request body:**

```json
{
	"reason": "fake",
	"explanation": "I never stayed at this PG."
}
```

`reason` values: `"fake"`, `"abusive"`, `"conflict_of_interest"`, `"other"`.

**Response:** `201`

```json
{
	"status": "success",
	"data": {
		"reportId": "uuid",
		"reporterId": "uuid",
		"ratingId": "uuid",
		"reason": "fake",
		"status": "open",
		"createdAt": "..."
	}
}
```

**Errors:** `404` if rating not found or caller is not a party to the connection. `409` if an open report from this
reporter against this rating already exists.

---

## 17. Admin — Moderation

### GET /admin/report-queue

Returns open reports oldest-first. Each item includes the full rating content, the reporter's public profile, and the
reviewee's profile so the admin can decide without an extra request.

**Auth required.** Role: `admin`.

**Query params:** Standard pagination.

**Response:**

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"reportId": "uuid",
				"reporterId": "uuid",
				"ratingId": "uuid",
				"reason": "abusive",
				"explanation": "The review contains threats.",
				"status": "open",
				"submittedAt": "...",
				"rating": {
					"overallScore": 1,
					"comment": "...",
					"revieweeType": "user",
					"revieweeId": "uuid",
					"isVisible": true,
					"createdAt": "...",
					"reviewer": { "fullName": "...", "profilePhotoUrl": "..." },
					"reviewee": { "fullName": "...", "profilePhotoUrl": "..." }
				},
				"reporter": { "fullName": "...", "profilePhotoUrl": "..." }
			}
		],
		"nextCursor": null
	}
}
```

---

### PATCH /admin/reports/:reportId/resolve

Closes a report. Two outcomes only.

**Auth required.** Role: `admin`.

**Request body:**

```json
{
	"resolution": "resolved_removed",
	"adminNotes": "Review contains abusive language. Removing."
}
```

| `resolution`         | Effect                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `"resolved_removed"` | Sets `ratings.is_visible = false`; DB trigger recalculates `average_rating` automatically |
| `"resolved_kept"`    | Closes the report; rating stays visible                                                   |

`adminNotes` is required when `resolution = "resolved_removed"`.

**Response:**

```json
{
	"status": "success",
	"data": {
		"reportId": "uuid",
		"resolution": "resolved_removed",
		"ratingId": "uuid"
	}
}
```

**Errors:** `409` if report is already resolved or not found.

---

## 18. Health Check

### GET /health

**No auth required.** Used by load balancers and monitoring tools.

**Success response** (`200`):

```json
{
	"status": "ok",
	"timestamp": "2025-01-15T10:00:00.000Z",
	"services": {
		"database": "ok",
		"redis": "ok"
	}
}
```

**Degraded response** (`503`):

```json
{
	"status": "degraded",
	"timestamp": "...",
	"services": {
		"database": "unhealthy",
		"redis": "timeout"
	}
}
```

Service statuses: `"ok"`, `"unhealthy"`, `"timeout"`. Each probe has a 3-second timeout. Full internal error details are
logged server-side and never exposed in this response.

---

## 19. Pagination

All paginated endpoints use **keyset (cursor-based) pagination**. There is no `page=2` style offset — use the cursor
from the previous response to fetch the next page.

**Standard query params:**

| Param        | Type              | Default | Notes                      |
| ------------ | ----------------- | ------- | -------------------------- |
| `cursorTime` | ISO 8601 datetime | —       | Required with `cursorId`   |
| `cursorId`   | UUID              | —       | Required with `cursorTime` |
| `limit`      | integer           | 20      | Min 1, max 100             |

Both `cursorTime` and `cursorId` must be provided together or both omitted. Providing one without the other returns a
`400` validation error.

**Reading the next page:**

When `nextCursor` in the response is not `null`, pass `cursorTime` and `cursorId` from it as query params on the next
request.

```json
{
  "items": [ ... ],
  "nextCursor": {
    "cursorTime": "2025-01-10T08:00:00.000Z",
    "cursorId": "uuid-of-last-item"
  }
}
```

When `nextCursor` is `null`, you have reached the last page.

**Why keyset?** Offset pagination (`LIMIT x OFFSET y`) produces inconsistent results when new rows are inserted between
page requests. Keyset pagination on `(created_at DESC, entity_id ASC)` gives stable, gap-free results even under
concurrent writes.

---

## 20. Error Reference

### Standard error shape

```json
{
	"status": "error",
	"message": "Human-readable description"
}
```

### Validation errors (400)

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{ "field": "body.email", "message": "Must be a valid email address" },
		{ "field": "body.password", "message": "Password must be at least 8 characters" }
	]
}
```

### HTTP status codes used

| Code  | Meaning                                                                                       |
| ----- | --------------------------------------------------------------------------------------------- |
| `200` | Success                                                                                       |
| `201` | Created                                                                                       |
| `202` | Accepted (async processing started — e.g. photo upload)                                       |
| `400` | Bad request — validation failed or malformed body                                             |
| `401` | Unauthenticated — missing, invalid, or expired token                                          |
| `403` | Forbidden — authenticated but not authorised for this action                                  |
| `404` | Not found — resource doesn't exist or caller is not a party (never 403 for party checks)      |
| `409` | Conflict — duplicate resource, constraint violation, or concurrent state change               |
| `413` | Payload too large — file exceeds 10MB                                                         |
| `422` | Unprocessable — request is well-formed but semantically invalid (e.g. transition not allowed) |
| `429` | Too many requests — rate limit or OTP attempt limit exceeded                                  |
| `500` | Internal server error — unexpected failure                                                    |
| `503` | Service unavailable — dependency unhealthy                                                    |

### Common error messages

| Scenario                            | Status                                            |
| ----------------------------------- | ------------------------------------------------- |
| No token provided                   | `401`                                             |
| Token expired (Bearer header)       | `401`                                             |
| Account suspended/banned            | `401`                                             |
| Email already registered            | `409`                                             |
| Pending verification request exists | `409`                                             |
| Interest request already pending    | `409`                                             |
| Already rated this connection       | `409`                                             |
| Open report already exists          | `409`                                             |
| Listing not active/expired          | `422`                                             |
| Connection not yet confirmed        | `422`                                             |
| Status transition not allowed       | `422`                                             |
| OTP wrong (with remaining count)    | `400`                                             |
| OTP attempts exhausted              | `429`                                             |
| File type not accepted              | `400`                                             |
| File too large                      | `413`                                             |
| Contact reveal limit reached        | `401` with `code: "CONTACT_REVEAL_LIMIT_REACHED"` |
