# Tier 0 Deployment Guide — Roomies Backend

## Render (Singapore) + Neon + Upstash + Azure Blob + Brevo API

> **Status:** Your production starting point. Everything here is free or always-free. **Audience:** Step-by-step for
> someone who has never used any of these services before. **Backend URL:** `https://api.roomies.sumitly.app` **Last
> verified:** April 2026.

> **Live API base URL:** `https://roomies-api.onrender.com/api/v1`
>
> **Live health check:** `https://roomies-api.onrender.com/api/v1/health`

> **Operational note:** the checked-in `.env.render` currently mirrors deployed values and includes `TRUST_PROXY=false`.
> For Render this is a misconfiguration. Set `TRUST_PROXY=1` in the Render dashboard.

---

## Read This First — What You're Actually Doing

Before touching any dashboard, understand the big picture. You are deploying one Node.js process on Render's free tier.
That process connects to four external services: a PostgreSQL database (Neon), a Redis cache (Upstash), a file storage
bucket (Azure Blob), and an email provider (Brevo). The code for all of this already exists. Your job is to create
accounts, collect connection strings, point them at each other, and then connect your domain.

**One critical fact about Render's free tier you must know:** In September 2025, Render blocked outbound SMTP traffic
(ports 25, 465, 587) on all free services. Your current email code uses Nodemailer with SMTP, which means emails will
fail silently on the free tier. The fix is to add a new email provider option that uses Brevo's HTTP REST API (port 443,
never blocked). This is a small but required code change covered in Phase 1 below.

**One more fact about cold starts:** Render's free tier sleeps your service after 15 minutes of no traffic. The first
request after sleep takes about one minute to respond — Render shows a loading page to the user during this time. This
is the core trade-off of the free tier. It is acceptable for a low-traffic app and acceptable for early users who
understand they're on a new platform. When it becomes unacceptable (users complaining, losing signups), the upgrade path
is in tier1.md.

---

## Phase 0 — Accounts to Create Before Anything Else

You need five accounts. All are free. None require a credit card except Azure (which you already have).

