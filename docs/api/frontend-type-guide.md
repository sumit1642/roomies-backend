# Frontend Type Safety Guide (TypeScript + Zod)

This guide is for frontend teams generating/maintaining strong API types.

It complements endpoint docs by focusing on **type modeling decisions**:

- which fields are stable contract fields,
- where casing is mixed,
- where enums come from SQL schema,
- and where optional-auth / privacy behaviors affect client type unions.

## Source-of-truth order for frontend types

When in doubt, model from these layers in this order:

1. `src/routes/*` for mounted endpoint surface and auth middleware.
2. `src/validators/*` for request shape/requiredness.
3. `src/services/*` for response shape and business-rule branches.
4. `migrations/*.sql` for enum domains and persisted state values.

## Scalar contract conventions

- IDs are UUID strings.
- Timestamps are ISO strings in API responses.
- Money in API payloads is rupees (integer); DB stores paise.
- Pagination uses keyset cursors: `{ cursorTime: string, cursorId: string } | null`.

## Casing expectations

Most API response payloads are camelCase in docs.

Known exception to model explicitly:

- `GET /listings/me/saved` currently returns mixed casing (legacy snake_case SQL fields + camelCase money fields).

For TypeScript apps, prefer defining a dedicated DTO type for this endpoint instead of reusing generic `ListingCard`.

## SQL enum domains you should mirror in frontend types

These enums are defined in schema migrations and are useful as `z.enum([...])` or string-union TS types.

### Account / identity enums

- `account_status_enum`: `active | suspended | banned | deactivated`
- `role_enum`: `student | pg_owner | admin`
- `gender_enum`: `male | female | other | prefer_not_to_say`
- `verification_status_enum`: `unverified | pending | verified | rejected`

### Listing / property enums

- `listing_type_enum`: `student_room | pg_room | hostel_bed`
- `room_type_enum`: `single | double | triple | entire_flat`
- `bed_type_enum`: `single_bed | double_bed | bunk_bed`
- `listing_status_enum`: `active | filled | expired | deactivated`
- `property_type_enum`: `pg | hostel | shared_apartment`
- `property_status_enum`: `active | inactive | under_review`

### Trust / workflow enums

- `request_status_enum`: `pending | accepted | declined | withdrawn | expired`
- `confirmation_status_enum`: `pending | confirmed | denied | expired`
- `connection_type_enum`: `student_roommate | pg_stay | hostel_stay | visit_only`
- `reviewee_type_enum`: `user | property`
- `report_reason_enum`: `fake | abusive | conflict_of_interest | other`
- `report_status_enum`: `open | resolved_removed | resolved_kept`
- `document_type_enum`: `property_document | rental_agreement | owner_id | trade_license`
- `amenity_category_enum`: `utility | safety | comfort`

### Notification enums

- `notification_type_enum` initial values are defined in migration 001.
- Migration 002 adds `verification_pending`.

Frontend recommendation: treat notification `type` as a discriminated union that includes `verification_pending`, even
if UI behavior is currently email-only for that event.

## Optional-auth endpoints: model as unions

For endpoints with `optionalAuthenticate`, clients should not assume invalid tokens produce `401`.

Recommended modeling:

- Request can be made with or without token.
- Response may still be success guest-shape even if token is stale/invalid.
- Client state machine should support `authenticated-success` and `guest-success` for the same endpoint.

Primary affected endpoints:

- `GET /listings`
- `GET /listings/:listingId`
- `GET /students/:userId/contact/reveal`
- `POST /pg-owners/:userId/contact/reveal`

## Suggested frontend package structure

- `api/types/common.ts`
    - `UUID`, `ISODateTimeString`, `Cursor`
- `api/types/enums.ts`
    - all SQL-backed string unions / Zod enums
- `api/types/auth.ts`, `listings.ts`, `interests.ts`, ...
    - endpoint DTOs per feature
- `api/types/legacy.ts`
    - mixed-case DTOs (for transitional endpoints like saved listings)
- `api/zod/*`
    - runtime response parsers for high-risk endpoints

## High-value guardrails for TS + Zod teams

- Parse all cursor responses with Zod before writing pagination state.
- Keep endpoint-specific DTOs where response casing diverges.
- Use discriminated unions for privacy-preserving errors (`404` as not-found-or-not-allowed).
- Keep notification type unions synced with migrations when new enum labels are added.
