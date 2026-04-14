# Listings API

This document covers listing discovery, CRUD, lifecycle transitions, preferences, saved listings, and photo processing.

Listings are role-sensitive:

- students can create `student_room` listings
- verified PG owners can create `pg_room` and `hostel_bed` listings

Prices are expressed in rupees in the API, even though the database stores paise internally.

## Search and Retrieval

### `GET /listings`

Searches active, non-expired listings visible to the authenticated caller.

#### Request Contract

- Auth required: Yes
- Supported query filters:
    - `city`
    - `minRent`
    - `maxRent`
    - `roomType`
    - `bedType`
    - `preferredGender`
    - `listingType`
    - `availableFrom`
    - `lat`
    - `lng`
    - `radius`
    - `amenityIds`
    - `limit`
    - `cursorTime`
    - `cursorId`

#### Scenario: search with city, rent, and amenity filters

Request:

```http
GET /api/v1/listings?city=Pune&minRent=7000&maxRent=12000&listingType=pg_room&amenityIds=2db2f8fc-d90c-47a1-aebb-c6fa9ea4450a,eec6f390-2906-4d50-bf26-4f937833c6f8
```

Status: `200`

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"listingId": "55555555-5555-4555-8555-555555555555",
				"listingType": "pg_room",
				"title": "Single room near Viman Nagar",
				"city": "Pune",
				"locality": "Viman Nagar",
				"rentPerMonth": 9500,
				"depositAmount": 5000,
				"roomType": "single",
				"preferredGender": "female",
				"availableFrom": "2026-05-01T00:00:00.000Z",
				"status": "active"
			}
		],
		"nextCursor": null
	}
}
```

#### Scenario: search with proximity filters

Request:

```http
GET /api/v1/listings?lat=18.5679&lng=73.9143&radius=5000&listingType=pg_room
```

Status: `200`

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"listingId": "55555555-5555-4555-8555-555555555555",
				"listingType": "pg_room",
				"title": "Single room near Viman Nagar",
				"city": "Pune",
				"rentPerMonth": 9500
			}
		],
		"nextCursor": {
			"cursorTime": "2026-04-11T10:20:00.000Z",
			"cursorId": "55555555-5555-4555-8555-555555555555"
		}
	}
}
```

#### Scenario: invalid rent range

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "query.minRent",
			"message": "minRent cannot be greater than maxRent"
		}
	]
}
```

#### Scenario: partial cursor supplied

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "query.cursorTime",
			"message": "cursorTime and cursorId must be provided together"
		}
	]
}
```

## Ranked Listing Search API

### `GET /listings/search/ranked`

Returns active listings ordered by a weighted composite score computed entirely in SQL, enabling correct keyset
pagination across ranked results.

**Auth required:** Yes

This endpoint is the ranked alternative to `GET /listings`. Use it when the client wants results sorted by relevance
rather than recency. The compatibility component automatically adapts to the user's preference state — users with no
stored preferences see a cold-start result set ranked by distance, rating, and freshness.

### How scoring works

Each listing receives a `rankScore` in [0, 1] calculated from four normalised components:

| Component   | Formula                                 | Notes                                                          |
| ----------- | --------------------------------------- | -------------------------------------------------------------- |
| `compat`    | `matched_prefs / total_effective_prefs` | 0 when no effective prefs exist                                |
| `rating`    | `avg_rating / 5.0`                      | 0 when listing has no ratings                                  |
| `freshness` | `exp(-age_days / 14)`                   | ~0.37 at 14 days, ~0.05 at 42 days                             |
| `distance`  | `1 - min(dist_m / radius_m, 1)`         | 1.0 at the origin, 0 at the radius edge; 0.5 when no geo given |

Component weights depend on whether the user has preferences and whether geo coordinates are provided:

| Scenario           | compat | rating | freshness | distance |
| ------------------ | ------ | ------ | --------- | -------- |
| Has prefs + geo    | 0.45   | 0.20   | 0.15      | 0.20     |
| Has prefs, no geo  | 0.55   | 0.25   | 0.20      | 0.00     |
| Cold-start + geo   | 0.00   | 0.35   | 0.25      | 0.40     |
| Cold-start, no geo | 0.00   | 0.55   | 0.45      | 0.00     |

