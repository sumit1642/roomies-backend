# Authentication & Authorization Matrix

Shared conventions: [conventions.md](./conventions.md)

This page is the **single auth/authz reference** for the mounted API surface in this workspace. It documents both:

1. **Route-level enforcement** (middleware in `src/routes/*`), and
2. **Service-level enforcement** (ownership, party checks, verification checks, privacy-preserving 404 behavior).

> Source of truth order: `src/routes/*` → `src/validators/*` → `src/services/*`.

## Auth legend

- **Public**: no token required.
- **Optional auth**: token optional; behavior changes when authenticated.
- **Authenticated**: valid access token required.
- **Role gate**: `authorize("role")` middleware.
- **Service gate**: authorization enforced inside service query logic/business rules.

---

## Optional-authenticate exception semantics

For routes using `optionalAuthenticate`, token handling is intentionally non-blocking:

- If no token is sent, request continues as guest.
- If token is malformed/expired/invalid, request still continues as guest (no `401` from this middleware).
- If token is valid but user is missing/inactive, request still continues as guest.
- Only a valid active user token populates `req.user`.

This behavior affects:

- `GET /listings`
- `GET /listings/:listingId`
- `GET /students/:userId/contact/reveal`
- `POST /pg-owners/:userId/contact/reveal`

## Route exceptions and special-case behaviors

These are intentional exceptions to common auth patterns and should be handled explicitly by clients:

- `POST /auth/logout` is public by design (refresh-token revocation should still work when access token is expired).
- `GET /listings` and `GET /listings/:listingId` allow guest access via optional auth.
- `GET /listings/:listingId/photos` requires auth even though listing detail is public.
- `contactRevealGate` endpoints are optional-auth but quota-gated for guest/unverified users; verified users are
  unlimited.
- Contact reveal quota is charged only on successful 2xx responses.
- `/admin/*` docs exist but routes are not mounted in this workspace.
- `/test-utils/*` mounts only when `NODE_ENV !== "production"`.

---

## Auth routes (`/auth`)

| Endpoint                     | Route-level auth | Service-level auth/authorization notes                                                   |
| ---------------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| `POST /auth/register`        | Public           | Registration role validation in service (`student` / `pg_owner`).                        |
| `POST /auth/login`           | Public           | Credential + account-state validation in service.                                        |
| `POST /auth/refresh`         | Public           | Refresh token required (body or cookie), token/session validity enforced in service.     |
| `POST /auth/logout`          | Public           | Intentionally public so expired access-token clients can still revoke via refresh token. |
| `POST /auth/logout/current`  | Authenticated    | Refresh token must belong to current authenticated user/session.                         |
| `POST /auth/logout/all`      | Authenticated    | Revokes all sessions for authenticated user only.                                        |
| `GET /auth/sessions`         | Authenticated    | Lists sessions for authenticated user only.                                              |
| `DELETE /auth/sessions/:sid` | Authenticated    | Revokes only sessions belonging to authenticated user.                                   |
| `POST /auth/otp/send`        | Authenticated    | OTP issued only for authenticated user account.                                          |
| `POST /auth/otp/verify`      | Authenticated    | OTP verification + attempt throttling bound to authenticated user.                       |
| `GET /auth/me`               | Authenticated    | Returns authenticated user profile envelope.                                             |
| `POST /auth/google/callback` | Public           | Service handles login/register flow based on Google identity + optional role.            |

---

## Listings routes (`/listings`)

| Endpoint                                           | Route-level auth               | Service-level auth/authorization notes                                                                 |
| -------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `GET /listings`                                    | Optional auth                  | Guest users are capped by `guestListingGate`; compatibility fields require auth + preferences context. |
| `GET /listings/:listingId`                         | Optional auth                  | Public read; service increments view count asynchronously.                                             |
| `POST /listings`                                   | Authenticated                  | Listing type allowed by caller role (`student_room` vs PG-owner-only types).                           |
| `PUT /listings/:listingId`                         | Authenticated                  | Ownership and listing-type/location constraints enforced in service.                                   |
| `DELETE /listings/:listingId`                      | Authenticated                  | Owner-only soft delete in service.                                                                     |
| `PATCH /listings/:listingId/status`                | Authenticated                  | Owner-only + transition rules enforced in service.                                                     |
| `GET /listings/:listingId/preferences`             | Authenticated                  | Read requires authenticated caller; listing existence checks in service.                               |
| `PUT /listings/:listingId/preferences`             | Authenticated                  | Owner-only update behavior in service.                                                                 |
| `POST /listings/:listingId/save`                   | Authenticated + role `student` | Student-only save behavior; listing state checks in service.                                           |
| `DELETE /listings/:listingId/save`                 | Authenticated + role `student` | Student-only unsave behavior.                                                                          |
| `GET /listings/me/saved`                           | Authenticated + role `student` | Student-only saved feed for caller identity.                                                           |
| `GET /listings/:listingId/photos`                  | Authenticated                  | Read requires auth (not public listing parity).                                                        |
| `POST /listings/:listingId/photos`                 | Authenticated                  | Ownership enforced in photo service.                                                                   |
| `DELETE /listings/:listingId/photos/:photoId`      | Authenticated                  | Ownership + photo existence enforced in photo service.                                                 |
| `PATCH /listings/:listingId/photos/:photoId/cover` | Authenticated                  | Ownership + non-processing photo checks enforced in photo service.                                     |
| `PUT /listings/:listingId/photos/reorder`          | Authenticated                  | Ownership + full-set reorder invariants enforced in photo service.                                     |
| `POST /listings/:listingId/interests`              | Authenticated + role `student` | Student cannot interest own listing; duplicate/state gates in service.                                 |
| `GET /listings/:listingId/interests`               | Authenticated                  | Service enforces listing ownership (`403`) vs not found (`404`).                                       |

