# Appendix: Middleware Reference

Maps each middleware to every route that uses it, with its role in the chain.

---

## `authenticate` (`src/middleware/authenticate.js`)

Requires a valid access token. Sets `req.user`. Attempts silent refresh for expired cookie tokens only.

| Route                                              | Method |
| -------------------------------------------------- | ------ |
| `POST /auth/logout/current`                        | POST   |
| `POST /auth/logout/all`                            | POST   |
| `GET /auth/sessions`                               | GET    |
| `DELETE /auth/sessions/:sid`                       | DELETE |
| `POST /auth/otp/send`                              | POST   |
| `POST /auth/otp/verify`                            | POST   |
| `GET /auth/me`                                     | GET    |
| `POST /listings`                                   | POST   |
| `PUT /listings/:listingId`                         | PUT    |
| `DELETE /listings/:listingId`                      | DELETE |
| `PATCH /listings/:listingId/status`                | PATCH  |
| `GET /listings/:listingId/preferences`             | GET    |
| `PUT /listings/:listingId/preferences`             | PUT    |
| `POST /listings/:listingId/save`                   | POST   |
| `DELETE /listings/:listingId/save`                 | DELETE |
| `GET /listings/me/saved`                           | GET    |
| `GET /listings/:listingId/photos`                  | GET    |
| `POST /listings/:listingId/photos`                 | POST   |
| `DELETE /listings/:listingId/photos/:photoId`      | DELETE |
| `PATCH /listings/:listingId/photos/:photoId/cover` | PATCH  |
| `PUT /listings/:listingId/photos/reorder`          | PUT    |
| `POST /listings/:listingId/interests`              | POST   |
| `GET /listings/:listingId/interests`               | GET    |
| `GET /interests/me`                                | GET    |
| `GET /interests/:interestId`                       | GET    |
| `PATCH /interests/:interestId/status`              | PATCH  |
| `GET /connections/me`                              | GET    |
| `GET /connections/:connectionId`                   | GET    |
| `POST /connections/:connectionId/confirm`          | POST   |
| `GET /notifications`                               | GET    |
| `GET /notifications/unread-count`                  | GET    |
| `POST /notifications/mark-read`                    | POST   |
| `GET /students/:userId/profile`                    | GET    |
| `PUT /students/:userId/profile`                    | PUT    |
| `GET /students/:userId/preferences`                | GET    |
| `PUT /students/:userId/preferences`                | PUT    |
| `GET /pg-owners/:userId/profile`                   | GET    |
| `PUT /pg-owners/:userId/profile`                   | PUT    |
| `POST /pg-owners/:userId/documents`                | POST   |
| `GET /properties`                                  | GET    |
| `GET /properties/:propertyId`                      | GET    |
| `POST /properties`                                 | POST   |
| `PUT /properties/:propertyId`                      | PUT    |
| `DELETE /properties/:propertyId`                   | DELETE |
| `GET /ratings/me/given`                            | GET    |
| `GET /ratings/connection/:connectionId`            | GET    |
| `POST /ratings`                                    | POST   |
| `POST /ratings/:ratingId/report`                   | POST   |
| `GET /preferences/meta`                            | GET    |

---

## `optionalAuthenticate` (`src/middleware/optionalAuthenticate.js`)

Tries to set `req.user` if a valid token is present. Never returns 401. Any failure (expired, invalid, user
deleted/suspended) -> request continues as guest.

Token extraction order: cookie -> Authorization header (same as `authenticate`).

| Route                                    | Method |
| ---------------------------------------- | ------ |
| `GET /listings`                          | GET    |
| `GET /listings/:listingId`               | GET    |
| `GET /students/:userId/contact/reveal`   | GET    |
| `POST /pg-owners/:userId/contact/reveal` | POST   |

---

## `authorize(role)` (`src/middleware/authorize.js`)

Must run after `authenticate`. Checks `req.user.roles.includes(role)`. Returns `403 Forbidden` if role missing.

**Note:** `authorize()` validates the role argument at route registration time (startup), not per-request.
Misconfiguration throws at startup.