**Render** — [render.com](https://render.com) Sign up with GitHub. This is important: use the same GitHub account that
owns your repository. Render connects to GitHub to deploy your code automatically.

**Neon** — [neon.tech](https://neon.tech) Sign up with GitHub or email. No credit card needed.

**Upstash** — [upstash.com](https://upstash.com) Sign up with GitHub or email. No credit card needed for the free tier.

**Azure** — You already have this at [portal.azure.com](https://portal.azure.com) with your student credits. You only
need it for Blob Storage, which uses the always-free 5 GB tier.

**Brevo** — [brevo.com](https://brevo.com) You already have this configured locally. You just need to find your API key
(the `xkeysib-` one), not the SMTP key.

---

## Phase 1 — Required Code Changes

These changes must be made to your codebase before you deploy. Without them, emails will not work on Render's free tier.

### 1.1 Update `src/config/env.js`

Find the `EMAIL_PROVIDER` line in the `envSchema` object. Change it to include `brevo-api` as a valid option:

```javascript
// Find this line:
EMAIL_PROVIDER: z.enum(["ethereal", "brevo"], { ... }).default("ethereal"),

// Change it to:
EMAIL_PROVIDER: z.enum(["ethereal", "brevo", "brevo-api"], {
  error: 'EMAIL_PROVIDER must be "ethereal", "brevo", or "brevo-api"',
}).default("ethereal"),
```

Then add `BREVO_API_KEY` to the schema (add it near the other Brevo vars):

```javascript
// Add after BREVO_SMTP_FROM:
BREVO_API_KEY: z.string().min(1).optional(),
```

Then add a cross-field guard for `brevo-api` after the existing Brevo guard block:

```javascript
// Add this block after the existing brevo guard:
if (parsed.data.EMAIL_PROVIDER === "brevo-api") {
	const missing = [];
	if (!parsed.data.BREVO_API_KEY) missing.push("BREVO_API_KEY");
	if (!parsed.data.BREVO_SMTP_FROM) missing.push("BREVO_SMTP_FROM");
	if (missing.length > 0) {
		console.error(
			`❌  EMAIL_PROVIDER is "brevo-api" but these required variables are missing:\n` +
				missing.map((v) => `   ${v}`).join("\n") +
				`\n\nBREVO_API_KEY starts with "xkeysib-". Find it in Brevo → Settings → SMTP & API → API Keys.\n`,
		);
		process.exit(1);
	}
	if (parsed.data.BREVO_API_KEY?.startsWith("xsmtpsib-")) {
		console.error(
			`❌  BREVO_API_KEY starts with "xsmtpsib-" which is an SMTP key, not an API key.\n` +
				`   The API key starts with "xkeysib-". Find it in Brevo → Settings → SMTP & API → API Keys.\n`,
		);
		process.exit(1);
	}
}
```

### 1.2 Update `src/services/email.service.js`

Add a new `sendViaBrevoAPI` helper function. This uses Node.js's built-in `fetch` (available since Node 18, you're on
Node 22) — no new npm packages needed. Add this function anywhere in the file before it is used:

```javascript
// Brevo REST API transport — used when EMAIL_PROVIDER=brevo-api.
// Uses HTTPS (port 443), which is never blocked, unlike SMTP ports.
// Brevo API docs: https://developers.brevo.com/reference/send-transac-email
const sendViaBrevoAPI = async (to, subject, html, text) => {
	const maskedTo = maskEmail(to);
	logger.info({ to: maskedTo, provider: "brevo-api" }, "Sending email via Brevo REST API");

	const response = await fetch("https://api.brevo.com/v3/smtp/email", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"api-key": config.BREVO_API_KEY,
		},
		body: JSON.stringify({
			sender: { name: "Roomies", email: config.BREVO_SMTP_FROM },
			to: [{ email: to }],
			subject,
			htmlContent: html,
			textContent: text,
		}),
	});

	if (!response.ok) {
		const errorBody = await response.json().catch(() => ({}));
		logger.error({ to: maskedTo, status: response.status, error: errorBody }, "Brevo API: email send failed");
		throw new AppError("Failed to send email via Brevo API — try again shortly", 502);
	}

	const result = await response.json();
	logger.info({ to: maskedTo, messageId: result.messageId }, "Brevo API: email sent successfully");
	return result.messageId;
};
```

Now update `sendOtpEmail` to route to this new function when `EMAIL_PROVIDER=brevo-api`. Find the `try` block inside
`sendOtpEmail` and add the routing logic at the top:

```javascript
export const sendOtpEmail = async (to, otp) => {
  // ... existing input validation guards stay as-is ...

  // Route to Brevo REST API when SMTP is not available (e.g. Render free tier).
  if (config.EMAIL_PROVIDER === "brevo-api") {
    return sendViaBrevoAPI(
      to,
      "Your Roomies verification code",
      /* html — reuse the same HTML string from below */
      buildOtpHtml(otp),
      `Your Roomies verification code is: ${otp}\n\nThis code expires in 10 minutes.`,
    );
  }

  // ... rest of the existing function with Nodemailer transport ...
```

To avoid duplicating the HTML, extract it into a helper:

```javascript
// Add this helper above sendOtpEmail:
const buildOtpHtml = (otp) => `
<!DOCTYPE html>
<!-- ... copy the existing HTML template from inside sendOtpEmail ... -->
`;
```

Then replace the literal HTML string inside `sendOtpEmail` with `buildOtpHtml(otp)`.

Do the same routing for `sendVerificationApprovedEmail`, `sendVerificationRejectedEmail`, and
`sendVerificationPendingEmail` — each needs an early-return branch for `brevo-api` that calls `sendViaBrevoAPI` with the
appropriate subject, HTML, and text content. The HTML for each already exists in the file; just move it to a
`buildVerificationApprovedHtml(ownerName, businessName)` style helper and call `sendViaBrevoAPI` when the provider is
`brevo-api`.

### 1.3 Update `package.json`

Remove the migration scripts (you run migrations directly with psql, not through npm) and add a `dev:render` script for
local testing against your live Tier 0 services:

```json
{
	"scripts": {
		"dev": "nodemon src/server.js",
		"dev:azure": "ENV_FILE=.env.azure nodemon src/server.js",
		"dev:render": "ENV_FILE=.env.render nodemon src/server.js",
		"start": "node src/server.js",
		"start:azure": "ENV_FILE=.env.azure node src/server.js",
		"seed:amenities": "ENV_FILE=.env.local node src/db/seeds/amenities.js",
		"test": "node --experimental-vm-modules node_modules/.bin/jest"
	}
}
```

The five lines removed are: `migrate`, `migrate:azure`, `migrate:status`, `migrate:status:azure`, and `migrate:dry-run`.
The file `src/db/migrate.js` stays — it can still be run directly with `node src/db/migrate.js` if you ever need it.

### 1.4 Update `.gitignore`

Make sure `.env.render` is listed so you never accidentally commit it:

```
# Environment files — never commit
.env
.env.local
.env.azure
.env.render
.env.*.local
```

Commit all of these changes to your `main` branch before proceeding. Render will deploy from `main`, so the code must be
there.

---

## Phase 2 — Neon PostgreSQL Setup

Neon is a serverless PostgreSQL service. "Serverless" means the compute (CPU that processes queries) shuts down when no
queries have arrived for a few minutes and starts back up when one does. The data itself is always stored safely. This
cold-start for the database adds about 300–500ms to your first query after idle. During active use (queries coming in
every few seconds from BullMQ workers), Neon stays warm.

### 2.1 Create Your Neon Project

Go to [console.neon.tech](https://console.neon.tech) and sign in.

Click **New Project** in the top-right corner. Fill in:

- **Project name:** `roomies`
- **Postgres version:** select **16** from the dropdown (your schema requires 16)
- **Region:** Select **AWS Asia Pacific (Singapore)** — this is the closest AWS region to India and matches your Render
  region, which minimises latency between your app and your database.
- **Database name:** leave as `neondb` (you can rename it, but keeping the default is simpler)

Click **Create Project**. Neon will show you a connection string immediately. **Copy it and store it somewhere safe** —
you will need it multiple times.

The connection string looks like this:

```
postgresql://neondb_owner:SOME_LONG_PASSWORD@ep-SOMETHING-12345678.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
```

Everything in this string matters. Do not modify it.

### 2.2 Enable PostGIS and pgcrypto

Your schema requires two PostgreSQL extensions: `postgis` (for proximity search based on latitude/longitude) and
`pgcrypto` (for generating UUIDs as primary keys). You need to enable them before running the schema.

In the Neon dashboard, click on your project → click **SQL Editor** in the left sidebar.

Run these two commands one at a time (you can paste both at once and click Run):

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

You should see `CREATE EXTENSION` in the result. Verify they worked:

```sql
SELECT name, installed_version
FROM pg_extension
WHERE name IN ('postgis', 'pgcrypto');
```

You should see two rows. If you see `postgis` with a version like `3.5.2`, you are ready. Also verify spatial functions
work:

```sql
SELECT ST_AsText(ST_MakePoint(77.21, 28.63));
-- Should return: POINT(77.21 28.63)
```

### 2.3 Run Your Schema Migrations

On your local machine, open your terminal inside your project directory. You will connect to the Neon database and run
your SQL migration files. You need `psql` installed — check with `psql --version`. If not installed:
`sudo apt install postgresql-client`.

Set your Neon connection string as a temporary environment variable to avoid typing it repeatedly:

```bash
export NEON_URL="postgresql://neondb_owner:YOUR_PASSWORD@ep-YOUR-ENDPOINT.ap-southeast-1.aws.neon.tech/neondb?sslmode=require"
```

Replace the entire string with your actual connection string from step 2.1.

Now run the migrations in order:

```bash
# Migration 1: initial schema (creates all tables, indexes, triggers)
psql "$NEON_URL" -f migrations/001_initial_schema.sql

# Watch the output. You should see lines like:
# CREATE TABLE
# CREATE INDEX
# CREATE TRIGGER
# If you see any ERROR lines, stop and fix them before proceeding.

# Migration 2: verification event outbox (CDC pipeline for email notifications)
psql "$NEON_URL" -f migrations/002_verification_event_outbox.sql
```

If both succeed without errors, verify the tables were created:

```bash
psql "$NEON_URL" -c "\dt"
# Should list all your tables: users, student_profiles, listings, etc.
```

### 2.4 Seed Amenities

You need to seed the amenities table before the app can create listings. First, create a temporary `.env.render` file
(you'll fill it out fully in Phase 7, but for the seed you just need the DB URL). Create the file with just this line to
test:

```bash
# Temporary - just enough for the seed
echo "DATABASE_URL=$NEON_URL" > .env.render.tmp
ENV_FILE=.env.render.tmp node src/db/seeds/amenities.js
rm .env.render.tmp
```

You should see `Amenity seed complete` with `inserted: 19` in the output.

---

## Phase 3 — Upstash Redis Setup

Upstash provides managed Redis with a simple HTTP-over-TLS interface. Your existing `bullConnection.js` and
`cache/client.js` already handle `rediss://` TLS URLs, so no code changes are needed.

### 3.1 Create Your Redis Database

Go to [console.upstash.com](https://console.upstash.com) and sign in.

Click **Create database**. Fill in:

- **Name:** `roomies-redis`
- **Type:** **Regional** (not Global — you don't need multi-region replication at this stage)
- **Region:** **AWS ap-southeast-1 (Singapore)** — same region as Neon and Render, so all three services communicate
  within the same data centre
- **Plan:** **Free** — start here
- **Enable TLS:** leave **On** (required — your code uses `rediss://` which requires TLS)

Click **Create**. The database will be ready in about 30 seconds.

### 3.2 Get the Redis URL

On your database overview page, find the **REST API** section. But you don't want the REST URL — you want the Redis URL
for the standard Redis protocol. Look for:

- **Endpoint:** something like `definite-robin-12345.upstash.io`
- **Port:** `6379` (TLS connection with `rediss://`)
- **Password:** a long random string

Construct your `REDIS_URL` like this:

```
rediss://default:YOUR_UPSTASH_PASSWORD@YOUR-ENDPOINT.upstash.io:6379
```

Note the double `s` in `rediss://` — this signals TLS. The username is always `default` for Upstash.

You can also find this pre-formatted in the Upstash console. Look for **"Connection String"** or click the **Connect**
button — it will show the URL in various formats. Copy the one starting with `rediss://`.

### 3.3 Monitor Your Command Usage

This is important. The free tier allows 500,000 Redis commands per month. BullMQ uses Redis commands constantly while
your server is awake. To understand your usage:

Go to your Upstash database → **Analytics** tab. You will see a chart of daily commands. Check this weekly for the first
month. If you see usage approaching 400,000 commands/month, move to Phase 3 of tier1.md (the Upstash Fixed plan) before
you hit the cap. A hard stop at 500,000 will cause BullMQ to stop processing jobs entirely.

If your server is sleeping most of the time (no UptimeRobot pings), you should comfortably stay under 500,000
commands/month.

---

## Phase 4 — Azure Blob Storage Setup

Blob Storage is where your listing photos are stored. The always-free tier gives you 5 GB of Standard LRS storage, which
will cover thousands of listing photos before you need to worry about cost.

### 4.1 Create a Storage Account (if not done yet)

Go to [portal.azure.com](https://portal.azure.com) and search for **"Storage accounts"** in the top search bar. Click
**+ Create**.

On the Basics tab:

- **Subscription:** Azure for Students
- **Resource group:** create one called `roomies-rg` if it doesn't exist (this keeps all your Azure resources in one
  place for easy deletion later)
- **Storage account name:** `roomiesblob` — this must be globally unique across all of Azure, so if it's taken, try
  `roomiesblob2` or add your initials
- **Region:** Central India
- **Performance:** Standard
- **Redundancy:** Locally-redundant storage (LRS) — the cheapest, your photos don't need geographic replication

On the Advanced tab:

- **Allow Blob anonymous access:** turn this **On** — this is what allows photo URLs to be publicly viewable in a
  browser without authentication

Leave all other tabs as defaults. Click **Review + create**, then **Create**. Deployment takes about 30 seconds.

### 4.2 Create the Photo Container

After creation, go to your storage account → find **Containers** in the left sidebar under "Data storage" → click **+
Container**.

- **Name:** `roomies-uploads`
- **Public access level:** **Blob (anonymous read access for blobs only)**

The "blob" level means anyone with a direct photo URL can view the photo, but no one can list all files in the
container. This is exactly what you need — frontend can show photos without authentication, but nobody can scrape your
entire photo library.

### 4.3 Get the Connection String

Go to your storage account → **Access keys** in the left sidebar (under "Security + networking") → click **Show** next
to the Connection string under **key1**.

Copy the entire string. It starts with `DefaultEndpointsProtocol=https;AccountName=roomiesblob;AccountKey=...`. This is
your `AZURE_STORAGE_CONNECTION_STRING`.

---

## Phase 5 — Brevo Email Setup

As explained in Phase 1, Render's free tier blocks SMTP. You need to use Brevo's REST API instead of their SMTP relay.
The REST API uses port 443 (standard HTTPS) which is always open.

### 5.1 Get Your Brevo API Key

You already have a Brevo account. Log in at [app.brevo.com](https://app.brevo.com).

Go to **Settings** (top right menu) → **API Keys** → find your existing API key or click **Generate a new API key**. The
API key starts with `xkeysib-`. Copy it — this is your `BREVO_API_KEY`.

This is different from your SMTP key (which starts with `xsmtpsib-`). The API key is what the REST API uses.

### 5.2 Verify Your Sender Address

Your emails must be sent from a verified sender address. Go to **Settings** → **Senders & Domains** → check that
`sumitly1642@gmail.com` (or whatever you set as `BREVO_SMTP_FROM`) appears as verified.

If your sender address is not verified, click **Add a sender** and follow the verification steps. You will receive a
verification email at that address.

**Important for production:** Gmail addresses work fine for testing, but for a professional app, you eventually want to
send from `noreply@roomies.sumitly.app`. You can set this up in Brevo under Senders & Domains → "Add a domain" and
follow their DNS instructions. This can be done later — it doesn't block deployment.

---

## Phase 6 — Local Testing Against Tier 0 Services

Before deploying to Render, test that your code works against all the live services from your local machine. This
catches configuration problems before they become Render deploy failures.

### 6.1 Create `.env.render`

Create this file at your project root. Fill in all the values you collected in phases 2–5:

```env
# .env.render — local testing against live Tier 0 services
# NEVER COMMIT THIS FILE — it contains your database password and API keys

NODE_ENV=production
PORT=3000
ENV_FILE=.env.render

# ─── Neon PostgreSQL ───────────────────────────────────────────────────────────
DATABASE_URL=postgresql://neondb_owner:YOUR_PASSWORD@ep-YOUR-ENDPOINT.ap-southeast-1.aws.neon.tech/neondb?sslmode=require

# ─── Upstash Redis (TLS required — note the double-s in rediss://) ─────────────
REDIS_URL=rediss://default:YOUR_UPSTASH_PASSWORD@YOUR-ENDPOINT.upstash.io:6379

# ─── JWT ──────────────────────────────────────────────────────────────────────
JWT_SECRET=YOUR_GENERATED_64_CHAR_SECRET
JWT_REFRESH_SECRET=YOUR_OTHER_GENERATED_64_CHAR_SECRET
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# ─── Azure Blob Storage ────────────────────────────────────────────────────────
STORAGE_ADAPTER=azure
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=roomiesblob;AccountKey=YOUR_KEY;EndpointSuffix=core.windows.net
AZURE_STORAGE_CONTAINER=roomies-uploads

# ─── Email via Brevo REST API (no SMTP, works on Render free tier) ─────────────
EMAIL_PROVIDER=brevo-api
BREVO_API_KEY=xkeysib-YOUR_API_KEY_HERE
BREVO_SMTP_FROM=your-verified-sender@example.com

# ─── CORS (allow everything for local testing) ────────────────────────────────
ALLOWED_ORIGINS=http://localhost:5173

# ─── Google OAuth ─────────────────────────────────────────────────────────────
GOOGLE_CLIENT_ID=xxxxxxxxxxxxxxxxxxxx
GOOGLE_CLIENT_SECRET=xxxxxxxxxxxxxxxx

# ─── Trust Proxy (Render must use 1 for real client IP extraction) ───────────
TRUST_PROXY=1
```

**About `.env.render` vs Render dashboard values:**

- `NODE_ENV` should be `production` in both places.
- If you keep a personal local override file, use something like `.env.render.local` (never commit it).
- The currently committed `.env.render` may still show historical values (`TRUST_PROXY=false`, localhost-only
  `ALLOWED_ORIGINS`) that must be corrected in the Render dashboard for production behavior.

Generate fresh JWT secrets (run this command twice to get two different secrets):

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

### 6.2 Run the Local Test

```bash
npm run dev:render
```

Watch the startup output. You should see:

```
PostgreSQL connected
Redis connected
Media processing worker started
Notification delivery worker started
Email delivery worker started
Verification event worker started
cron:listingExpiry — registered
cron:expiryWarning — registered
cron:hardDeleteCleanup — registered
Server running on port 3000 [production]
```

If PostgreSQL shows `unhealthy`, the most common cause is a wrong `DATABASE_URL`. Double-check that you copied the full
Neon connection string without cutting any characters.

If Redis shows `unhealthy`, check that your `REDIS_URL` starts with `rediss://` (double s) and ends with `:6379`.

Test the health endpoint:

```bash
curl http://localhost:3000/api/v1/health
# Expected: {"status":"ok","services":{"database":"ok","redis":"ok"}}
```

Test a registration to confirm the full flow:

```bash
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"yourtest@example.com","password":"TestPass1","role":"student","fullName":"Test User"}'
# Expected: 201 with a data.user object
```

If this works locally against Neon and Upstash, you are ready to deploy to Render.

---

## Phase 7 — Render Web Service Setup

### 7.1 Connect GitHub and Create the Service

Go to [dashboard.render.com](https://dashboard.render.com) and sign in with GitHub.

Click **New** → **Web Service**.

Click **Connect account** if this is your first time — this grants Render permission to read your GitHub repositories.
Then select your roomies backend repository from the list.

Fill in the service settings:

- **Name:** `roomies-api` (this becomes `roomies-api.onrender.com` before you add the custom domain)
- **Region:** `Singapore (Southeast Asia)` — choose this explicitly; it defaults to Oregon which adds 250ms+ latency for
  India
- **Branch:** `main`
- **Root Directory:** leave empty (your `package.json` is at the root)
- **Environment:** `Node`
- **Build Command:** `npm install`
- **Start Command:** `node src/server.js`
- **Plan:** `Free`

Click **Create Web Service**. Render will begin the first deployment. This takes 2–4 minutes the first time.

### 7.2 Set Environment Variables

While the first deployment runs (or after it finishes), go to your service page → click **Environment** in the left
sidebar.

Click **Add Environment Variable** for each of the following. Use the **Secret** checkbox for anything sensitive
(passwords, keys, connection strings) — this encrypts the value and prevents it from showing in logs.

Add these variables:

| Variable                          | Value                                                | Secret? |
| --------------------------------- | ---------------------------------------------------- | ------- |
| `NODE_ENV`                        | `production`                                         | No      |
| `PORT`                            | `10000`                                              | No      |
| `DATABASE_URL`                    | your Neon connection string                          | **Yes** |
| `REDIS_URL`                       | `rediss://default:PASSWORD@ENDPOINT.upstash.io:6379` | **Yes** |
| `JWT_SECRET`                      | your 64-char secret                                  | **Yes** |
| `JWT_REFRESH_SECRET`              | your other 64-char secret                            | **Yes** |
| `JWT_EXPIRES_IN`                  | `15m`                                                | No      |
| `JWT_REFRESH_EXPIRES_IN`          | `7d`                                                 | No      |
| `STORAGE_ADAPTER`                 | `azure`                                              | No      |
| `AZURE_STORAGE_CONNECTION_STRING` | the full connection string from Azure                | **Yes** |
| `AZURE_STORAGE_CONTAINER`         | `roomies-uploads`                                    | No      |
| `EMAIL_PROVIDER`                  | `brevo-api`                                          | No      |
| `BREVO_API_KEY`                   | your `xkeysib-` key                                  | **Yes** |
| `BREVO_SMTP_FROM`                 | your verified sender email                           | No      |
| `GOOGLE_CLIENT_ID`                | your Google client ID                                | No      |
| `GOOGLE_CLIENT_SECRET`            | your Google client secret                            | **Yes** |
| `ALLOWED_ORIGINS`                 | `http://localhost:5173` (initial)                    | No      |
| `TRUST_PROXY`                     | `1`                                                  | No      |

`TRUST_PROXY=1` is security-relevant on Render. Without it, Express sees the proxy IP instead of the real client IP,
which breaks OTP IP throttling, guest fingerprinting in `contactRevealGate`, and Redis-backed auth rate limits.

`ALLOWED_ORIGINS` starts as `http://localhost:5173` during backend-only rollout. After frontend deployment, update it to
production domains (comma-separated), for example:

`https://roomies.vercel.app,https://www.roomies.in`

**Important note about `PORT`:** Render injects its own PORT environment variable (usually 10000) into the process. Your
`config/env.js` reads `PORT` and coerces it to a number. Setting `PORT=10000` here ensures the fallback is correct. In
practice, Render's injected PORT takes precedence.

After adding all variables, Render will ask if you want to redeploy with the new variables. Click **Save Changes** →
then **Manual Deploy** → **Deploy latest commit** to trigger a fresh deployment with all variables set.

### 7.3 Watch the Deployment Logs

Click **Logs** in the left sidebar. You should see the startup sequence. The expected output is identical to what you
saw locally:

```
PostgreSQL connected
Redis connected
Media processing worker started
...
Server running on port 10000 [production]
```

If you see any errors here, the most common causes are:

- Environment variable name typo — variable names are case-sensitive; `DATABASE_URL` is not the same as `Database_URL`
- Connection string copied incompletely — make sure there are no line breaks in the middle of a connection string
- Missing `BREVO_API_KEY` while `EMAIL_PROVIDER=brevo-api` — the startup validation will exit with a clear error message

---

## Phase 8 — DNS Configuration on name.com

This phase connects `api.roomies.sumitly.app` to your Render service. DNS changes propagate across the internet
gradually — most records update within 5–30 minutes, but the full global propagation can take up to 48 hours (in
practice it's usually under an hour for name.com).

Understanding what you're doing: A DNS record tells the internet "when someone types `api.roomies.sumitly.app`, send
them to this address." You will add a CNAME record, which is an alias — it says "point this name to that other name",
rather than directly pointing to an IP address. CNAME is correct for Render because Render uses a hostname, not a fixed
IP.

### 8.1 Access Your DNS Settings

Go to [name.com](https://www.name.com) and log in.

Click **My Domains** in the top navigation. Find `sumitly.app` in your domain list. Click the three-dot menu (⋮) next to
it → click **Manage Domain**. In the domain management page, find the **DNS** section and click **Manage DNS Records**.

### 8.2 Add the Backend CNAME Record

You are adding a record for `api.roomies.sumitly.app`. In DNS terms, the "host" for a subdomain of your domain is just
the part before your domain. So for `api.roomies.sumitly.app`, the host is `api.roomies`.

Click **Add Record**. Fill in:

- **Type:** `CNAME`
- **Host:** `api.roomies` (name.com automatically appends `.sumitly.app`, so you only enter the prefix)
- **Answer/Value/Target:** `roomies-api.onrender.com` (the `.onrender.com` address of your Render service — find this on
  your Render service overview page)
- **TTL:** leave at the default (300 seconds)

Click **Add Record**.

### 8.3 Add the Frontend CNAME Record (Placeholder for Now)

When your frontend is deployed (on Vercel or another service), you will add another CNAME for `roomies.sumitly.app`. For
now, skip this unless you already know your Vercel deployment URL. Come back to this when the frontend is deployed.

If using Vercel: Vercel will give you a CNAME target like `cname.vercel-dns.com`. You would add:

- **Type:** `CNAME`
- **Host:** `roomies`
- **Answer:** `cname.vercel-dns.com`

### 8.4 Verify DNS Propagation

After adding your records, check propagation using this tool in your browser:

```
https://dnschecker.org/#CNAME/api.roomies.sumitly.app
```

Or from your terminal:

```bash
dig CNAME api.roomies.sumitly.app
# Should show: api.roomies.sumitly.app → roomies-api.onrender.com
```

Wait until you see the CNAME resolve before proceeding to Phase 9.

---

## Phase 9 — Connect Custom Domain on Render

Once DNS has propagated, tell Render about your custom domain so it can issue an SSL certificate for it.

### 9.1 Add the Custom Domain

In your Render dashboard → your `roomies-api` service → **Settings** (left sidebar) → scroll down to **Custom Domains**.

Click **+ Add Custom Domain**. Enter:

```
api.roomies.sumitly.app
```

Click **Save**.

Render will verify that the CNAME record points to it (this requires DNS to have propagated first). If it shows
"Verification pending", wait a few minutes and refresh the page.

Once verified, Render automatically issues a free SSL certificate from Let's Encrypt. This takes 1–5 minutes. You will
see the status change to **"Certificate issued"** when it's done.

### 9.2 Test Your Custom Domain

```bash
curl https://api.roomies.sumitly.app/api/v1/health
# Expected: {"status":"ok","services":{"database":"ok","redis":"ok"}}
```

If this returns a valid JSON response over HTTPS, your entire Tier 0 stack is working. Congratulations.

---

## Phase 10 — Update Google OAuth Callback URL

Your Google OAuth app needs to know about the new domain so users can sign in.

Go to [console.cloud.google.com](https://console.cloud.google.com) → **APIs & Services** → **Credentials** → click your
OAuth client ID.

Under **Authorised redirect URIs**, add:

```
https://api.roomies.sumitly.app/api/v1/auth/google/callback
```

Save. Google OAuth changes take a few minutes to propagate.

---

## Phase 11 — Post-Deployment Verification Checklist

Run these checks in order. Each one tests a different layer of the stack.

**Health check:**

```bash
curl https://api.roomies.sumitly.app/api/v1/health
# Both services should show "ok"
```

**User registration (tests database write):**

```bash
curl -X POST https://api.roomies.sumitly.app/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"verify@yourdomain.com","password":"TestPass1","role":"student","fullName":"Verification Test"}'
# Expected: 201 Created
```

**OTP email (tests Brevo REST API):**

```bash
# Use the access token from the registration response
curl -X POST https://api.roomies.sumitly.app/api/v1/auth/otp/send \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
# Expected: 200 with "OTP sent to your email"
# Then check your inbox — the email should arrive within 30 seconds
```

**Photo upload (tests Azure Blob Storage + BullMQ):** Create a test listing and upload a photo to
`POST /api/v1/listings/:id/photos`. Wait 10–15 seconds, then `GET /api/v1/listings/:id/photos`. You should see a photo
with a URL containing `blob.core.windows.net`.

**Cold start test:** Wait 20 minutes without making any requests. Then make a request and observe. The first response
will take about 1 minute. Subsequent requests will be fast. This is expected behaviour.

---

## Phase 12 — Auto-Deploy via GitHub Actions (Optional)

Render already auto-deploys when you push to `main`. You don't need any GitHub Actions for this to work. However, if you
want to add a deployment status badge to your repository or need the deploy triggered only after tests pass, here's the
minimal config:

First, get your Render deploy hook: Render dashboard → your service → **Settings** → scroll to **Deploy Hook** → copy
the URL.

Add it to GitHub: your repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret** → name
it `RENDER_DEPLOY_HOOK` and paste the URL.

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Render
on:
    push:
        branches: [main]
jobs:
    deploy:
        runs-on: ubuntu-latest
        steps:
            - name: Trigger Render deploy
              run: curl -X POST "${{ secrets.RENDER_DEPLOY_HOOK }}"
```

With this, every push to `main` triggers a deploy. Without this, every push to `main` also triggers a deploy — so this
is truly optional.

---

## Ongoing Monitoring

**Weekly checks (5 minutes each):**

Upstash Console → your database → **Analytics** tab: Look at the "Daily Commands" chart. If any day exceeds
15,000–20,000 commands, your server is staying awake more than expected (possibly someone is pinging it). Check whether
Render is sleeping properly by looking at the Render logs — if you see continuous traffic, find out where it's coming
from.

Neon Console → your project → **Project Dashboard**: Look at storage usage. You start with 0.5 GB. With real users
uploading photos, you won't hit this quickly (photos go to Azure Blob, not Neon), but your user data, listings, and
connections all live in Neon. At 50 users/day with heavy listing activity, expect to use ~1–5 MB/day.

Azure Portal → your storage account → **Overview** → **Monitoring**: Check blob storage usage. You get 5 GB free. At 100
KB per photo (after Sharp compression to WebP), 5 GB holds 50,000 photos before you start paying.

Brevo Dashboard → **Transactional** → **Statistics**: Check email delivery rates. If you see high bounce rates, your
sender domain verification may need attention.

---

## Known Limitations of Tier 0

**Cold starts:** The first request after 15 minutes of idle takes about 1 minute. Render shows a loading page to the
user during this time. Users who sign up, go away, and come back 30 minutes later will hit a cold start. This is the
fundamental trade-off of the free tier.

**No persistent local filesystem:** Render's free tier restarts regularly and doesn't support persistent disk. Your app
already handles this correctly — photos go to Azure Blob, not local disk. The `uploads/staging/` folder (where Multer
writes files before processing) is ephemeral and that's fine — if the server restarts mid-upload, the BullMQ job is
retried.

**750 hours/month cap:** Render's free tier gives 750 hours of compute per month. One month has 720–744 hours. So you
effectively have enough for continuous operation — but if you also have other free Render services, the 750 hours are
shared across all of them in your workspace.

**No zero-downtime deploys:** Render's free tier restarts the process on each deploy. During the few seconds of restart,
requests may fail. For a low-traffic early-stage app, this is acceptable. If you need zero-downtime deploys, that
requires Render Starter tier or Azure App Service.

---

## Troubleshooting Common Problems

| Symptom                            | Most Likely Cause                             | Fix                                                                                 |
| ---------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------- |
| `database: "unhealthy"` on health  | Wrong DATABASE_URL or Neon compute cold start | Check the Neon console — is compute active? Wait 30s and retry                      |
| `redis: "unhealthy"` on health     | Wrong REDIS_URL format                        | Must be `rediss://` (double-s), port `6379`                                         |
| Emails not arriving                | Wrong BREVO_API_KEY or unverified sender      | Check Brevo → Transactional → Logs for errors                                       |
| Photos stuck at `processing:`      | BullMQ media worker not started               | Check Render logs for `Media processing worker started`                             |
| HTTPS not working on custom domain | DNS not yet propagated or SSL not yet issued  | Run `dig CNAME api.roomies.sumitly.app` and check Render's Custom Domains panel     |
| 500 on register                    | Missing env var                               | Check Render logs for the specific error — env.js will print clearly what's missing |
| Cron jobs not running              | Server was sleeping at scheduled time         | Expected — crons are idempotent and catch up on next wake                           |
| Cold start taking 2+ minutes       | Neon compute also cold-starting               | Normal — Render cold start (1 min) + Neon cold start (0.5s) happen together         |