---

## Interests routes (`/interests`)

| Endpoint                              | Route-level auth               | Service-level auth/authorization notes                                                              |
| ------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `GET /interests/me`                   | Authenticated + role `student` | Sender dashboard only.                                                                              |
| `GET /interests/:interestId`          | Authenticated                  | Sender/poster party check in service; outsiders receive privacy-preserving `404`.                   |
| `PATCH /interests/:interestId/status` | Authenticated                  | Party-only transitions in service (poster accept/decline, student withdraw). Non-parties get `404`. |

---

## Connections routes (`/connections`)

| Endpoint                                  | Route-level auth | Service-level auth/authorization notes                                           |
| ----------------------------------------- | ---------------- | -------------------------------------------------------------------------------- |
| `GET /connections/me`                     | Authenticated    | Feed scoped to caller as initiator or counterpart.                               |
| `GET /connections/:connectionId`          | Authenticated    | Party-only access in service; outsiders receive `404`.                           |
| `POST /connections/:connectionId/confirm` | Authenticated    | Party-only confirmation; service determines caller side and transition validity. |

---

## Notifications routes (`/notifications`)

| Endpoint                          | Route-level auth | Service-level auth/authorization notes            |
| --------------------------------- | ---------------- | ------------------------------------------------- |
| `GET /notifications`              | Authenticated    | Feed is always scoped to authenticated recipient. |
| `GET /notifications/unread-count` | Authenticated    | Count is scoped to authenticated recipient.       |
| `POST /notifications/mark-read`   | Authenticated    | Updates only caller-owned notification rows.      |

---

## Preferences routes (`/preferences`)

| Endpoint                | Route-level auth | Service-level auth/authorization notes                           |
| ----------------------- | ---------------- | ---------------------------------------------------------------- |
| `GET /preferences/meta` | Authenticated    | Metadata read requires authentication in current implementation. |

---

## Student routes (`/students`)

| Endpoint                               | Route-level auth                    | Service-level auth/authorization notes                                  |
| -------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `GET /students/:userId/profile`        | Authenticated                       | Own profile includes private fields; others receive redacted fields.    |
| `PUT /students/:userId/profile`        | Authenticated                       | Caller can update only own profile (`403` otherwise).                   |
| `GET /students/:userId/contact/reveal` | Optional auth + `contactRevealGate` | Gate controls guest/unverified quotas and verified full-contact access. |
| `GET /students/:userId/preferences`    | Authenticated                       | Caller/target checks enforced in service contract.                      |
| `PUT /students/:userId/preferences`    | Authenticated                       | Caller/target checks enforced in service contract.                      |

---

## PG owner routes (`/pg-owners`)

| Endpoint                                 | Route-level auth                    | Service-level auth/authorization notes                                                         |
| ---------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET /pg-owners/:userId/profile`         | Authenticated                       | Read available to authenticated users; private fields behavior in service.                     |
| `POST /pg-owners/:userId/contact/reveal` | Optional auth + `contactRevealGate` | Gate controls quota + full-contact eligibility; `Cache-Control: no-store` applied.             |
| `PUT /pg-owners/:userId/profile`         | Authenticated + role `pg_owner`     | Owner profile update limited to authenticated PG owner identity.                               |
| `POST /pg-owners/:userId/documents`      | Authenticated + role `pg_owner`     | Verification submission restricted to own PG owner account; service enforces lifecycle checks. |

---

## Property routes (`/properties`)

| Endpoint                         | Route-level auth                | Service-level auth/authorization notes                            |
| -------------------------------- | ------------------------------- | ----------------------------------------------------------------- |
| `GET /properties/:propertyId`    | Authenticated                   | Any authenticated user may view detail; not ownership-restricted. |
| `GET /properties`                | Authenticated + role `pg_owner` | Owner management feed; verification/ownership checks in service.  |
| `POST /properties`               | Authenticated + role `pg_owner` | Verified PG owner required in service.                            |
| `PUT /properties/:propertyId`    | Authenticated + role `pg_owner` | Owner-only modification enforced in service.                      |
| `DELETE /properties/:propertyId` | Authenticated + role `pg_owner` | Owner-only delete enforced in service.                            |

---

## Ratings routes (`/ratings`)

| Endpoint                                | Route-level auth      | Service-level auth/authorization notes                                     |
| --------------------------------------- | --------------------- | -------------------------------------------------------------------------- |
| `GET /ratings/me/given`                 | Authenticated         | Caller-scoped given-ratings feed.                                          |
| `GET /ratings/user/:userId`             | Public (rate-limited) | Public profile reputation read.                                            |
| `GET /ratings/property/:propertyId`     | Public (rate-limited) | Public property reputation read.                                           |
| `GET /ratings/connection/:connectionId` | Authenticated         | Party checks in service (`404` privacy-preserving for outsiders).          |
| `POST /ratings`                         | Authenticated         | Service enforces connection status + party rules + duplicate constraints.  |
| `POST /ratings/:ratingId/report`        | Authenticated         | Service enforces reporter party membership and duplicate-open-report rule. |

---

## Health route (`/health`)

| Endpoint      | Route-level auth | Service-level auth/authorization notes               |
| ------------- | ---------------- | ---------------------------------------------------- |
| `GET /health` | Public           | No auth required; operational dependency probe only. |

---
