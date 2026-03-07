Let me think through this carefully and systematically before touching a single line of code. The goal is to reason from first principles, not just patch symptoms.

Let me read the codebase carefully before reasoning about anything.

The files are all in the conversation context. Let me do my full reasoning pass before writing anything.

---

## Deep Reasoning Pass — What's Actually Wrong

Let me work through every layer systematically: schema, service logic, API surface, and developer experience.

### Schema Analysis

The `connections` table is missing `interest_request_id`. Let me reason whether this actually matters. The plan references it but it was never added to the SQL. The question is: is this a real gap or acceptable?

The answer is it **is a real gap**. Here's why. Currently you can derive "which interest request created this connection" only by querying `WHERE sender_id = initiator_id AND listing_id = connections.listing_id AND status = 'accepted'`. But what if the same student expressed interest in the same listing twice (after a decline/withdrawal cycle)? The query becomes ambiguous — multiple rows match. The `interest_request_id` FK is the only way to have a deterministic, indexed link. Phase 4 ratings reference `connection_id`, and the audit trail needs to be complete. This should be added.

The `notifications` table has a `message` column (TEXT). But looking at the service code, **nothing ever populates it**. Every notification INSERT omits the message column entirely, meaning it stays NULL. The ImplementationPlan says messages are assembled at read-time from type templates. But the column exists and is unused. This is fine architecturally — the read-time assembly approach is correct — but the `message` column is now dead weight in writes. Not a schema bug, just worth noting.

The `notification_type_enum` is missing `interest_request_withdrawn`. This is a real bug — when a student withdraws, the code either fires the wrong type or needs to be suppressed. Since we're adding proper handling, we should add this enum value.

### Service Logic Analysis

**Bug 1: Wrong notification type on withdrawal.** Already identified. The `notificationType` ternary only handles `declined`, everything else gets `interest_request_received`. This is wrong and will confuse any frontend that filters notifications by type.

**Bug 2: `getMyInterestRequests` has a broken default for `limit`.** Look at the destructuring:
```js
const { status, cursorTime, cursorId, limit } = filters;
```
There's no default here. But the query later does `params.push(limit + 1)`. If `limit` is `undefined`, this becomes `NaN + 1 = NaN`, and PostgreSQL receives `NaN` as the LIMIT parameter, which will throw. The validator has `.default(20)` but that only runs if Zod processes the query. The service should not assume the caller always passes through the validator. **Fix: add a default in the destructure.**

**Bug 3: `getListingInterests` has the same problem** — `const { status, cursorTime, cursorId, limit = 20 } = filters;` — wait, this one actually has `limit = 20`. But `getMyInterestRequests` does not. Confirmed asymmetry — real bug.

**Bug 4: The `fetchInterestWithContext` query doesn't include `listing_type`.** But `_acceptInterestRequest` makes a second separate query to get `listing_type` for the `connectionType` derivation. This is an unnecessary extra round-trip on the most critical path in the entire phase. The listing type was available at the time of `fetchInterestWithContext` — the join to `listings` is already there. **Fix: add `l.listing_type` to the SELECT in `fetchInterestWithContext`, remove the second query in `_acceptInterestRequest`.**

**Bug 5: The `createInterestRequest` guard checks `expires_at > NOW()` but the listing status check and expiry check are separate concerns that can race.** A listing could be `active` but `expires_at` could be exactly `NOW()` between the check and the INSERT. This is fine — the partial unique index handles the integrity, and a listing expiring mid-request is an acceptable edge case. Not a fix needed.

**Bug 6: `toStudentInterestShape` references `row.listing_city`, `row.listing_locality` etc. but `getMyInterestRequests` selects `l.city AS listing_city`.** Let me verify this maps correctly... yes, the aliasing is there. Fine.

