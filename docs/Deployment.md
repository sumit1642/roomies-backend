# Roomies — Deployment Guide (April 2026 Edition)

> **Status:** Complete replacement of the previous `docs/Deployment.md`.
> **Philosophy:** Free providers first, Azure student credits as the last resort.
> **Written for:** ≤50 users/day, API-only backend, idle-on-no-traffic is acceptable.
> **Last researched:** April 2026.

---

## The Core Strategy

Azure student credits are a finite resource (₹9,480 total). The goal is to stretch them as far as possible by exhausting truly free external providers first. Azure is not avoided — it is reserved for cases where no free alternative exists or when free limits are hit.

```
Tier 0 — Completely Free (start here)
  ├── App Server   → Render free web service (512 MB, sleeps when idle)
  ├── PostgreSQL   → Neon free tier (0.5 GB, PostGIS, never expires)
  ├── Redis        → Upstash free tier (500K commands/month — monitor this)
  ├── File Storage → Azure Blob Storage always-free 5 GB (existing adapter)
  └── Email        → Brevo free (300 emails/day, forever)

Tier 1 — Paid external (when free limits hit)
  ├── Redis > 500K cmds/month → Upstash Fixed $10/month (~₹840)
  └── DB > 0.5 GB             → Azure PostgreSQL on student credits

Tier 2 — Azure student credits (last resort, or when external paid cost
         exceeds the Azure equivalent)
  ├── App Server  → Azure App Service B1 (~₹1,092/month)
  ├── PostgreSQL  → Azure PostgreSQL Flexible B1ms (~₹1,043/month)
  ├── Redis       → Azure Cache for Redis C0 (~₹1,050/month)
  └── (Storage and email stay on free providers indefinitely)
```

**Why Render free instead of Azure App Service F1?**
Azure's free F1 tier has no Always On, killing BullMQ workers on idle. Render's free tier is also a sleeping process — but that is explicitly acceptable here since idle means no users, which means no jobs are needed either. Render's 750 free hours per month equals a full calendar month of runtime.

**Why idle is actually fine for this app:**
- BullMQ workers sleep with the process → zero Redis polling → Upstash free tier lasts much longer.
- node-cron (listing expiry, etc.) is idempotent — a missed midnight run at 2 AM is caught the next time the server wakes.
- Cold starts are ~1–2 seconds on Render free tier. Acceptable for ≤50 users/day.

---

## Part 0 — Critical Decisions

### Decision 1: No Docker Required

Render detects Node.js automatically. Connect your GitHub repo, set a start command, and you're done. No Dockerfile needed.

### Decision 2: Upstash Free Tier Works If Idle Is Allowed

The previous Deployment.md concluded BullMQ exhausts the 500K free commands in ~10 days. That calculation assumed 24/7 uptime. With Render's free tier sleeping after 15 minutes of inactivity:

```
Estimate for a low-traffic app (server awake ~3 hours/day):
  3 workers × 12 BZPOPMIN calls/min × 60 min × 3 hr × 30 days
  = ~194,400 commands/month — comfortably under 500K.
```

**Do not add UptimeRobot or any ping-to-keep-alive mechanism.** Letting the server sleep is what keeps Redis usage low.

### Decision 3: Single Process (No Worker Separation)

Express + BullMQ workers + node-cron all run in one Render web service. This is the same single-process architecture described in the previous guide — it is correct for this scale.

### Decision 4: Azure Blob Storage Stays

The existing `AzureBlobAdapter` is already written and tested. Azure Blob's 5 GB always-free tier does not consume student credits. Keep it. Writing a new Cloudflare R2 adapter would add code complexity for no real benefit at this stage.

### Decision 5: No Key Vault on Render

Render has built-in environment variable management with secret values. No Key Vault needed for Tier 0 or Tier 1. Key Vault only comes into play if you migrate to Azure App Service (Tier 2).

### Decision 6: Revised Realistic Budget

| Tier | Monthly Cost | Credits Spent | Est. Runway |
|---|---|---|---|
| Tier 0 (all free) | ₹0 | ₹0 | Indefinite |
| Tier 1 (Upstash Fixed added) | ~₹840 | ₹0 | Indefinite |
| Tier 2 partial (Azure DB added) | ~₹1,923 | ~₹1,923/month | ~5 months |
| Tier 2 full (all Azure) | ~₹3,302 | ~₹3,302/month | ~2.9 months |

