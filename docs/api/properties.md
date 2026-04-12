# Properties API

Properties are the building-level records used by verified PG owners. Students cannot create or manage properties, but authenticated students can fetch property detail when viewing PG or hostel listings.

## `GET /properties`

Lists properties owned by the authenticated PG owner.

### Request Contract

- Auth required: Yes
- Role required: `pg_owner`
- Query params:
  - `limit`
  - `cursorTime`
  - `cursorId`

### Scenario: list own properties

Status: `200`

```json
{
  "status": "success",
  "data": {
    "items": [
      {
        "property_id": "44444444-4444-4444-8444-444444444444",
        "property_name": "Sunrise PG Viman Nagar",
        "property_type": "pg",
        "city": "Pune",
        "locality": "Viman Nagar",
        "status": "active",
        "average_rating": 4.5,
        "rating_count": 12,
        "created_at": "2026-04-01T08:00:00.000Z",
        "updated_at": "2026-04-05T08:00:00.000Z",
        "amenity_count": 8,
        "active_listing_count": 3
      }
    ],
    "nextCursor": null
  }
}
```

### Scenario: wrong role

Status: `403`

```json
{
  "status": "error",
  "message": "Forbidden"
}
```

## `POST /properties`

Creates a property for a verified PG owner.

### Request Body

```json
{
  "propertyName": "Sunrise PG Viman Nagar",
  "description": "Walking distance from Symbiosis and nearby tech parks.",
  "propertyType": "pg",
  "addressLine": "Lane 5, Viman Nagar",
  "city": "Pune",
  "locality": "Viman Nagar",
  "landmark": "Near Phoenix Marketcity",
  "pincode": "411014",
  "latitude": 18.5679,
  "longitude": 73.9143,
  "houseRules": "No smoking inside rooms.",
  "totalRooms": 22,
  "amenityIds": [
    "2db2f8fc-d90c-47a1-aebb-c6fa9ea4450a",
    "eec6f390-2906-4d50-bf26-4f937833c6f8"
  ]
}
```

### Scenario: verified PG owner creates property

Status: `201`

```json
{
  "status": "success",
  "data": {
    "property_id": "44444444-4444-4444-8444-444444444444",
    "owner_id": "22222222-2222-4222-8222-222222222222",
    "property_name": "Sunrise PG Viman Nagar",
    "description": "Walking distance from Symbiosis and nearby tech parks.",
    "property_type": "pg",
    "address_line": "Lane 5, Viman Nagar",
    "city": "Pune",
    "locality": "Viman Nagar",
    "landmark": "Near Phoenix Marketcity",
    "pincode": "411014",
    "latitude": 18.5679,
    "longitude": 73.9143,
    "house_rules": "No smoking inside rooms.",
    "total_rooms": 22,
    "status": "active",
    "average_rating": 0,
    "rating_count": 0,
    "amenities": [
      {
        "amenityId": "2db2f8fc-d90c-47a1-aebb-c6fa9ea4450a",
        "name": "Wi-Fi",
        "category": "connectivity",
        "iconName": "wifi"
      }
    ]
  }
}
```

### Scenario: create fails for non-`pg_owner`

Status: `403`

```json
{
  "status": "error",
  "message": "Forbidden"
}
```

### Scenario: create fails because owner is not verified

Status: `403`

```json
{
  "status": "error",
  "message": "PG owner must be verified to perform this action"
}
```

### Scenario: validation failure

Status: `400`

```json
{
  "status": "error",
  "message": "Validation failed",
  "errors": [
    {
      "field": "body.propertyName",
      "message": "Property name must be at least 2 characters"
    },
    {
      "field": "body.city",
      "message": "City is required"
    }
  ]
}
```

## `GET /properties/:propertyId`

Fetches a property detail record.

### Scenario: authenticated student views a property

Status: `200`

```json
{
  "status": "success",
  "data": {
    "property_id": "44444444-4444-4444-8444-444444444444",
    "owner_id": "22222222-2222-4222-8222-222222222222",
    "property_name": "Sunrise PG Viman Nagar",
    "description": "Walking distance from Symbiosis and nearby tech parks.",
    "property_type": "pg",
    "address_line": "Lane 5, Viman Nagar",
    "city": "Pune",
    "locality": "Viman Nagar",
    "landmark": "Near Phoenix Marketcity",
    "pincode": "411014",
    "latitude": 18.5679,
    "longitude": 73.9143,
    "house_rules": "No smoking inside rooms.",
    "total_rooms": 22,
    "status": "active",
    "average_rating": 4.5,
    "rating_count": 12,
    "created_at": "2026-04-01T08:00:00.000Z",
    "updated_at": "2026-04-05T08:00:00.000Z",
    "amenities": [
      {
        "amenityId": "2db2f8fc-d90c-47a1-aebb-c6fa9ea4450a",
        "name": "Wi-Fi",
        "category": "connectivity",
        "iconName": "wifi"
      }
    ]
  }
}
```

### Scenario: property not found

Status: `404`

```json
{
  "status": "error",
  "message": "Property not found"
}
```

## `PUT /properties/:propertyId`

Updates a property owned by the authenticated PG owner.

### Request Example

```json
{
  "description": "Now includes weekly room cleaning and breakfast.",
  "landmark": "Near Phoenix Marketcity main gate",
  "amenityIds": [
    "2db2f8fc-d90c-47a1-aebb-c6fa9ea4450a"
  ]
}
```

### Scenario: update succeeds

Status: `200`

```json
{
  "status": "success",
  "data": {
    "property_id": "44444444-4444-4444-8444-444444444444",
    "description": "Now includes weekly room cleaning and breakfast.",
    "landmark": "Near Phoenix Marketcity main gate"
  }
}
```

### Scenario: no valid fields provided

Status: `400`

```json
{
  "status": "error",
  "message": "No valid fields provided for update"
}
```

### Scenario: property not found or not owned

Status: `404`

```json
{
  "status": "error",
  "message": "Property not found"
}
```

## `DELETE /properties/:propertyId`

Soft-deletes a property when it no longer has active listings.

### Scenario: delete succeeds

Status: `200`

```json
{
  "status": "success",
  "data": {
    "propertyId": "44444444-4444-4444-8444-444444444444",
    "deleted": true
  }
}
```

### Scenario: delete blocked by active listings

Status: `409`

```json
{
  "status": "error",
  "message": "Deactivate or remove all active listings before deleting this property"
}
```

### Scenario: property not found

Status: `404`

```json
{
  "status": "error",
  "message": "Property not found"
}
```

## Integrator Notes

- The service requires the PG owner to be verified before create, update, or delete operations.
- If address or coordinate fields are changed on the property, the service cascades those location updates to linked `pg_room` and `hostel_bed` listings in the same transaction.
- Property reads are broader than writes: any authenticated user can fetch a property by ID.