### Three-layer preference stack

Effective preferences resolve in this order (higher layers override lower):

1. **preferenceOverrides** — temporary values from this request only
2. **Stored user_preferences** — values saved in the user's profile
3. _(fallback)_ — no preferences → cold-start weights, compat = 0

### Request contract

All query params are optional. Standard filter params are identical to `GET /listings`.

| Param                 | Type    | Notes                                                                            |
| --------------------- | ------- | -------------------------------------------------------------------------------- |
| `city`                | string  | Case-insensitive prefix match                                                    |
| `minRent` / `maxRent` | number  | Rupees                                                                           |
| `roomType`            | string  | `single`, `double`, `triple`, `entire_flat`                                      |
| `bedType`             | string  | `single_bed`, `double_bed`, `bunk_bed`                                           |
| `preferredGender`     | string  | `male`, `female`, `other`, `prefer_not_to_say`                                   |
| `listingType`         | string  | `student_room`, `pg_room`, `hostel_bed`                                          |
| `availableFrom`       | string  | `YYYY-MM-DD`                                                                     |
| `lat`, `lng`          | number  | Both required together                                                           |
| `radius`              | number  | Metres, default 5000, max 50000                                                  |
| `amenityIds`          | string  | Comma-separated UUIDs                                                            |
| `preferenceOverrides` | string  | **JSON-encoded** array of `{ preferenceKey, preferenceValue }`. Max 20 entries.  |
| `persistPreferences`  | boolean | `true` to upsert `preferenceOverrides` into `user_preferences`. Default `false`. |
| `cursorRankScore`     | number  | Float in [0, 1]. Required with `cursorId`.                                       |
| `cursorId`            | UUID    | Required with `cursorRankScore`.                                                 |
| `limit`               | integer | 1–100, default 20                                                                |

### Scenario: first page, user has stored preferences

```http
GET /api/v1/listings/search/ranked?city=Pune&listingType=pg_room
```

Status: `200`

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"listingId": "55555555-5555-4555-8555-555555555555",
				"listingType": "pg_room",
				"title": "Single room near Viman Nagar",
				"city": "Pune",
				"locality": "Viman Nagar",
				"rentPerMonth": 9500,
				"depositAmount": 5000,
				"roomType": "single",
				"preferredGender": "female",
				"availableFrom": "2026-05-01T00:00:00.000Z",
				"status": "active",
				"propertyName": "Sunrise PG Viman Nagar",
				"averageRating": 4.5,
				"coverPhotoUrl": null,
				"rankScore": 0.762,
				"scoreBreakdown": {
					"compat": 0.75,
					"rating": 0.9,
					"freshness": 0.62,
					"distance": 0.5
				}
			}
		],
		"nextCursor": {
			"cursorRankScore": 0.762,
			"cursorId": "55555555-5555-4555-8555-555555555555"
		},
		"searchMeta": {
			"isColdStart": false,
			"hasGeo": false,
			"effectivePrefCount": 4,
			"weights": {
				"compat": 0.55,
				"rating": 0.25,
				"freshness": 0.2,
				"distance": 0.0
			}
		}
	}
}
```

### Scenario: cold-start user with geo, temporary overrides

```http
GET /api/v1/listings/search/ranked
  ?lat=18.5679&lng=73.9143&radius=5000
  &preferenceOverrides=[{"preferenceKey":"smoking","preferenceValue":"non_smoker"}]
```

The overrides produce a partial effective pref set (1 key). Because stored prefs are empty and an override was supplied,
the user is no longer treated as fully cold-start — `effectivePrefCount` is 1 and compat weight shifts to the "has
prefs + geo" set.

### Scenario: next page using cursor

```http
GET /api/v1/listings/search/ranked
  ?city=Pune
  &cursorRankScore=0.762
  &cursorId=55555555-5555-4555-8555-555555555555
```

### Scenario: persist overrides for future searches

```http
GET /api/v1/listings/search/ranked
  ?preferenceOverrides=[{"preferenceKey":"smoking","preferenceValue":"non_smoker"}]
  &persistPreferences=true