---

## Part 1 — Tier 0 Architecture

```
Internet
    │
    ▼
[Render Free Web Service — Singapore region]
  Node.js 22 LTS
  src/server.js — Express + BullMQ workers + node-cron (single process)
  Sleeps after 15 min idle. Cold-starts in ~1–2s on next request.
    │
    ├─────────────────────────────────────────┐
    │                                         │
    ▼                                         ▼
[Neon Free — PostgreSQL 16 + PostGIS]    [Upstash Free Redis]
  Serverless, scale-to-zero               Singapore region
  0.5 GB storage                          500K commands/month
  Wakes in ~500ms on first query          rediss:// TLS
    │
    ▼
[Azure Blob Storage — always-free 5 GB]
  Standard LRS, Central India
  Container: roomies-uploads (public blob read)
  Uses existing AzureBlobAdapter — no code changes needed
    │
    ▼
[Brevo SMTP — free 300 emails/day]
  smtp-relay.brevo.com:587
  OTPs, verification emails
```

API base URL: `https://roomies-api.onrender.com/api/v1`

---

## Part 2 — Pre-Deployment Checklist

### 2.1 Create Accounts (all free, no credit card required)

- [ ] **Render** — [render.com](https://render.com). Sign up with GitHub. No card needed for free tier.
- [ ] **Neon** — [neon.com](https://neon.com). Sign up free. No card needed.
- [ ] **Upstash** — [upstash.com](https://upstash.com). Sign up free. No card needed for free tier.
- [ ] **Azure Portal** — [portal.azure.com](https://portal.azure.com) (you already have this for Blob Storage).
- [ ] **Brevo** — [brevo.com](https://brevo.com) (you may already have this configured).

### 2.2 Generate Secrets

```bash
# JWT secrets (run twice to get two different values)
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

---

## Part 3 — Step-by-Step Tier 0 Setup

### Phase 1: Neon PostgreSQL

#### 1.1 Create the Database

1. Go to [console.neon.tech](https://console.neon.tech)
2. Click **Create Project**
3. Fill in:
   - Name: `roomies`
   - PostgreSQL version: **16**
   - Region: **AWS Asia Pacific (Singapore)** — closest to India
4. Click **Create Project**

Neon creates a default `neondb` database. Note the connection string from the dashboard — it looks like:

```
postgresql://neondb_owner:PASSWORD@ep-ENDPOINT.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
```

#### 1.2 Enable PostGIS and pgcrypto

In the Neon SQL Editor (Dashboard → SQL Editor):

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

Verify PostGIS works:

```sql
SELECT ST_AsText(ST_MakePoint(77.21, 28.63));
-- Expected: POINT(77.21 28.63)
```

#### 1.3 Run Your Schema

From your local terminal (with `DATABASE_URL` pointing to Neon):

```bash
# Set Neon URL temporarily for migration
export DATABASE_URL="postgresql://neondb_owner:PASSWORD@ep-ENDPOINT.ap-southeast-1.aws.neon.tech/neondb?sslmode=require"

# Run migrations
node src/db/migrate.js
# or with ENV_FILE:
ENV_FILE=.env.neon node src/db/migrate.js
```

After configuring `.env.neon` (see Phase 5):

```bash
npm run seed:amenities
```

**Neon cold-start note:** The first query after Neon compute scales to zero takes ~300–500ms. Your BullMQ workers connecting every few seconds during active use will keep Neon warm during those sessions. When idle, both Neon and Render sleep — and wake together on the next request.

---

### Phase 2: Upstash Redis

#### 2.1 Create the Database

1. Go to [console.upstash.com](https://console.upstash.com)
2. Click **Create database**
3. Fill in:
   - Name: `roomies-redis`
   - Type: **Regional**
   - Region: **AWS ap-southeast-1 (Singapore)**
   - Plan: **Free** ← start here; upgrade to Fixed $10/month if you exceed 500K commands
   - TLS: **Enabled** (leave on)
4. Click **Create**

#### 2.2 Get the Connection String

From the database overview, copy:

- **Endpoint**: `SOMETHING.upstash.io`
- **Password**: a long random string

Your `REDIS_URL`:

```
rediss://default:YOUR_PASSWORD@SOMETHING.upstash.io:6380
```

Format: `rediss://default:PASSWORD@ENDPOINT:6380`

The existing `bullConnection.js` and `cache/client.js` both handle `rediss://` TLS URLs correctly. **No code changes needed.**

#### 2.3 Monitor Command Usage

Upstash dashboard shows real-time command usage. Check it weekly for the first month. If you approach 400K commands, switch to the **Fixed 250MB plan ($10/month)** before hitting the cap — a hard rate-limit at 500K will cause BullMQ to stop processing jobs.

Migration trigger: Upstash dashboard shows > 400K commands used in a month.

---

### Phase 3: Azure Blob Storage (Always-Free, Existing Adapter)

This is unchanged from the previous Deployment.md. You need to do this once even for Tier 0 because it is the only storage option with an existing adapter in the codebase.

#### 3.1 Create Storage Account (if not already done)

1. Go to [portal.azure.com](https://portal.azure.com)
2. Search **Storage accounts** → **+ Create**
3. **Basics:**
   - Resource group: `roomies-rg` (create if it doesn't exist)
   - Storage account name: `roomiesblob` (must be globally unique, lowercase)
   - Region: **Central India**
   - Performance: **Standard**
   - Redundancy: **Locally redundant storage (LRS)**
4. **Advanced tab:**
   - Allow blob anonymous access: **Enabled**
   - Minimum TLS: **TLS 1.2**
5. **Review + create** → **Create**

#### 3.2 Create the Blob Container

1. Storage account → **Containers** → **+ Container**
2. Name: `roomies-uploads`
3. Public access level: **Blob (anonymous read access for blobs only)**
4. Click **Create**

#### 3.3 Get the Connection String

1. Storage account → **Access keys** (left menu under Security)
2. Click **Show** next to **Connection string** under key1
3. Copy the full string — this is `AZURE_STORAGE_CONNECTION_STRING`

This does **not** consume any student credits. Azure Blob Standard LRS first 5 GB is always free.

---

### Phase 4: Brevo Email Setup

Skip if already configured. Otherwise:

1. Log in to [brevo.com](https://brevo.com)
2. Go to **Settings** → **SMTP & API** → **SMTP**
3. Copy your **SMTP login** (e.g., `12345xyz@smtp-brevo.com`) → `BREVO_SMTP_LOGIN`
4. Under **SMTP Keys**, generate a new key (starts with `xsmtpsib-`) → `BREVO_SMTP_KEY`
5. Go to **Senders & Domains** → add and verify your sender email → `BREVO_SMTP_FROM`

---

### Phase 5: Local Test Environment (`.env.render`)

Create `.env.render` at the project root. **Add to `.gitignore` immediately.**

```env
# .env.render — local testing against Tier 0 services
# NEVER COMMIT THIS FILE

NODE_ENV=production
PORT=3000
ENV_FILE=.env.render

# Neon PostgreSQL
DATABASE_URL=postgresql://neondb_owner:PASSWORD@ep-ENDPOINT.ap-southeast-1.aws.neon.tech/neondb?sslmode=require

# Upstash Redis
REDIS_URL=rediss://default:YOUR_UPSTASH_PASSWORD@YOUR-ENDPOINT.upstash.io:6380

# JWT
JWT_SECRET=YOUR_GENERATED_JWT_SECRET
JWT_REFRESH_SECRET=YOUR_GENERATED_JWT_REFRESH_SECRET
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# Azure Blob Storage (always-free 5 GB)
STORAGE_ADAPTER=azure
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=roomiesblob;AccountKey=XXXX;EndpointSuffix=core.windows.net
AZURE_STORAGE_CONTAINER=roomies-uploads

# Email
EMAIL_PROVIDER=brevo
BREVO_SMTP_LOGIN=your-login@smtp-brevo.com
BREVO_SMTP_KEY=xsmtpsib-xxxxxx
BREVO_SMTP_FROM=noreply@yourdomain.com

# CORS — allow everything for local testing
ALLOWED_ORIGINS=http://localhost:5173

# Google OAuth (optional, skip if not ready)
GOOGLE_CLIENT_ID=YOUR_CLIENT_ID
GOOGLE_CLIENT_SECRET=YOUR_CLIENT_SECRET

TRUST_PROXY=false
```

Test locally:

```bash
npm run dev:azure   # reuse the azure script — just point to .env.render
# or add to package.json:
# "dev:render": "ENV_FILE=.env.render nodemon src/server.js"

curl http://localhost:3000/api/v1/health
# Expected: {"status":"ok","services":{"database":"ok","redis":"ok"}}
```

---

### Phase 6: Render Web Service

#### 6.1 Connect GitHub Repository

1. Go to [dashboard.render.com](https://dashboard.render.com)
2. Click **New** → **Web Service**
3. Connect your GitHub account and select your repo
4. Fill in:
   - **Name:** `roomies-api`
   - **Region:** `Singapore` (closest to India)
   - **Branch:** `main`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `node src/server.js`
   - **Plan:** `Free`

5. Click **Create Web Service**

Render assigns a URL like `https://roomies-api.onrender.com`.

#### 6.2 Set Environment Variables

In the Render dashboard → your web service → **Environment** tab → **Add Environment Variable** for each:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `10000` (Render injects its own PORT; set this as fallback) |
| `DATABASE_URL` | your Neon connection string |
| `REDIS_URL` | `rediss://default:PASSWORD@ENDPOINT.upstash.io:6380` |
| `JWT_SECRET` | your generated secret |
| `JWT_REFRESH_SECRET` | your second generated secret |
| `JWT_EXPIRES_IN` | `15m` |
| `JWT_REFRESH_EXPIRES_IN` | `7d` |
| `STORAGE_ADAPTER` | `azure` |
| `AZURE_STORAGE_CONNECTION_STRING` | your full connection string |
| `AZURE_STORAGE_CONTAINER` | `roomies-uploads` |
| `EMAIL_PROVIDER` | `brevo` |
| `BREVO_SMTP_LOGIN` | your Brevo SMTP login |
| `BREVO_SMTP_KEY` | your `xsmtpsib-...` key |
| `BREVO_SMTP_FROM` | your verified sender address |
| `ALLOWED_ORIGINS` | `*` (tighten when frontend is deployed) |
| `TRUST_PROXY` | `1` |

**Render tip:** Use the **Secret** checkbox on any sensitive value (JWT secrets, SMTP keys, DB password). These are stored encrypted and never shown in logs.

#### 6.3 Deploy

Render auto-deploys on every push to `main`. To trigger the first deploy manually:

1. Render dashboard → your web service → **Manual Deploy** → **Deploy latest commit**
2. Watch the **Logs** tab

Expected successful output:

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
Server running on port 10000 [production]
```

---

## Part 4 — Post-Deployment Verification

Run these in order.

### 4.1 Health Check

```bash
curl https://roomies-api.onrender.com/api/v1/health
# Expected: {"status":"ok","services":{"database":"ok","redis":"ok"}}
```

Note: the first request after the service spins down will take 5–10 seconds (cold start + Neon compute cold start). Subsequent requests within the same session are fast.

### 4.2 Test Registration

```bash
curl -X POST https://roomies-api.onrender.com/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "TestPass1",
    "role": "student",
    "fullName": "Test User"
  }'
```

Expected: `201` with a `data.user` object and `sid`.

### 4.3 Verify Photo Upload

1. Create a listing via API
2. Upload a photo: `POST /listings/:id/photos` (multipart, field `photo`)
3. Immediate response should be `202` with `status: "processing"`
4. Wait 10–15 seconds, then `GET /listings/:id/photos`
5. A photo with a `blob.core.windows.net` URL should appear

### 4.4 Verify Email

1. Register with a real email address
2. Call `POST /api/v1/auth/otp/send` (requires auth token)
3. Check Brevo dashboard → **Transactional** → **Logs** for delivery
4. Check your inbox for the OTP email

---

## Part 5 — Monitoring and Migration Triggers

### 5.1 What to Monitor

| Metric | Where to Check | Migration Trigger |
|---|---|---|
| Redis commands/month | Upstash Console → Usage | > 400K → upgrade to Upstash Fixed $10/mo |
| Neon storage | Neon Console → Project → Storage | > 0.4 GB → plan migration to Azure PostgreSQL |
| Render free hours | Render Dashboard → Billing | Near 750h → evaluate paid Render or Azure App Service |
| Blob storage | Azure Portal → Storage Account | > 4 GB → still cheap at ~₹1.5/GB |
| Brevo sends | Brevo Dashboard → Statistics | > 200/day avg → consider higher Brevo plan |

### 5.2 Migration Checklist — Redis

When Upstash free hits the limit:

```
Option A: Upstash Fixed 250MB plan ($10/month ≈ ₹840)
  → Just change the billing plan in the Upstash console.
  → No code changes, no URL change.

Option B: Azure Cache for Redis C0 Basic (student credits, ~₹1,050/month)
  → See Part 7 (Tier 2 Azure) for setup instructions.
  → Update REDIS_URL in Render environment variables.
```

### 5.3 Migration Checklist — Database

When Neon exceeds 0.5 GB:

```
Option A: Neon paid plan (~$19/month ≈ ₹1,600)
  → Upgrade in Neon console.
  → No migration needed — same connection string.

Option B: Azure PostgreSQL Flexible B1ms (student credits)
  → See Part 7 (Tier 2 Azure) for setup instructions.
  → Run migrations against the new DB, then update DATABASE_URL in Render.
```

### 5.4 Migration Checklist — App Server

When Render free becomes insufficient (high traffic, or you need always-on):

```
Option A: Render Starter plan ($7/month ≈ ₹580)
  → Always-on, 512 MB RAM, same deployment.

Option B: Azure App Service B1 (student credits, ~₹1,092/month)
  → See Part 7 (Tier 2 Azure) for full Azure migration.
```

---

## Part 6 — CI/CD with GitHub Actions on Render

Render auto-deploys on push to `main` once the repo is connected. No extra setup needed. For manual control:

**Render deploy hook (optional):**

1. Render dashboard → your service → **Settings** → **Deploy Hook**
2. Copy the webhook URL
3. Add to GitHub Actions as a secret `RENDER_DEPLOY_HOOK`

```yaml
# .github/workflows/deploy.yml
name: Deploy to Render

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Render Deploy
        run: curl -X POST "${{ secrets.RENDER_DEPLOY_HOOK }}"
```

---

## Part 7 — Tier 2: Full Azure Deployment (Last Resort)

Use this section only when free/cheap external providers are no longer sufficient. The Azure infrastructure below is fully production-ready and has been tested.

> **When to migrate here:** Student credits are available and monthly spend on external providers (Upstash + Neon paid) exceeds ~₹1,500/month, OR you need features not available on free tiers (always-on, larger RAM, SLAs).

### Resource Group

```bash
az login
az account set --subscription "Azure for Students"
az configure --defaults location=centralindia group=roomies-rg
az group create --name roomies-rg --location centralindia
```

### Azure PostgreSQL Flexible Server (B1ms)

**Portal steps:**

1. Search **"Azure Database for PostgreSQL flexible server"** → **+ Create** → **Flexible server**
2. **Basics:**
   - Resource group: `roomies-rg`
   - Server name: `roomies-db`
   - Region: `Central India`
   - PostgreSQL version: **16**
   - Workload: **Development** → Compute: **Standard_B1ms**, Storage: **32 GiB**
3. **Authentication:** PostgreSQL only. Admin: `roomiesadmin`. Strong password.
4. **Networking:** Public access. Add your IP. Allow Azure services: **Yes**.
5. **Backups:** 7 days, locally redundant.

Enable extensions:

```bash
az postgres flexible-server parameter set \
  --resource-group roomies-rg --server-name roomies-db \
  --name azure.extensions --value POSTGIS,PGCRYPTO
```

Create database:

```bash
az postgres flexible-server db create \
  --resource-group roomies-rg --server-name roomies-db \
  --database-name roomies_db
```

Run your schema:

```bash
psql "host=roomies-db.postgres.database.azure.com port=5432 dbname=roomies_db user=roomiesadmin password=YOUR_PASSWORD sslmode=require" \
  -f migrations/001_initial_schema.sql
psql "..." -f migrations/002_verification_event_outbox.sql
```

**Cost:** ~₹1,043/month compute + ~₹280/month storage. Stop when not developing:

```bash
az postgres flexible-server stop --resource-group roomies-rg --name roomies-db
az postgres flexible-server start --resource-group roomies-rg --name roomies-db
```

### Upstash Redis Fixed 250MB (Still Cheaper Than Azure Redis)

Azure Cache for Redis C0 costs ~₹1,050/month. Upstash Fixed 250MB is $10/month (~₹840). **Even at Tier 2, prefer Upstash Fixed over Azure Redis unless you have a specific reason to switch.** Only migrate to Azure Redis if Upstash causes operational issues.

If you do want Azure Redis:

1. Search **"Azure Cache for Redis"** → Create Basic C0
2. Region: Central India
3. Copy the primary connection string (starts with `rediss://`)

### Azure App Service (B1 Linux)

**Portal steps:**

1. Create App Service Plan: B1 Linux, Central India, name `roomies-plan`
2. Create Web App: name `roomies-api`, Node 22 LTS, Linux, uses `roomies-plan`
3. Enable **Managed Identity** (Identity → System assigned → On)
4. Create **Key Vault** `roomies-kv` (Standard, RBAC, Central India)
5. Grant App Service **Key Vault Secrets User** on the vault
6. Store all secrets in Key Vault
7. Reference them in App Service Configuration as `@Microsoft.KeyVault(SecretUri=...)`

**Application settings to add directly (not via Key Vault):**

| Name | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `8080` |
| `STORAGE_ADAPTER` | `azure` |
| `JWT_EXPIRES_IN` | `15m` |
| `JWT_REFRESH_EXPIRES_IN` | `7d` |
| `TRUST_PROXY` | `1` |

**General settings:**

- Startup Command: `node src/server.js`
- Always On: **On**
- Health check path: `/api/v1/health`
- HTTPS Only: **On**

**Key Vault secret names to create:**

| Secret Name | Value |
|---|---|
| `DATABASE-URL` | `postgresql://roomiesadmin:PASSWORD@roomies-db.postgres.database.azure.com:5432/roomies_db?sslmode=require` |
| `REDIS-URL` | `rediss://default:PASSWORD@ENDPOINT.upstash.io:6380` (or Azure Redis URL) |
| `JWT-SECRET` | your generated secret |
| `JWT-REFRESH-SECRET` | your second generated secret |
| `AZURE-STORAGE-CONNECTION-STRING` | your blob connection string |
| `AZURE-STORAGE-CONTAINER` | `roomies-uploads` |
| `EMAIL-PROVIDER` | `brevo` |
| `BREVO-SMTP-LOGIN` | your login |
| `BREVO-SMTP-KEY` | your `xsmtpsib-` key |
| `BREVO-SMTP-FROM` | your verified sender |
| `ALLOWED-ORIGINS` | `https://your-frontend.vercel.app` |

### Deploy to Azure App Service (from Render)

When migrating from Render to Azure:

```bash
# Create the deployment ZIP
zip -r roomies-deploy.zip . \
  -x "node_modules/*" ".git/*" ".env*" "uploads/*" "*.zip"

# Deploy
az webapp deploy \
  --resource-group roomies-rg --name roomies-api \
  --src-path roomies-deploy.zip --type zip

# Watch startup logs
az webapp log tail --resource-group roomies-rg --name roomies-api
```

Update your frontend's API base URL from `https://roomies-api.onrender.com` to `https://roomies-api.azurewebsites.net`.

### Tier 2 Budget

| Service | Tier | Cost/month |
|---|---|---|
| Azure App Service B1 | Basic | ~₹1,092 |
| Azure PostgreSQL Flexible B1ms | Burstable | ~₹1,043 + storage |
| PostgreSQL storage (32 GB) | Provisioned SSD | ~₹280 |
| Upstash Redis Fixed 250MB | Fixed | ~₹840 |
| Azure Blob Storage | Always-free 5 GB | ₹0 |
| Brevo Email | Free 300/day | ₹0 |
| **Total** | | **~₹3,255/month** |

With ₹9,480 credits: **~2.9 months** at full Tier 2. By then the project should have real users.

---

## Part 8 — Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| First request takes 10+ seconds | Render cold start + Neon cold start | Expected; subsequent requests fast |
| `redis: "unhealthy"` on health | Wrong `REDIS_URL` format | Must be `rediss://` (double-s), port 6380 |
| `database: "unhealthy"` | Neon compute cold start or wrong URL | Check Neon Console for endpoint status |
| Photos stuck on `processing:` | BullMQ media worker not started | Check logs for `Media processing worker started` |
| OTP emails not arriving | Brevo sender not verified | Verify `BREVO_SMTP_FROM` in Brevo → Senders |
| Cron jobs missed | Server was sleeping at cron time | Expected; crons are idempotent — next wake catches up |
| 500K Upstash commands hit | Server kept awake (UptimeRobot?) | Remove keep-alive pings; or upgrade to Fixed plan |
| Build fails on Render | Node version mismatch | Ensure `package.json` has `"engines": {"node": ">=22.0.0"}` |
| `ENV_FILE` not found locally | Missing `.env.render` file | Create from the template in Part 3, Phase 5 |

---

## Part 9 — All Resource Names (Tier 0)

| Resource | Name | URL/Endpoint |
|---|---|---|
| Render Web Service | `roomies-api` | `https://roomies-api.onrender.com` |
| Neon Project | `roomies` | `ep-XXXXX.ap-southeast-1.aws.neon.tech` |
| Upstash Redis | `roomies-redis` | `XXXXX.upstash.io:6380` |
| Azure Storage Account | `roomiesblob` | `roomiesblob.blob.core.windows.net` |
| Blob Container | `roomies-uploads` | `https://roomiesblob.blob.core.windows.net/roomies-uploads/` |
| Email Provider | Brevo SMTP | `smtp-relay.brevo.com:587` |

---

## Part 10 — Quick Reference

```bash
# View Render logs (install Render CLI: npm i -g @render/cli)
render logs --service roomies-api --tail

# Manual Render deploy trigger
curl -X POST "YOUR_RENDER_DEPLOY_HOOK_URL"

# Run migrations against Neon
ENV_FILE=.env.render node src/db/migrate.js

# Run amenity seed against Neon
ENV_FILE=.env.render node src/db/seeds/amenities.js

# Test health check
curl https://roomies-api.onrender.com/api/v1/health

# Update Render env var via API (alternative to dashboard)
# Use the Render dashboard → Environment tab for this
```

---

## Appendix — Provider Comparison

| Dimension | Render Free | Azure App Service F1 | Azure App Service B1 |
|---|---|---|---|
| Always-on | No (sleeps 15 min idle) | No (no Always On) | Yes |
| RAM | 512 MB | 1 GB | 1.75 GB |
| BullMQ workers | Yes (sleep with server) | Yes (sleep with server) | Yes (always running) |
| Monthly cost | Free | Free | ~₹1,092 |
| Best for | Tier 0 (free, idle OK) | Not usable | Tier 2 (production) |

| Dimension | Neon Free | Azure PostgreSQL B1ms |
|---|---|---|
| Storage | 0.5 GB | 32 GB provisioned |
| PostGIS | Yes | Yes |
| Scale-to-zero | Yes (cold starts) | No (always running) |
| Monthly cost | Free | ~₹1,323 |
| Best for | Tier 0 and Tier 1 | Tier 2 |

| Dimension | Upstash Free | Upstash Fixed | Azure Redis C0 |
|---|---|---|---|
| Commands | 500K/month | Unlimited | Unlimited |
| RAM | 256 MB | 250 MB | 250 MB |
| Monthly cost | Free | $10 (~₹840) | ~₹1,050 |
| Best for | Tier 0 (monitor usage) | Tier 1 | Tier 2 (only if needed) |

---

_Guide version: April 2026. Tier 0: Render Singapore + Neon Singapore + Upstash Singapore + Azure Blob Central India. Node.js 22 LTS, PostgreSQL 16 + PostGIS._