| Route                                 | Required Role |
| ------------------------------------- | ------------- |
| `GET /listings/me/saved`              | `student`     |
| `POST /listings/:listingId/save`      | `student`     |
| `DELETE /listings/:listingId/save`    | `student`     |
| `POST /listings/:listingId/interests` | `student`     |
| `GET /interests/me`                   | `student`     |
| `PUT /pg-owners/:userId/profile`      | `pg_owner`    |
| `POST /pg-owners/:userId/documents`   | `pg_owner`    |
| `GET /properties`                     | `pg_owner`    |
| `POST /properties`                    | `pg_owner`    |
| `PUT /properties/:propertyId`         | `pg_owner`    |
| `DELETE /properties/:propertyId`      | `pg_owner`    |

---

## `contactRevealGate` (`src/middleware/contactRevealGate.js`)

Must run after `optionalAuthenticate` and `validate`. Sets `req.contactReveal = { emailOnly, verified }`.

**Behavior:**

- Verified users (`req.user?.isEmailVerified === true`): passes through, sets `emailOnly: false` -> controller returns
  full bundle (email + phone)
- Guests/unverified: checks Redis counter `contactRevealAnon:{sha256(ip|ua)}`, then checks HttpOnly cookie
  `contactRevealAnonCount`
- If count >= 10: returns `429 CONTACT_REVEAL_LIMIT_REACHED` immediately
- Otherwise: installs a pre-response hook on `res.json`/`res.send`/`res.end` to increment quota after a successful 2xx
  response only
- Quota is incremented atomically via Lua script: `INCR key; if count==1 then EXPIRE key 30days`
- `Cache-Control: no-store` must be set on the response before this middleware runs (see route files)

| Route                                    | Method |
| ---------------------------------------- | ------ |
| `GET /students/:userId/contact/reveal`   | GET    |
| `POST /pg-owners/:userId/contact/reveal` | POST   |

---

## `guestListingGate` (`src/middleware/guestListingGate.js`)

Must run after `validate` (relies on Zod-coerced `req.query.limit` being a number).

**Behavior:**

- Authenticated (`req.user` set): no-op, passes through
- Guest: silently caps `req.query.limit` to `20` if the requested value exceeds `20`
- Does not block, does not count, does not touch Redis

| Route                      | Method |
| -------------------------- | ------ |
| `GET /listings`            | GET    |
| `GET /listings/:listingId` | GET    |

---

## `validate(schema)` (`src/middleware/validate.js`)

Runs Zod's `schema.safeParse({ body, query, params })`. On success, writes `result.data` back to `req.body`,
`req.params`, and `req.query` (using `Object.defineProperty` for query in Express 5 compatibility). On failure, passes
`ZodError` to `next(err)` -> global error handler.

Used on virtually every route. Not individually listed here — see per-endpoint docs for the schema name.

---

## `authLimiter` (`src/middleware/rateLimiter.js`)

10 requests / 15-minute window. Redis-backed (`rl:auth:{ip}`). `passOnStoreError: true` — degrades to no limiting if
Redis is down.

| Route                        | Method |
| ---------------------------- | ------ |
| `POST /auth/register`        | POST   |
| `POST /auth/login`           | POST   |
| `POST /auth/logout/all`      | POST   |
| `POST /auth/refresh`         | POST   |
| `GET /auth/sessions`         | GET    |
| `DELETE /auth/sessions/:sid` | DELETE |
| `POST /auth/google/callback` | POST   |

---

## `otpLimiter` (`src/middleware/rateLimiter.js`)

5 requests / 15-minute window. Redis-backed (`rl:otp:{ip}`). `passOnStoreError: true`.

| Route                 | Method |
| --------------------- | ------ |
| `POST /auth/otp/send` | POST   |

---

## `publicRatingsLimiter` (`src/middleware/rateLimiter.js`)

120 requests / 15-minute window. Redis-backed (`rl:ratings:public:{ip}`). `passOnStoreError: true`.

| Route                               | Method |
| ----------------------------------- | ------ |
| `GET /ratings/user/:userId`         | GET    |
| `GET /ratings/property/:propertyId` | GET    |

---

## `upload.single("photo")` (`src/middleware/upload.js`)

Multer disk storage. Writes to `uploads/staging/{uuid}.ext`. Validates MIME type and file extension cross-match. Limits:
10MB file size, 1 file per request.

| Route                              | Method |
| ---------------------------------- | ------ |
| `POST /listings/:listingId/photos` | POST   |