```

The search runs normally, and after the response is assembled, the overrides are upserted into `user_preferences`.
Future searches (including non-ranked ones) will use these as stored preferences.

### Scenario: invalid cursor (one field without the other)

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "query.cursorRankScore",
			"message": "cursorRankScore and cursorId must be provided together"
		}
	]
}
```

### Integrator notes

- `rankScore` and `scoreBreakdown` values are floats rounded to ~6 decimal places. Do not display raw values to end
  users — use them for ordering only.
- The cursor is not interchangeable with the `GET /listings` cursor. Ranked and unranked search use different pagination
  schemes.
- `persistPreferences=true` is fire-and-forget on the server after the response is sent. The client does not receive
  confirmation of persistence in the search response itself.
- Cold-start users will see good results immediately via rating + freshness + distance signals. As they interact with
  listings and preferences accumulate, the compat weight will increase automatically on subsequent calls without any
  client-side changes.
- The `scoreBreakdown.distance` field is `0.5` (neutral) for requests without `lat`/`lng`, not `0.0`. This prevents a
  distance component of zero from pulling down the rank score for listings near the user in cases where geo wasn't
  provided.

### `GET /listings/:listingId`

Fetches full listing detail. This also increments `views_count` asynchronously after the read succeeds.

#### Scenario: success

Status: `200`

```json
{
	"status": "success",
	"data": {
		"listingId": "55555555-5555-4555-8555-555555555555",
		"postedBy": "22222222-2222-4222-8222-222222222222",
		"propertyId": "44444444-4444-4444-8444-444444444444",
		"listingType": "pg_room",
		"title": "Single room near Viman Nagar",
		"description": "Ideal for students and interns.",
		"rentPerMonth": 9500,
		"depositAmount": 5000,
		"roomType": "single",
		"bedType": "single_bed",
		"totalCapacity": 1,
		"currentOccupants": 0,
		"preferredGender": "female",
		"availableFrom": "2026-05-01T00:00:00.000Z",
		"availableUntil": null,
		"addressLine": null,
		"city": "Pune",
		"locality": null,
		"landmark": null,
		"pincode": null,
		"latitude": null,
		"longitude": null,
		"status": "active",
		"viewsCount": 12,
		"expiresAt": "2026-06-10T10:00:00.000Z",
		"poster_rating": 4.5,
		"poster_rating_count": 12,
		"poster_name": "Rohan Mehta",
		"amenities": [],
		"preferences": [],
		"photos": [],
		"property": {
			"propertyId": "44444444-4444-4444-8444-444444444444",
			"propertyName": "Sunrise PG Viman Nagar",
			"propertyType": "pg",
			"addressLine": "Lane 5, Viman Nagar",
			"city": "Pune",
			"locality": "Viman Nagar",
			"latitude": 18.5679,
			"longitude": 73.9143,
			"houseRules": "No smoking inside rooms.",
			"averageRating": 4.5,
			"ratingCount": 12
		}
	}
}
```

#### Scenario: listing not found

Status: `404`

```json
{
	"status": "error",
	"message": "Listing not found"
}
```

## Create, Update, and Delete

### `POST /listings`

Creates a listing owned by the authenticated user.

#### Student room request example

```json
{
	"listingType": "student_room",
	"title": "Looking for a roommate near IIT Bombay",
	"description": "Two-bedroom flat, one room available.",
	"rentPerMonth": 12000,
	"depositAmount": 15000,
	"rentIncludesUtilities": false,
	"isNegotiable": true,
	"roomType": "single",
	"bedType": "single_bed",
	"totalCapacity": 1,
	"preferredGender": "female",
	"availableFrom": "2026-05-01",
	"addressLine": "Flat 8B, Powai Residency",
	"city": "Mumbai",
	"locality": "Powai",
	"landmark": "Near IIT Main Gate",
	"pincode": "400076",
	"latitude": 19.1334,
	"longitude": 72.9133,
	"amenityIds": [],
	"preferences": [
		{
			"preferenceKey": "sleep_schedule",
			"preferenceValue": "early"
		}
	]
}
```

#### PG room request example