**Bug 7: The WhatsApp link builder strips non-digits and checks length >= 11 to detect a country code prefix.** But what if someone stored `919876543210` (12 digits, starts with 91)? The condition `digits.length >= 11` passes and uses it as-is, which is correct. What about `9876543210` (10 digits)? Prepends 91 to get `919876543210`. Correct. What about `+91 98765 43210` stored with spaces? The `replace(/\D/g, '')` strips spaces and `+`, leaving `919876543210` (12 digits), which passes the >= 11 check and is used as-is. This logic is actually correct.

**Bug 8: Post-commit notification in `_acceptInterestRequest` notifies `row.sender_id` — correct. But the notification for non-accepted transitions notifies `notifyUserId` which is derived as:**
```js
const notifyUserId = actorRole === "student" ? row.poster_id : row.sender_id;
```
When a student withdraws, notify the poster. When a poster declines, notify the sender. This logic is correct.

**Bug 9: `createInterestRequest` returns a shape that doesn't include `listingId`... wait, it does.** It returns `{ interestId, listingId, status, message, createdAt }`. Fine.

**Bug 10: The `connections` INSERT in `_acceptInterestRequest` doesn't include `interest_request_id` because that column doesn't exist in the schema.** We need to add this column to the schema and the INSERT.

**Bug 11: `updateInterestStatus` calls `fetchInterestWithContext` which joins to listings but `l.listing_type` is not selected.** Then `_acceptInterestRequest` does a second DB query for listing_type. This means the accepted path costs an extra round-trip inside a transaction. The transaction is open while a second query runs. Fix this by adding `l.listing_type` to `fetchInterestWithContext` and passing `row.listing_type` into `_acceptInterestRequest` so it can eliminate the second query.

### API Surface Issues

**Issue 1: There is no `GET /api/v1/interests/:interestId` endpoint.** A frontend developer building the UI for a specific interest request detail has no single-resource endpoint. After a student sends an interest, they get back the `interestId`. If they want to re-fetch that specific request (e.g. to check if status changed), they have to page through `GET /interests/me` and find it. This is a real frontend DX gap.

**Issue 2: The response from `PATCH /interests/:interestId/status` for non-accepted transitions doesn't return the full interest shape.** It returns only `{ interestId, listingId, status, updatedAt }`. Compare this to the accepted transition which returns `{ interestId, listingId, status, connectionId, whatsappLink, updatedAt }`. The declined/withdrawn response is too thin — the frontend needs to update its UI state and a sparse response forces a refetch.

**Issue 3: `createInterestRequest` response is also thin** — `{ interestId, listingId, status, message, createdAt }`. No listing title, no poster info. A frontend showing "your interest was sent" needs at minimum the listing title to display a meaningful confirmation. However, this is arguable — the frontend likely already has the listing detail in state when sending the interest. I'll leave this as a non-fix.

### Frontend Developer Experience

The `nextCursor` object returns `cursorTime` as an ISO string. When a frontend developer passes this back, Zod validates `cursorTime` as `z.string().optional()` — no format check. This is intentional (lenient) but means a malformed cursor silently fails at the database level. Not worth adding format validation here — the cursor is opaque and round-trips correctly.

---

## Decisions

**Schema changes needed:**
1. Add `interest_request_id UUID REFERENCES interest_requests(request_id) ON DELETE SET NULL` to `connections` table.
2. Add `interest_request_withdrawn` to `notification_type_enum`.

**Service fixes needed:**
1. Add `l.listing_type` to `fetchInterestWithContext`, remove second query in `_acceptInterestRequest`, pass `row.listing_type` through.
2. Fix notification type logic — proper handling for `withdrawn`, `declined`, and `accepted`.
3. Fix `limit` default in `getMyInterestRequests`.
4. Add `interest_request_id` to the connections INSERT.

**API additions needed:**
1. Add `GET /api/v1/interests/:interestId` — single interest request detail.

**Route/validator additions needed:**
1. Add schema for the new GET endpoint.
2. Add controller handler.

Now I write everything. No patches — these are clean, final implementations.

Now let me write all the fixes. Starting with the schema additions, then the service, then routes/validators/controller.

