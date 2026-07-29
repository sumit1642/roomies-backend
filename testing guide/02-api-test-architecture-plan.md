# Roomies API Test Architecture Plan

**Stack:** Jest + Supertest, importing `src/app.js` directly (no real `listen()`, no real BullMQ workers/cron running —
`src/server.js` is never invoked). Docker-based Postgres+PostGIS / Redis, torn down after each run.

---

## 1. package.json changes

```jsonc
{
	"scripts": {
		"test": "npm run test:up && npm run test:migrate && npm run test:run; npm run test:down",
		"test:up": "docker compose -f docker-compose.test.yml up -d --wait",
		"test:down": "docker compose -f docker-compose.test.yml down -v",
		"test:migrate": "cross-env ENV_FILE=.env.test node src/db/migrate.js",
		"test:run": "cross-env ENV_FILE=.env.test NODE_OPTIONS=--experimental-vm-modules node_modules/.bin/jest --runInBand",
		"test:watch": "npm run test:run -- --watch",
	},
	"devDependencies": {
		"supertest": "^7.x",
		"cross-env": "^7.x",
	},
}
```

- `--runInBand`: test files share ONE Postgres instance, so they run serially rather than in parallel workers stomping
  on each other's rows.
- The trailing `; npm run test:down` (not `&&`) guarantees the containers get torn down even if tests fail — you never
  want a zombie test-db container eating your RAM after a red run.
- `cross-env` is optional if you're always on macOS/Linux/WSL/git-bash (your existing scripts already assume that), but
  cheap insurance if you ever run this on plain Windows cmd.

## 2. Directory structure

```
tests/
  setup/
    testDb.js       # resetDb() — truncates all app tables between tests
    testAuth.js     # registerUser(role) → { agent, user } using supertest agents
    jest.setup.js   # setupFilesAfterEnv — connects redis once per file, resetDb per test, closes everything in afterAll
  suites/
    00-health.test.js
    01-auth.test.js
    02-students.test.js
    03-roommate.test.js
    04-pgOwners.test.js
    05-verification.test.js
    06-properties.test.js
    07-listings-crud.test.js
    08-listings-search.test.js
    09-listings-photos.test.js
    10-listings-renewal-analytics.test.js
    11-interests.test.js
    12-connections.test.js
    13-ratings.test.js
    14-reports.test.js
    15-notifications.test.js
    16-savedSearches.test.js
    17-referenceData.test.js   # preferences meta, amenities, rent-index, pincodes
jest.config.js
```

Numeric prefixes aren't required for Jest (it doesn't guarantee file order across suites by default beyond alpha sort —
with `--runInBand` it _does_ run files in the order Jest discovers them, which is alphabetical), but they make the
intent ("run auth before things that need a logged-in user") legible to a human skimming the folder, and they match your
actual dependency chain: you can't test listings before auth works, can't test interests before listings work, etc.

## 3. `jest.config.js`

```js
export default {
	testEnvironment: "node",
	testTimeout: 15000, // DB round-trips + bcrypt hashing are slower than pure unit tests
	setupFilesAfterEnv: ["<rootDir>/tests/setup/jest.setup.js"],
	testMatch: ["**/tests/suites/**/*.test.js"],
};
```

**Important gotcha, worth understanding rather than just copying:** Jest gives each test _file_ its own fresh module
registry by default. That means `src/cache/client.js`'s `redis` export is a distinct, unconnected client instance every
time a new test file imports it — and `src/app.js` never calls `connectRedis()` itself (only `server.js` does, which
tests never run). So `jest.setup.js` has to call `connectRedis()` in a `beforeAll`, per file — not once globally via
`globalSetup`. Symmetrically, `globalTeardown` runs in its own isolated context that can't reach the connections your
actual test file opened, so closing `pool`/`redis` has to happen in that same file's `afterAll`, not in a separate
teardown script. `src/middleware/rateLimiter.js` also opens its _own_ independent redis client as an import-time side
effect (used by `authLimiter`/`otpLimiter`) — close that too via its exported `closeRateLimitRedisClient()`, or Jest
will hang on open handles after the last suite.

Your existing `src/db/seeds/pincodes.test.js` is a pure unit test with no DB — keep `testMatch` scoped to
`tests/suites/` so `npm run test` (integration) and a future `npm run test:unit` (this file + similar) stay separate
concerns.

## 4. Core test helpers

**`tests/setup/testDb.js`** — truncate-everything-except-migrations, called before every test:

```js
import { pool } from "../../src/db/client.js";

export const resetDb = async () => {
	const { rows } = await pool.query(
		`SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
	);
	const tables = rows.map((r) => `"${r.tablename}"`).join(", ");
	if (tables) await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
};
```

**`tests/setup/testAuth.js`** — real registration through the real endpoint (not a shortcut), returns a cookie-carrying
agent:

```js
import request from "supertest";
import { app } from "../../src/app.js";