```json
{
	"listingType": "pg_room",
	"propertyId": "44444444-4444-4444-8444-444444444444",
	"title": "Single room in verified PG",
	"description": "Meals and Wi-Fi included.",
	"rentPerMonth": 9500,
	"depositAmount": 5000,
	"rentIncludesUtilities": true,
	"isNegotiable": false,
	"roomType": "single",
	"bedType": "single_bed",
	"totalCapacity": 1,
	"preferredGender": "female",
	"availableFrom": "2026-05-01",
	"amenityIds": [],
	"preferences": []
}
```

#### Scenario: student creates `student_room`

Status: `201`

```json
{
	"status": "success",
	"data": {
		"listingId": "55555555-5555-4555-8555-555555555555",
		"listingType": "student_room",
		"title": "Looking for a roommate near IIT Bombay",
		"rentPerMonth": 12000
	}
}
```

#### Scenario: PG owner creates `pg_room`

Status: `201`

```json
{
	"status": "success",
	"data": {
		"listingId": "55555555-5555-4555-8555-555555555555",
		"listingType": "pg_room",
		"propertyId": "44444444-4444-4444-8444-444444444444",
		"title": "Single room in verified PG",
		"rentPerMonth": 9500
	}
}
```

#### Scenario: PG owner creates `hostel_bed`

Status: `201`

```json
{
	"status": "success",
	"data": {
		"listingId": "55555555-5555-4555-8555-555555555555",
		"listingType": "hostel_bed",
		"propertyId": "44444444-4444-4444-8444-444444444444",
		"title": "Hostel bed near college",
		"rentPerMonth": 6500
	}
}
```

#### Scenario: student tries to create `pg_room`

Status: `403`

```json
{
	"status": "error",
	"message": "Only verified PG owners can create pg_room or hostel_bed listings"
}
```

#### Scenario: PG owner tries to create `student_room`

Status: `403`

```json
{
	"status": "error",
	"message": "Only students can create student_room listings"
}
```

#### Scenario: PG owner is not verified

Status: `403`

```json
{
	"status": "error",
	"message": "Your account must be verified before you can manage properties or listings"
}
```

#### Scenario: property does not belong to owner

Status: `404`

```json
{
	"status": "error",
	"message": "Property not found or does not belong to you"
}
```

#### Scenario: student-room create missing `addressLine` and `city`

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "body.addressLine",
			"message": "addressLine and city are required for student_room listings"
		}
	]
}
```

#### Scenario: PG or hostel create includes coordinates

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "body.latitude",
			"message": "Coordinates are not accepted for pg_room or hostel_bed listings — location is inherited from the property"
		}
	]
}
```

### `PUT /listings/:listingId`

Updates a listing owned by the authenticated user.

#### Request example

```json
{
	"title": "Updated title",
	"description": "Now includes cleaning twice a week.",
	"rentPerMonth": 9800,
	"isNegotiable": true
}
```

#### Scenario: update succeeds

Status: `200`

```json
{
	"status": "success",
	"data": {
		"listingId": "55555555-5555-4555-8555-555555555555",
		"title": "Updated title",
		"rentPerMonth": 9800,
		"isNegotiable": true
	}
}
```

#### Scenario: no valid fields provided

Status: `400`

```json
{
	"status": "error",
	"message": "No valid fields provided for update"
}
```

#### Scenario: PG/hostel update attempts property-owned location fields

Status: `422`

```json
{
	"status": "error",
	"message": "Location fields (city, latitude) cannot be updated on a pg_room listing — they are inherited from the parent property. Update the property's address instead."
}
```

#### Scenario: listing not found

Status: `404`

```json
{
	"status": "error",
	"message": "Listing not found"
}
```

### `DELETE /listings/:listingId`

Soft-deletes a listing and expires pending requests as needed.

#### Scenario: delete succeeds

Status: `200`

```json
{
	"status": "success",
	"data": {
		"listingId": "55555555-5555-4555-8555-555555555555",
		"deleted": true
	}
}
```

## Lifecycle and Preferences

### `PATCH /listings/:listingId/status`

Supports poster-driven lifecycle transitions among `active`, `filled`, and `deactivated`.

#### Request

```json
{
	"status": "deactivated"
}
```

#### Scenario: update from active to deactivated

Status: `200`

```json
{
	"status": "success",
	"data": {
		"listingId": "55555555-5555-4555-8555-555555555555",
		"status": "deactivated"
	}
}
```