Now the service — the most important file:

Now the validators (adding the new GET endpoint schema):

Now the controller with the new endpoint:

Now the router — the most precise change, adding the new GET route in the correct position:

Now let me present all the files cleanly:

Here's a complete summary of every decision made, with the reasoning that drove it.

---

## What Was Fixed and Why

**Schema: `interest_request_id` on `connections`** is a genuine data integrity gap, not just a nice-to-have. The migration adds it as a nullable FK with `ON DELETE SET NULL`. The nullable choice is principled — admin-created connections have no originating request, and any connections that already exist before migration naturally land with `NULL`. The `ON DELETE SET NULL` behaviour is also correct: if the Phase 5 cleanup cron hard-deletes old `interest_requests` rows, the connection (which is the Phase 4 trust anchor for ratings) must survive. Destroying a connection because a 90-day-old interest request was cleaned up would be catastrophic. The partial index `WHERE interest_request_id IS NOT NULL` keeps it small — NULL rows don't benefit from an index and would just waste space.

**Schema: `interest_request_withdrawn` enum value** was missing from `notification_type_enum`. This is a straightforward gap. `ALTER TYPE ... ADD VALUE IF NOT EXISTS` is safe to run on a live database. The `IF NOT EXISTS` makes it idempotent.

**Service: `listing_type` in `fetchInterestWithContext`** eliminates the second query that `_acceptInterestRequest` was making inside its transaction. The old code opened a transaction, then ran `SELECT listing_type FROM listings WHERE listing_id = $1` before doing anything else. Since the listings JOIN was already happening in `fetchInterestWithContext`, adding one column to that SELECT costs zero extra IO and removes an entire round-trip on the most performance-critical path in this phase. The fix is architectural — it's the right place for the data, not a shortcut.

**Service: `limit` default in `getMyInterestRequests`** was genuinely missing. `getListingInterests` had `const { ..., limit = 20 } = filters` — with a default. `getMyInterestRequests` had `const { ..., limit } = filters` — without one. If anything ever calls the service function directly (tests, internal callers, a future admin tool), `limit` would be `undefined`, the query would receive `NaN` as the LIMIT parameter, and PostgreSQL would throw. The fix adds the default in the destructure for the same reason it should always be there: the service layer must be safe to call without routing through the HTTP validator.

**Service: `TRANSITION_NOTIFICATION_TYPE` map** replaces the ternary that was silently firing `interest_request_received` for withdrawals. The map approach is better than a chain of conditionals for a specific reason: a missing key in the map produces `undefined`, which the `if (notificationType)` guard catches and logs as a warning — making the gap immediately visible in monitoring. A conditional chain with an `else` branch would silently fire the wrong type. The `logger.warn` on an unmapped transition is the safety net for any future state added to the machine without a corresponding notification type.

**API: `GET /api/v1/interests/:interestId`** is a real frontend developer experience gap. After a student creates an interest request, they receive an `interestId`. Without a single-resource endpoint, the only way to later fetch that specific request is to page through the entire `GET /interests/me` feed. The access control is enforced in the service query itself — the `WHERE ... AND (ir.sender_id = $2 OR l.posted_by = $2)` clause means only the two parties get a result row; anyone else gets `null`, which the service turns into a 404. This is the correct pattern — 403 would confirm that the resource exists.

**Validators: `message` field added to `createInterestSchema`** — the body was previously validated as having no fields at all (`z.object({})`), which meant a `message` field sent by the client would be stripped by Zod and arrive at the controller as `undefined`. The service was already handling the message correctly via `req.body?.message`, but the validator was silently discarding it. Now the schema makes the optional message field explicit and allows it to reach the service.

**Route order in `interest.routes.js`** is documented explicitly because it's a non-obvious correctness requirement. `/me` must be registered before `/:interestId`. The comment explains the consequence of getting it wrong — a GET to `/me` would match `/:interestId` with `interestId = "me"`, fail UUID validation, and return 400 instead of the dashboard response.