export const registerUser = async ({ role = "student", ...overrides } = {}) => {
	const agent = request.agent(app);
	const email = overrides.email ?? `test.${Date.now()}.${Math.random().toString(36).slice(2)}@college.edu`;
	const body = {
		email,
		password: "TestPass123!",
		role,
		fullName: "Test User",
		...(role === "pg_owner" ? { businessName: "Test PG" } : {}),
		...overrides,
	};
	const res = await agent.post("/api/v1/auth/register").send(body);
	return { agent, user: res.body.data.user, email, password: body.password };
};
```

Note this deliberately exercises the **real** register → cookie → authenticate middleware chain instead of minting a JWT
by hand — that IS part of what "full endpoint coverage" should verify (cookie flags, `x-client-type` header behavior,
etc.), not a shortcut around it.

**`tests/setup/jest.setup.js`**:

```js
import { resetDb } from "./testDb.js";
beforeEach(resetDb);
```

**`tests/setup/globalTeardown.js`** — closes the pg pool / redis client so Jest exits cleanly instead of hanging on open
handles:

```js
export default async () => {
	const { pool } = await import("../../src/db/client.js");
	const { redis } = await import("../../src/cache/client.js");
	await pool.end().catch(() => {});
	if (redis.isOpen) await redis.quit().catch(() => {});
};
```

## 5. Handling the things that AREN'T pure request/response

| Concern                                                  | Approach                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BullMQ jobs** (notifications, email, media processing) | Since `src/server.js` never runs in tests, `startNotificationWorker()`/`startEmailWorker()`/`startMediaWorker()` never start. `enqueueNotification()`/`enqueueEmail()` still push real jobs to real BullMQ queues (Redis is real, from Docker) — assert on the **enqueue succeeding** (e.g. photo upload returns `202 { status: "processing" }`), not on the job's eventual side effect. |
| **Photo uploads**                                        | `listing_photos` rows stay in `processing:<id>` state (worker never runs) — test that the row exists with the right `displayOrder`/cap-of-5 enforcement, not that a final `photoUrl` appears.                                                                                                                                                                                            |
| **Google OAuth**                                         | `googleOAuth()` calls a real Google token-verification client — don't test this against the real network. Either skip it in the first pass (flag as a known gap) or stub `OAuth2Client.prototype.verifyIdToken` at the top of that one test file.                                                                                                                                        |
| **Cron jobs** (expiry, hard-delete, rent-index refresh)  | These are plain functions exported alongside their `register*Cron()` wrappers (e.g. `runListingExpiry`, `runSavedSearchAlert`) — call them directly in a test instead of waiting for `node-cron`'s schedule.                                                                                                                                                                             |
| **`contactRevealGate`'s Redis-backed rate limiting**     | Real Redis from Docker — this is actually testable end-to-end, unlike the BullMQ jobs above.                                                                                                                                                                                                                                                                                             |

## 6. Suite → endpoint coverage map (~70 endpoints across 18 suites)

| #   | Suite file                 | Endpoints covered                                                                                                           |
| --- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 00  | health                     | `GET /health`                                                                                                               |
| 01  | auth                       | register, login, logout (current/all), refresh, sessions (list/revoke), otp send/verify, `/me`, google callback (stubbed)   |
| 02  | students                   | profile get/put, photo put/delete, contact reveal, preferences get/put                                                      |
| 03  | roommate                   | feed, roommate-profile put, block/unblock                                                                                   |
| 04  | pgOwners                   | profile get/put, photo put/delete, contact reveal, documents submit                                                         |
| 05  | verification               | submit, queue (admin), approve, reject                                                                                      |
| 06  | properties                 | get, list, create, update, delete                                                                                           |
| 07  | listings-crud              | create, get, update, delete, status transitions                                                                             |
| 08  | listings-search            | search filters: city, rent range, room/bed type, gender, amenities, lat/lng, pincode, cursor pagination, compatibility sort |
| 09  | listings-photos            | upload (202), get, delete, set-cover, reorder, cap-of-5                                                                     |
| 10  | listings-renewal-analytics | renew, analytics, preferences get/put, save/unsave, saved listings                                                          |
| 11  | interests                  | create, get, accept/decline/withdraw, list-for-listing, list-mine                                                           |
| 12  | connections                | get, list-mine, confirm (both parties)                                                                                      |
| 13  | ratings                    | submit (user + property), get-for-connection, public ratings (user/property), given-by-me                                   |
| 14  | reports                    | submit, queue (admin), resolve                                                                                              |
| 15  | notifications              | feed, unread-count, mark-read                                                                                               |
| 16  | savedSearches              | create (incl. 10-cap trigger), list, update, delete                                                                         |
| 17  | referenceData              | preferences meta, amenities list, rent-index lookup, pincode lookup                                                         |

## 7. Recommended execution order for a single `npm run test`

Auth → Students/PgOwners/Verification → Properties → Listings (crud → search → photos → renewal) → Interests →
Connections → Ratings/Reports → Notifications → SavedSearches → Roommate → ReferenceData. Each later suite's fixtures
reuse `registerUser()`/listing-creation helpers from earlier ones, so this order also mirrors "what has to exist before
the next thing can be tested."

## 8. Given the ~70-endpoint scope, this is a genuinely large build

Writing all 18 suites by hand in one pass is a multi-day effort even with helpers in place. Two honest paths:

- **Incremental**: knock out suites 00–07 first (health through listings-crud) — that's the actual critical path — then
  keep going down the list. `npm run test` stays runnable the whole time; you just add files.
- **Delegate the mechanical part**: once the helpers above exist, generating the remaining suite files against a known
  route file is exactly the kind of repetitive, well-specified work that's a good fit for **Claude Code** running
  against this repo directly (it can read each route/validator/service file and write the matching supertest file)
  rather than doing it turn-by-turn in chat.

The tracker artifact tracks suite-by-suite progress either way.