#### Scenario: update from active to filled

Status: `200`

```json
{
	"status": "success",
	"data": {
		"listingId": "55555555-5555-4555-8555-555555555555",
		"status": "filled"
	}
}
```

#### Scenario: invalid transition

Status: `422`

```json
{
	"status": "error",
	"message": "Cannot change listing status from 'filled' to 'deactivated'"
}
```

#### Scenario: listing already expired

Status: `422`

```json
{
	"status": "error",
	"message": "Listing has expired and is no longer available"
}
```

#### Scenario: concurrent state change

Status: `409`

```json
{
	"status": "error",
	"message": "Listing status has already changed — please refresh"
}
```

### `GET /listings/:listingId/preferences`

#### Scenario: success

Status: `200`

```json
{
	"status": "success",
	"data": [
		{
			"preferenceKey": "sleep_schedule",
			"preferenceValue": "early"
		},
		{
			"preferenceKey": "cleanliness",
			"preferenceValue": "high"
		}
	]
}
```

### `PUT /listings/:listingId/preferences`

#### Request

```json
{
	"preferences": [
		{
			"preferenceKey": "sleep_schedule",
			"preferenceValue": "early"
		}
	]
}
```

#### Scenario: update preferences succeeds

Status: `200`

```json
{
	"status": "success",
	"data": [
		{
			"preferenceKey": "sleep_schedule",
			"preferenceValue": "early"
		}
	]
}
```

## Saved Listings

### `POST /listings/:listingId/save`

Student-only endpoint for bookmarking a listing.

#### Scenario: save succeeds

Status: `200`

```json
{
	"status": "success",
	"data": {
		"listingId": "55555555-5555-4555-8555-555555555555",
		"saved": true
	}
}
```

#### Scenario: wrong role

Status: `403`

```json
{
	"status": "error",
	"message": "Forbidden"
}
```

#### Scenario: listing expired

Status: `422`

```json
{
	"status": "error",
	"message": "Listing has expired and is no longer available"
}
```

#### Scenario: listing unavailable

Status: `422`

```json
{
	"status": "error",
	"message": "Listing is no longer available"
}
```

### `DELETE /listings/:listingId/save`

#### Scenario: unsave succeeds

Status: `200`

```json
{
	"status": "success",
	"data": {
		"listingId": "55555555-5555-4555-8555-555555555555",
		"saved": false
	}
}
```

### `GET /listings/me/saved`

Returns the student's saved active listings.

#### Scenario: paginated saved listings

Status: `200`

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"listing_id": "55555555-5555-4555-8555-555555555555",
				"listing_type": "pg_room",
				"title": "Single room in verified PG",
				"city": "Pune",
				"locality": "Viman Nagar",
				"room_type": "single",
				"preferred_gender": "female",
				"available_from": "2026-05-01T00:00:00.000Z",
				"status": "active",
				"saved_at": "2026-04-11T10:30:00.000Z",
				"property_name": "Sunrise PG Viman Nagar",
				"average_rating": 4.5,
				"cover_photo_url": null,
				"rentPerMonth": 9500,
				"depositAmount": 5000
			}
		],
		"nextCursor": null
	}
}
```

## Photos

Photo uploads are asynchronous. The HTTP request inserts a provisional row and queues a worker job. Clients should poll
`GET /listings/:listingId/photos`.

### `GET /listings/:listingId/photos`

Returns completed photos only. Processing placeholders are hidden.

#### Scenario: success

Status: `200`

```json
{
	"status": "success",
	"data": [
		{
			"photoId": "6fd7cf0b-d6a7-4f31-bd0a-fdbcf5a5ef2e",
			"photoUrl": "https://storage.example.com/listings/555/photo-1.webp",
			"isCover": true,
			"displayOrder": 0,
			"createdAt": "2026-04-11T10:40:00.000Z"
		}
	]
}
```

### `POST /listings/:listingId/photos`

Uploads a staged image using `multipart/form-data`.

#### Multipart requirements

- field name: `photo`
- accepted MIME types: `image/jpeg`, `image/png`, `image/webp`
- max size: `10MB`

#### Scenario: upload accepted and queued

Status: `202`

```json
{
	"status": "success",
	"data": {
		"photoId": "6fd7cf0b-d6a7-4f31-bd0a-fdbcf5a5ef2e",
		"status": "processing"
	}
}
```

#### Scenario: file missing

Status: `400`

```json
{
	"status": "error",
	"message": "No file uploaded — send the image under the field name 'photo'"
}
```

#### Scenario: unsupported MIME or extension

Status: `400`

```json
{
	"status": "error",
	"message": "Unsupported file type: image/gif. Accepted types: JPEG, PNG, WebP"
}
```

#### Scenario: queue unavailable

Status: `503`

```json
{
	"status": "error",
	"message": "Photo processing queue is temporarily unavailable. Please retry."
}
```

### `DELETE /listings/:listingId/photos/:photoId`

#### Scenario: delete succeeds

Status: `200`

```json
{
	"status": "success",
	"data": {
		"photoId": "6fd7cf0b-d6a7-4f31-bd0a-fdbcf5a5ef2e",
		"deleted": true
	}
}
```

### `PATCH /listings/:listingId/photos/:photoId/cover`

#### Scenario: set cover succeeds

Status: `200`

```json
{
	"status": "success",
	"data": {
		"photoId": "6fd7cf0b-d6a7-4f31-bd0a-fdbcf5a5ef2e",
		"isCover": true
	}
}
```

#### Scenario: cover update conflicts with concurrent change

Status: `409`

```json
{
	"status": "error",
	"message": "Cover photo update conflicted with a concurrent change. Please retry."
}
```

### `PUT /listings/:listingId/photos/reorder`

#### Request

```json
{
	"photos": [
		{
			"photoId": "6fd7cf0b-d6a7-4f31-bd0a-fdbcf5a5ef2e",
			"displayOrder": 0
		},
		{
			"photoId": "bcf8f73b-b1bd-4e30-9a7e-a82a18252d28",
			"displayOrder": 1
		}
	]
}
```

#### Scenario: reorder succeeds

Status: `200`

```json
{
	"status": "success",
	"data": [
		{
			"photoId": "6fd7cf0b-d6a7-4f31-bd0a-fdbcf5a5ef2e",
			"photoUrl": "https://storage.example.com/listings/555/photo-1.webp",
			"isCover": true,
			"displayOrder": 0,
			"createdAt": "2026-04-11T10:40:00.000Z"
		}
	]
}
```

#### Scenario: duplicate `photoId`

Status: `422`

```json
{
	"status": "error",
	"message": "Duplicate photo IDs in reorder payload: 6fd7cf0b-d6a7-4f31-bd0a-fdbcf5a5ef2e"
}
```

#### Scenario: duplicate `displayOrder`

Status: `422`

```json
{
	"status": "error",
	"message": "Duplicate displayOrder values in reorder payload: 0"
}
```

#### Scenario: invalid photo IDs for this listing

Status: `422`

```json
{
	"status": "error",
	"message": "Invalid photo IDs for this listing: 11111111-aaaa-4aaa-8aaa-111111111111"
}
```

#### Scenario: incomplete payload

Status: `422`

```json
{
	"status": "error",
	"message": "Reorder payload must include all photos. Submitted 1, expected 3."
}
```

## Listing Scenario Matrix

| Scenario                         | Endpoint                                  | Status | Key behavior                               |
| -------------------------------- | ----------------------------------------- | ------ | ------------------------------------------ |
| Student creates roommate listing | `POST /listings`                          | `201`  | requires address and city                  |
| PG owner creates PG listing      | `POST /listings`                          | `201`  | requires verified owner and owned property |
| Expired listing save attempt     | `POST /listings/:listingId/save`          | `422`  | expired listings cannot be saved           |
| Status changed concurrently      | `PATCH /listings/:listingId/status`       | `409`  | caller should refresh                      |
| Photo upload request             | `POST /listings/:listingId/photos`        | `202`  | worker-based async processing              |
| Reorder omits some photos        | `PUT /listings/:listingId/photos/reorder` | `422`  | full active photo set required             |

## Integrator Notes

- `student_room` listings own their own location fields.
- `pg_room` and `hostel_bed` listings inherit location from the parent property.
- Photo uploads are not immediately visible after `202 Accepted`.
- Saved listings only return currently active, non-expired listings.
