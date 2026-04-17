# Roomies — Azure Deployment Plan

**Author:** Solo Developer  
**Target Date:** April 2026 — December 2026  
**Azure Region:** Central India (Pune)  
**Budget:** ₹9,480 total (~₹1,350/month ceiling, shared across all future projects)  
**Traffic:** ~100 visitors/day, ~50 registered users/day, variable  
**Stack:** Node.js + Express (ES Modules) · PostgreSQL 16 + PostGIS · Redis · BullMQ · Azure Blob Storage

---

## Table of Contents

1. [Email Provider Decision (Current)](#1-email-provider-decision-current)
2. [Architecture Overview](#2-architecture-overview)
3. [Priority-Based Budget Plan](#3-priority-based-budget-plan)
4. [Service Tier Decisions](#4-service-tier-decisions)
5. [Phase 0 — One-Time Azure Setup](#5-phase-0--one-time-azure-setup)
6. [Phase 1 — Database Setup (PostgreSQL + PostGIS)](#6-phase-1--database-setup-postgresql--postgis)
7. [Phase 2 — Redis Setup](#7-phase-2--redis-setup)
8. [Phase 3 — Blob Storage Setup](#8-phase-3--blob-storage-setup)
9. [Phase 4 — Key Vault Setup](#9-phase-4--key-vault-setup)
10. [Phase 5 — App Service Setup](#10-phase-5--app-service-setup)
11. [Phase 6 — Email Setup (Brevo SMTP)](#11-phase-6--email-setup-brevo-smtp)
12. [Phase 7 — Environment Variables & Key Vault Wiring](#12-phase-7--environment-variables--key-vault-wiring)
13. [Phase 8 — First Manual Deployment](#13-phase-8--first-manual-deployment)
14. [Phase 9 — Post-Deploy Verification](#14-phase-9--post-deploy-verification)
15. [Phase 10 — CI/CD Pipeline (GitHub Actions)](#15-phase-10--cicd-pipeline-github-actions)
16. [Phase 11 — Frontend (Vercel) CORS Wiring](#16-phase-11--frontend-vercel-cors-wiring)
17. [Phase 12 — Custom Domain (Future)](#17-phase-12--custom-domain-future)
18. [Code Changes Required Before Deployment](#18-code-changes-required-before-deployment)
19. [Security Checklist](#19-security-checklist)
20. [Cost Monitoring](#20-cost-monitoring)
21. [Scaling Path (When Traffic Grows)](#21-scaling-path-when-traffic-grows)

---

## 1. Email Provider Decision (Current)

**Current state:** Roomies uses Nodemailer in all environments, with provider selection via `EMAIL_PROVIDER`.

- **`EMAIL_PROVIDER=ethereal`** → fake SMTP for local testing (no real delivery).
- **`EMAIL_PROVIDER=brevo`** → real SMTP delivery via `smtp-relay.brevo.com:587`.

**Decision for Roomies:** keep a single Nodemailer code path and switch credentials by environment. This preserves local
DX (Ethereal preview URLs) and enables production OTP delivery via Brevo.

**Required Brevo env vars in production:** `BREVO_SMTP_LOGIN`, `BREVO_SMTP_KEY`, `BREVO_SMTP_FROM`.

---

## 2. Architecture Overview

```
Internet
    │
    ▼
[Azure App Service B1 — Central India]
  Node.js + Express API (src/server.js)
  + BullMQ workers (same process)
  + node-cron jobs (same process)
    │
    ├─────────────────────────────────┐
    │                                 │
    ▼                                 ▼
[Azure Database for PostgreSQL   [Azure Cache for Redis]
 Flexible Server — B1ms]          Basic C0 — 250MB
 PostgreSQL 16 + PostGIS           Central India
 Central India]
    │
    ▼
[Azure Blob Storage]
 Standard LRS
 Central India
 (Photo storage for all listings)
    │
    ▼
[Azure Key Vault — Standard]
 All secrets: JWT, DB URL,
 Redis URL, Brevo keys, etc.
    │
    ▼
[Brevo SMTP Relay]
 Email via smtp-relay.brevo.com
 (OTPs, verification emails)
```

**Frontend (separate):**

```
[Vercel — React + Vite]
    │
    ▼ HTTPS API calls
[Azure App Service — Roomies API]
```

**URL shape before custom domain:**

- API: `https://roomies-api.azurewebsites.net/api/v1`
- Blob photos: `https://roomiesblob.blob.core.windows.net/roomies-uploads/...`

---

## 3. Priority-Based Budget Plan

Budget rule: **Critical services get 60% of monthly budget. Non-critical / free-tier-eligible services get the remaining
40%.**

### Monthly Cost Breakdown (Estimated in INR, Central India region)

| Priority                                                                                 | Service                                       | Tier                                         | Est. ₹/month             | Category   |
| ---------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------- | ------------------------ | ---------- |
| 🔴 Critical                                                                              | Azure Database for PostgreSQL Flexible Server | Burstable B1ms (1 vCore, 2GB RAM)            | ~₹1,050                  | Critical   |
| 🔴 Critical                                                                              | Azure App Service (Linux)                     | Basic B1 (1 vCore, 1.75GB RAM)               | ~₹630                    | Critical   |
| 🔴 Critical                                                                              | Azure Cache for Redis                         | Basic C0 (250MB)                             | ~₹1,050                  | Critical   |
| 🟡 Important                                                                             | Azure Blob Storage                            | Standard LRS (first 5GB free, then ~₹1.5/GB) | ~₹50–₹100                | Important  |
| 🟢 Free/Negligible                                                                       | Azure Key Vault                               | Standard (pay per operation: ₹2.5/10k ops)   | ~₹5–₹10                  | Negligible |
| 🟢 Free/Negligible                                                                       | Brevo SMTP (Email)                            | Pay per send (plan-dependent)                | ~₹90                     | Negligible |
| `NOTE: The brevo allows free tier users to send 300 emails per day for free for forever` |
| 🟢 Free                                                                                  | Azure Resource Group                          | Free                                         | ₹0                       | Free       |
| 🟢 Free                                                                                  | Azure Container Registry                      | Not needed                                   | ₹0                       | Free       |
| **TOTAL**                                                                                |                                               |                                              | **~₹2,875–₹2,940/month** |            |

### Budget Analysis

- **Monthly ceiling:** ₹1,350 (to survive 7 months = ₹9,450 total)
- **Projected actual:** ~₹2,875–₹2,940/month

⚠️ **This exceeds the strict ₹1,350/month ceiling.** However, your student credits are ₹9,480 and PostgreSQL + Redis are
the most expensive items. Here's the honest breakdown:

**The Redis problem:** Azure Cache for Redis Basic C0 costs ~₹1,050/month which alone exceeds a third of budget. There
is no free tier for Redis on Azure. At 100 users/day, Redis is used for sessions, OTPs, rate limiting, and BullMQ. It is
not optional — removing Redis would break the entire auth system and job queuing.

**The realistic budget projection:**

| Scenario                                 | Monthly | Duration with ₹9,480 |
| ---------------------------------------- | ------- | -------------------- |
| Full stack as planned                    | ~₹2,900 | ~3.3 months          |
| PostgreSQL + App Service only (no Redis) | ~₹1,680 | ~5.6 months          |
| Full stack + 1 more small project        | ~₹3,500 | ~2.7 months          |

**Recommendation:** Run the full stack. Accept ~3–3.5 months of runtime on current credits. By then, either renew
student credits (Azure for Students renews annually), switch to a paying tier, or migrate to alternatives. The student
subscription can often be renewed each academic year, and many students report getting fresh credits. This is the
correct stack for a production-ready app.

**Cost-cutting measures already baked in:**

- PostgreSQL Burstable (not General Purpose) — saves ~₹1,500/month vs GP2
- Redis Basic (no SLA, no replication) — saves ~₹1,050/month vs Standard
- Blob LRS (not GRS/ZRS) — saves ~₹30/month
- App Service B1 Linux (cheaper than Windows)
- No Azure CDN (direct blob URLs, add CDN later)
- No Application Insights (Pino to stdout, captured by App Service logs)
- No Azure Container Registry (direct code deploy via zip, not Docker)

---

## 4. Service Tier Decisions

### PostgreSQL — Burstable B1ms

**Why Burstable B1ms and not General Purpose?**  
Burstable instances have CPU credits. When idle (which is most of the time at 100 users/day), they accumulate credits.
Bursts of traffic consume credits. For a low-traffic API this is perfect — you get burst performance when needed without
paying for always-on vCPUs.

- **1 vCore, 2 GB RAM**
- **32 GB Storage** (start small, auto-grow is available)
- **PostgreSQL version: 16** (confirmed PostGIS support in 2026)
- **No High Availability** (zone-redundant standby not needed at this scale)
- **Backups: 7 days** (default, free — do not reduce)
- **Public access with firewall rules** (simpler than VNet for a solo dev project)

### Redis — Basic C0

**Why Basic and not Standard?**  
Standard tier adds a secondary replica and an SLA. For 100 users/day, a few minutes of Redis downtime means:

- Users can't log in or refresh tokens (sessions are in Redis)
- OTP verification fails
- BullMQ jobs queue up

This is an inconvenience, not a catastrophe. You can afford the ~0.01% chance of downtime at this scale. **Basic C0
saves ₹1,050/month vs Standard C0.**

- **C0 = 250MB memory** — more than enough for sessions, OTPs, rate limiting counters, and BullMQ job data at this scale
- **TLS enabled** — your code already uses `rediss://` in production (see `bullConnection.js`)

### App Service — Basic B1 Linux

- **1 vCore, 1.75 GB RAM**
- **Linux** (cheaper than Windows, Node.js runs natively)
- **Always-on** (enabled by default on B1, unlike F1 which sleeps)
- **No deployment slots** (B1 doesn't support slots — that's Standard tier only)
- **Node.js 22 LTS runtime** (Azure supports it as of 2026)

### Blob Storage — Standard LRS

- **LRS** = data stored in 3 copies within one datacenter in Central India
- **Hot access tier** (photos are read frequently)
- **No CDN initially** — blob URLs will be long but functional. Add Azure CDN later when you have a custom domain
- **Container name:** `roomies-uploads` (public read access for photos)

### Key Vault — Standard

- **Standard tier** = software-protected keys (not HSM)
- **Pricing:** ₹2.5 per 10,000 operations. At app startup + 100 users/day, you'll do maybe 5,000–10,000 operations/month
  = ~₹2.50/month

### Brevo SMTP — Pay As You Go

- **Billing:** Based on Brevo plan and sent email volume
- **Transport:** SMTP relay via `smtp-relay.brevo.com:587`
- **Requirement:** Sender email must be verified in Brevo

---

## 5. Phase 0 — One-Time Azure Setup

### 5.1 Create a Resource Group

A Resource Group is a logical container for all Roomies resources. It makes cost tracking and deletion clean.

1. Go to [portal.azure.com](https://portal.azure.com)
2. Search for **Resource groups** → click **+ Create**
3. Fill in:
    - **Subscription:** Azure for Students
    - **Resource group name:** `roomies-rg`
    - **Region:** `(Asia Pacific) Central India`
4. Click **Review + create** → **Create**

> **Why one resource group?** Deleting `roomies-rg` will delete ALL Roomies resources at once. This is intentional —
> clean teardown when you move on or migrate.

### 5.2 Install Azure CLI Locally (Optional but Useful)

```bash
# On Ubuntu/Debian (WSL works too)
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash

# Verify
az --version

# Login
az login
# This opens a browser — log in with your student account

# Set default subscription
az account set --subscription "Azure for Students"

# Set default location
az configure --defaults location=centralindia group=roomies-rg
```

You don't have to use the CLI — every step below can also be done via the portal. But the CLI is faster for repeated
operations.

---

## 6. Phase 1 — Database Setup (PostgreSQL + PostGIS)

### 6.1 Create the PostgreSQL Flexible Server

**Via Azure Portal:**

1. Search **Azure Database for PostgreSQL flexible server** → **+ Create**
2. **Basics tab:**
    - Subscription: Azure for Students
    - Resource group: `roomies-rg`
    - Server name: `roomies-db` (this becomes `roomies-db.postgres.database.azure.com`)
    - Region: `Central India`
    - PostgreSQL version: **16**
    - Workload type: **Development** (this pre-selects Burstable)
    - Compute + storage: Click **Configure server**
        - Compute tier: **Burstable**
        - Compute size: **Standard_B1ms** (1 vCore, 2 GiB)
        - Storage size: **32 GiB**
        - Storage auto-growth: **Enabled** ✅
        - Performance tier: **P4** (pre-selected, leave as is)
    - Availability zone: **No preference**
    - High availability: **Disabled** (uncheck)
3. **Authentication tab:**
    - Authentication method: **PostgreSQL authentication only**
    - Admin username: `roomiesadmin` (note this down)
    - Password: Create a strong password (16+ chars, mix of uppercase, lowercase, numbers, symbols). Store it
      immediately — you will put it in Key Vault later.
4. **Networking tab:**
    - Connectivity method: **Public access (allowed IP addresses)**
    - Allow public access: **Yes**
    - Firewall rules: Click **+ Add current client IP address** (this adds your dev machine's IP)
    - Azure services access: **Yes** ✅ (required for App Service to connect)
5. **Security tab:** Leave defaults (SSL enforced is ON by default — keep it)
6. **Backups tab:**
    - Backup retention period: **7 days** (default)
    - Backup redundancy: **Locally redundant** (cheaper, fine for this scale)
7. Click **Review + create** → **Create**

Deployment takes 3–5 minutes.

**Via CLI (equivalent):**

```bash
az postgres flexible-server create \
  --resource-group roomies-rg \
  --name roomies-db \
  --location centralindia \
  --admin-user roomiesadmin \
  --admin-password "YOUR_STRONG_PASSWORD" \
  --sku-name Standard_B1ms \
  --tier Burstable \
  --storage-size 32 \
  --version 16 \
  --public-access 0.0.0.0 \
  --backup-retention 7
```

### 6.2 Create the Application Database

After the server is created:

1. In the portal, go to your server → **Databases** (left menu) → **+ Add**
2. Database name: `roomies_db`
3. Click **Save**

**Via CLI:**

```bash
az postgres flexible-server db create \
  --resource-group roomies-rg \
  --server-name roomies-db \
  --database-name roomies_db
```

### 6.3 Enable PostGIS and pgcrypto Extensions

This is the critical step your schema requires. **Do this before running the schema SQL.**

1. In the portal, go to your server → **Server parameters** (left menu under Settings)
2. Search for `azure.extensions`
3. In the **Value** column, click the dropdown and select both:
    - `POSTGIS`
    - `PGCRYPTO`
4. Click **Save** at the top

> **Why here first?** Azure Flexible Server requires extensions to be allowlisted in the `azure.extensions` parameter
> BEFORE you can run `CREATE EXTENSION` in SQL. If you run the schema SQL first without doing this, PostGIS and pgcrypto
> CREATE EXTENSION calls will fail with a permission error.

Wait 1–2 minutes for the parameter change to apply (no server restart needed for `azure.extensions`).

**Via CLI:**

```bash
az postgres flexible-server parameter set \
  --resource-group roomies-rg \
  --server-name roomies-db \
  --name azure.extensions \
  --value POSTGIS,PGCRYPTO
```

### 6.4 Get the Connection String

From the portal: Server → **Connect** (left menu) → copy the **Connection string** for psql. It looks like:

```
psql "host=roomies-db.postgres.database.azure.com port=5432 dbname=roomies_db user=roomiesadmin password=YOUR_PASSWORD sslmode=require"
```

Your `DATABASE_URL` for the app will be:

```
postgresql://roomiesadmin:YOUR_PASSWORD@roomies-db.postgres.database.azure.com:5432/roomies_db?sslmode=require
```

### 6.5 Add Your Dev Machine IP to Firewall (If Not Done)

If you didn't add your IP in step 6.1, do it now:

Portal → Server → **Networking** → **+ Add current client IP address** → **Save**

Or via CLI:

```bash
# Get your public IP first
curl ifconfig.me

az postgres flexible-server firewall-rule create \
  --resource-group roomies-rg \
  --name roomies-db \
  --rule-name "my-dev-machine" \
  --start-ip-address YOUR.IP.HERE \
  --end-ip-address YOUR.IP.HERE
```

### 6.6 Run the Schema from Your Terminal

Connect from your local terminal using the psql connection string:

```bash
# Test connection first
psql "host=roomies-db.postgres.database.azure.com port=5432 dbname=roomies_db user=roomiesadmin password=YOUR_PASSWORD sslmode=require"

# If connected, you should see: roomies_db=>
# Exit with \q

# Now run the full schema
psql "host=roomies-db.postgres.database.azure.com port=5432 dbname=roomies_db user=roomiesadmin password=YOUR_PASSWORD sslmode=require" \
  -f roomies_db_setup.sql

# Watch for errors. The script is idempotent (IF NOT EXISTS everywhere)
# so it is safe to run again if something fails partway through
```

**After the schema runs, verify PostGIS is working:**

```sql
-- Connect to the DB
psql "..."

-- Verify extensions
SELECT name, installed_version FROM pg_extension WHERE name IN ('postgis', 'pgcrypto');

-- Should output:
--  name     | installed_version
-- ----------+------------------
--  pgcrypto | 1.3
--  postgis  | 3.5.2

-- Test spatial function
SELECT ST_AsText(ST_MakePoint(77.21, 28.63));
-- Should return: POINT(77.21 28.63)
```

### 6.7 Run the Amenity Seed

```bash
# From your project root, with .env.azure pointing at the Azure DB
ENV_FILE=.env.azure node src/db/seeds/amenities.js
```

> You'll create `.env.azure` in Phase 7. If you haven't yet, do the seed after Phase 7.

---

## 7. Phase 2 — Redis Setup

### 7.1 Create Azure Cache for Redis (Basic C0)

**Via Azure Portal:**

1. Search **Azure Cache for Redis** → **+ Create**
2. **Basics tab:**
    - Subscription: Azure for Students
    - Resource group: `roomies-rg`
    - DNS name: `roomies-redis` (becomes `roomies-redis.redis.cache.windows.net`)
    - Location: `Central India`
    - Cache type: Click **Change** → Select **Basic C0 (250 MB)** — this is the cheapest
3. **Networking tab:**
    - Connectivity method: **Public endpoint** (simpler for a small app)
4. **Advanced tab:**
    - Redis version: **6** (or latest available)
    - TLS minimum version: **1.2**
    - Non-TLS port (6379): **Disabled** (your code uses TLS)
5. Click **Review + create** → **Create**

Deployment takes 5–10 minutes.

**Via CLI:**

```bash
az redis create \
  --resource-group roomies-rg \
  --name roomies-redis \
  --location centralindia \
  --sku Basic \
  --vm-size c0 \
  --redis-version 6 \
  --minimum-tls-version 1.2
```

### 7.2 Get the Redis Connection String

Portal → Your Redis → **Access keys** (left menu under Settings)  
Copy the **Primary connection string** — it looks like:

```
roomies-redis.redis.cache.windows.net:6380,password=XXXX,ssl=True,abortConnect=False
```

Your app uses the `redis` npm package which expects a URL format. Convert it to:

```
rediss://:YOUR_ACCESS_KEY@roomies-redis.redis.cache.windows.net:6380
```

Note: `rediss://` (double s) = TLS. The password goes after the colon before the `@`. No username in the URL since Azure
Redis uses password-only auth for Basic/Standard tiers.

> **Important:** Your `bullConnection.js` parses this URL format correctly — it handles `rediss://` protocol and
> extracts `host`, `port`, `password`, and `tls: {}` automatically.

---

## 8. Phase 3 — Blob Storage Setup

### 8.1 Create a Storage Account

**Via Azure Portal:**

1. Search **Storage accounts** → **+ Create**
2. **Basics tab:**
    - Subscription: Azure for Students
    - Resource group: `roomies-rg`
    - Storage account name: `roomiesblob` (globally unique, all lowercase, 3–24 chars, no hyphens)
    - Region: `Central India`
    - Performance: **Standard**
    - Redundancy: **Locally redundant storage (LRS)** — cheapest
3. **Advanced tab:**
    - Allow blob anonymous access: **Enabled** ✅ (needed for photos to be publicly viewable without auth)
    - Minimum TLS version: **TLS 1.2**
4. Leave all other tabs as defaults
5. **Review + create** → **Create**

**Via CLI:**

```bash
az storage account create \
  --resource-group roomies-rg \
  --name roomiesblob \
  --location centralindia \
  --sku Standard_LRS \
  --kind StorageV2 \
  --allow-blob-public-access true \
  --min-tls-version TLS1_2
```

### 8.2 Create the Blob Container

1. Portal → Storage account → **Containers** (left menu under Data storage) → **+ Container**
2. Name: `roomies-uploads`
3. Public access level: **Blob (anonymous read access for blobs only)** — this lets photo URLs be accessed directly
   without any auth headers, which is what your frontend needs to display images
4. Click **Create**

**Via CLI:**

```bash
az storage container create \
  --account-name roomiesblob \
  --name roomies-uploads \
  --public-access blob
```

### 8.3 Get the Connection String

Portal → Storage account → **Access keys** (left menu under Security)  
Click **Show** next to **Connection string** under key1. It looks like:

```
DefaultEndpointsProtocol=https;AccountName=roomiesblob;AccountKey=XXXX;EndpointSuffix=core.windows.net
```

This is your `AZURE_STORAGE_CONNECTION_STRING`.

Your `AZURE_STORAGE_CONTAINER` = `roomies-uploads`

---

## 9. Phase 4 — Key Vault Setup

### 9.1 Create the Key Vault

**Via Azure Portal:**

1. Search **Key vaults** → **+ Create**
2. **Basics tab:**
    - Subscription: Azure for Students
    - Resource group: `roomies-rg`
    - Key vault name: `roomies-kv` (globally unique)
    - Region: `Central India`
    - Pricing tier: **Standard**
    - Days to retain deleted vaults: **7** (minimum)
3. **Access configuration tab:**
    - Permission model: **Azure role-based access control (RBAC)** — recommended over legacy Vault Access Policies
4. **Review + create** → **Create**

**Via CLI:**

```bash
az keyvault create \
  --resource-group roomies-rg \
  --name roomies-kv \
  --location centralindia \
  --sku standard \
  --enable-rbac-authorization true
```

### 9.2 Grant Yourself Admin Access to Key Vault

With RBAC model, you need to assign yourself the Key Vault Administrator role:

1. Portal → Key Vault → **Access control (IAM)** → **+ Add role assignment**
2. Role: **Key Vault Administrator**
3. Members: Select your own Azure account
4. **Review + assign**

**Via CLI:**

```bash
# Get your user Object ID
az ad signed-in-user show --query id -o tsv

# Assign Key Vault Administrator role
az role assignment create \
  --role "Key Vault Administrator" \
  --assignee YOUR_OBJECT_ID \
  --scope $(az keyvault show --name roomies-kv --query id -o tsv)
```

### 9.3 Store All Secrets in Key Vault

Store every secret your app needs. Use the portal (Key Vault → **Secrets** → **+ Generate/Import**) or CLI:

```bash
# Each secret: az keyvault secret set --vault-name roomies-kv --name "SECRET-NAME" --value "value"

az keyvault secret set --vault-name roomies-kv \
  --name "DATABASE-URL" \
  --value "postgresql://roomiesadmin:YOUR_PASSWORD@roomies-db.postgres.database.azure.com:5432/roomies_db?sslmode=require"

az keyvault secret set --vault-name roomies-kv \
  --name "REDIS-URL" \
  --value "rediss://:YOUR_REDIS_KEY@roomies-redis.redis.cache.windows.net:6380"

az keyvault secret set --vault-name roomies-kv \
  --name "JWT-SECRET" \
  --value "$(openssl rand -base64 48)"

az keyvault secret set --vault-name roomies-kv \
  --name "JWT-REFRESH-SECRET" \
  --value "$(openssl rand -base64 48)"

az keyvault secret set --vault-name roomies-kv \
  --name "AZURE-STORAGE-CONNECTION-STRING" \
  --value "DefaultEndpointsProtocol=https;AccountName=roomiesblob;..."

az keyvault secret set --vault-name roomies-kv \
  --name "AZURE-STORAGE-CONTAINER" \
  --value "roomies-uploads"

az keyvault secret set --vault-name roomies-kv \
  --name "EMAIL-PROVIDER" \
  --value "brevo"

az keyvault secret set --vault-name roomies-kv \
  --name "BREVO-SMTP-LOGIN" \
  --value "YOUR_BREVO_SMTP_LOGIN"

az keyvault secret set --vault-name roomies-kv \
  --name "BREVO-SMTP-KEY" \
  --value "YOUR_BREVO_SMTP_KEY"

az keyvault secret set --vault-name roomies-kv \
  --name "BREVO-SMTP-FROM" \
  --value "verified-sender@yourdomain.com"

az keyvault secret set --vault-name roomies-kv \
  --name "GOOGLE-CLIENT-ID" \
  --value "YOUR_GOOGLE_CLIENT_ID"

az keyvault secret set --vault-name roomies-kv \
  --name "GOOGLE-CLIENT-SECRET" \
  --value "YOUR_GOOGLE_CLIENT_SECRET"

az keyvault secret set --vault-name roomies-kv \
  --name "ALLOWED-ORIGINS" \
  --value "https://your-vercel-app.vercel.app"
```

> **JWT secrets:** The `openssl rand -base64 48` command generates a cryptographically secure 64-character random
> string. If you don't have OpenSSL, use any password manager's "generate secure password" feature with length 64 and
> all character types enabled.

---

## 10. Phase 5 — App Service Setup

### 10.1 Create App Service Plan

The plan is the compute resource. The App Service (your actual app) runs on the plan.

**Via Azure Portal:**

1. Search **App Service plans** → **+ Create**
2. **Basics:**
    - Subscription: Azure for Students
    - Resource group: `roomies-rg`
    - Name: `roomies-plan`
    - Operating System: **Linux**
    - Region: `Central India`
    - Pricing plan: **Basic B1** (click **Explore pricing plans** → select B1)
3. **Review + create** → **Create**

**Via CLI:**

```bash
az appservice plan create \
  --resource-group roomies-rg \
  --name roomies-plan \
  --location centralindia \
  --is-linux \
  --sku B1
```

### 10.2 Create the Web App

1. Search **App Services** → **+ Create** → **Web App**
2. **Basics:**
    - Subscription: Azure for Students
    - Resource group: `roomies-rg`
    - Name: `roomies-api` (becomes `roomies-api.azurewebsites.net`)
    - Publish: **Code**
    - Runtime stack: **Node 22 LTS**
    - Operating System: **Linux**
    - Region: `Central India`
    - App Service Plan: Select `roomies-plan`
3. **Deployment tab:**
    - Continuous deployment: **Disable** (we do manual first)
4. **Networking tab:** Leave defaults (public access enabled)
5. **Monitoring tab:**
    - Application Insights: **No** (we use Pino only for now)
6. **Review + create** → **Create**

**Via CLI:**

```bash
az webapp create \
  --resource-group roomies-rg \
  --plan roomies-plan \
  --name roomies-api \
  --runtime "NODE:22-lts"
```

### 10.3 Enable Managed Identity on the App Service

Managed Identity lets your App Service authenticate to Key Vault **without any stored credentials**. It's the secure,
credential-free way to access Key Vault from Azure services.

1. Portal → App Service (`roomies-api`) → **Identity** (left menu under Settings)
2. **System assigned** tab → Status: **On** → Click **Save** → Click **Yes** to confirm
3. Note the **Object (principal) ID** shown — you need it next

**Via CLI:**

```bash
az webapp identity assign \
  --resource-group roomies-rg \
  --name roomies-api

# This returns a principalId — note it down
```

### 10.4 Grant App Service Access to Key Vault

```bash
# Via CLI (replace PRINCIPAL_ID with the Object ID from step 10.3)
az role assignment create \
  --role "Key Vault Secrets User" \
  --assignee PRINCIPAL_ID \
  --scope $(az keyvault show --name roomies-kv --query id -o tsv)
```

**Via Portal:** Key Vault → **Access control (IAM)** → **+ Add role assignment**  
Role: **Key Vault Secrets User**  
Members: Select **Managed identity** → find `roomies-api`

### 10.5 Configure Key Vault References in App Service Settings

Azure App Service supports **Key Vault References** in Application Settings. This means you set an environment variable
to a special syntax that Azure resolves at runtime by fetching from Key Vault. Your app code reads
`process.env.DATABASE_URL` normally — it never knows or cares about Key Vault.

**Via Portal:**  
App Service → **Configuration** (left menu under Settings) → **Application settings** tab → **+ New application
setting**

Add each of these — the syntax is exactly
`@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/SECRET-NAME/)`

| Setting Name                      | Key Vault Reference                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                    | `@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/DATABASE-URL/)`                    |
| `REDIS_URL`                       | `@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/REDIS-URL/)`                       |
| `JWT_SECRET`                      | `@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/JWT-SECRET/)`                      |
| `JWT_REFRESH_SECRET`              | `@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/JWT-REFRESH-SECRET/)`              |
| `AZURE_STORAGE_CONNECTION_STRING` | `@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/AZURE-STORAGE-CONNECTION-STRING/)` |
| `AZURE_STORAGE_CONTAINER`         | `@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/AZURE-STORAGE-CONTAINER/)`         |
| `EMAIL_PROVIDER`                  | `@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/EMAIL-PROVIDER/)`                  |
| `BREVO_SMTP_LOGIN`                | `@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/BREVO-SMTP-LOGIN/)`                |
| `BREVO_SMTP_KEY`                  | `@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/BREVO-SMTP-KEY/)`                  |
| `BREVO_SMTP_FROM`                 | `@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/BREVO-SMTP-FROM/)`                 |
| `GOOGLE_CLIENT_ID`                | `@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/GOOGLE-CLIENT-ID/)`                |
| `GOOGLE_CLIENT_SECRET`            | `@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/GOOGLE-CLIENT-SECRET/)`            |
| `ALLOWED_ORIGINS`                 | `@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/ALLOWED-ORIGINS/)`                 |

Also add these plain (non-secret) settings directly:

| Setting Name             | Value                                                                      |
| ------------------------ | -------------------------------------------------------------------------- |
| `NODE_ENV`               | `production`                                                               |
| `PORT`                   | `8080`                                                                     |
| `STORAGE_ADAPTER`        | `azure`                                                                    |
| `JWT_EXPIRES_IN`         | `15m`                                                                      |
| `JWT_REFRESH_EXPIRES_IN` | `7d`                                                                       |
| `ENV_FILE`               | _(leave empty — not needed in production, app reads process.env directly)_ |

Click **Save** at the top after adding all settings.

> **Note on `PORT`:** Azure App Service on Linux exposes port `8080` by default for Node.js apps. Your `config/env.js`
> already coerces PORT to a number, so `"8080"` in the app setting works correctly.

### 10.6 Configure Startup Command

App Service needs to know how to start your Node.js app in production:

Portal → App Service → **Configuration** → **General settings** tab  
**Startup Command:** `node src/server.js`

Or via CLI:

```bash
az webapp config set \
  --resource-group roomies-rg \
  --name roomies-api \
  --startup-file "node src/server.js"
```

### 10.7 Enable "Always On"

This prevents your API from sleeping between requests (B1 tier includes Always On):

Portal → App Service → **Configuration** → **General settings**  
**Always on:** **On**  
Click **Save**

---

## 11. Phase 6 — Email Setup (Brevo SMTP)

### 11.1 Create / Configure Brevo SMTP Credentials

1. Sign in to Brevo.
2. Open **Settings → SMTP & API → SMTP**.
3. Collect these values:

- **SMTP login** (`BREVO_SMTP_LOGIN`)
- **SMTP key** (`BREVO_SMTP_KEY`, starts with `xsmtpsib-`)
- **Verified sender email** (`BREVO_SMTP_FROM`)

4. Ensure the key you use is the SMTP key (`xsmtpsib-...`), not the API key (`xkeysib-...`).

### 11.2 Verify Sender Identity

1. In Brevo, open **Senders & Domains**.
2. Add and verify the sender address you want to use as `BREVO_SMTP_FROM`.
3. Use that same verified address in production env settings.

### 11.3 Update Key Vault / App Settings

Your codebase uses Nodemailer and supports Brevo directly. Production SMTP host/port are fixed in code as
`smtp-relay.brevo.com:587`; only credentials come from environment variables.

Update Key Vault secrets from Phase 9 with these values:

- `EMAIL-PROVIDER` → `brevo`
- `BREVO-SMTP-LOGIN` → your Brevo SMTP login
- `BREVO-SMTP-KEY` → your Brevo SMTP key
- `BREVO-SMTP-FROM` → your verified sender email

> **No code changes needed.** Keep `EMAIL_PROVIDER=ethereal` for local fake SMTP and switch to `EMAIL_PROVIDER=brevo` in
> production settings.

---

## 12. Phase 7 — Environment Variables & Key Vault Wiring

### 12.1 Create `.env.azure` for Local Testing Against Azure Services

This file lets you run your app locally while connected to Azure resources — useful for verifying the connection strings
before deploying.

Create `.env.azure` in your project root (this file must NEVER be committed to git — add it to `.gitignore`):

```env
# .env.azure — connects local Node.js process to Azure resources
# DO NOT COMMIT THIS FILE

NODE_ENV=production
PORT=3000
ENV_FILE=.env.azure

# Azure PostgreSQL
DATABASE_URL=postgresql://roomiesadmin:YOUR_PASSWORD@roomies-db.postgres.database.azure.com:5432/roomies_db?sslmode=require

# Azure Redis (TLS)
REDIS_URL=rediss://:YOUR_REDIS_KEY@roomies-redis.redis.cache.windows.net:6380

# JWT Secrets (use the same values you put in Key Vault)
JWT_SECRET=YOUR_GENERATED_JWT_SECRET
JWT_REFRESH_SECRET=YOUR_GENERATED_JWT_REFRESH_SECRET
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# Azure Blob Storage
STORAGE_ADAPTER=azure
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=roomiesblob;AccountKey=...
AZURE_STORAGE_CONTAINER=roomies-uploads

# Email via Brevo SMTP
EMAIL_PROVIDER=brevo
BREVO_SMTP_LOGIN=YOUR_BREVO_SMTP_LOGIN
BREVO_SMTP_KEY=YOUR_BREVO_SMTP_KEY
BREVO_SMTP_FROM=verified-sender@yourdomain.com

# CORS — for local testing with Azure
ALLOWED_ORIGINS=http://localhost:5173

# Google OAuth
GOOGLE_CLIENT_ID=YOUR_GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=YOUR_GOOGLE_CLIENT_SECRET
```

### 12.2 Verify `.gitignore` Has These Entries

```gitignore
# Environment files — never commit
.env
.env.local
.env.azure
.env.*.local

# Uploads directory
uploads/

# Node modules
node_modules/
```

### 12.3 Test Locally with Azure Resources

```bash
npm run dev:azure
# Starts server with ENV_FILE=.env.azure

# In another terminal, test health:
curl http://localhost:3000/api/v1/health
# Should return: {"status":"ok","services":{"database":"ok","redis":"ok"}}
```

If database or Redis shows `unhealthy`, check:

1. Firewall rules — your current IP must be whitelisted in PostgreSQL networking
2. Redis connection string format — must start with `rediss://`
3. SSL mode on PostgreSQL — must be `sslmode=require` in the URL

---

## 13. Phase 8 — First Manual Deployment

### 13.1 Prepare the Codebase for Deployment

Before deploying, make sure these are in order:

**a) Add a `.deployment` file to your project root** (tells Azure which folder to deploy from):

```ini
# .deployment
[config]
SCM_DO_BUILD_DURING_DEPLOYMENT=true
```

**b) Verify your `package.json` start script:**

Your current `package.json` has:

```json
"start": "node src/server.js"
```

No extra `start:prod` script is required. Keep the **Startup Command** in App Service as `node src/server.js` (already
done in Phase 10.6).

**c) Add a `.gitignore` for Azure deployment:**

Create `.webignore` in project root (tells Azure's Oryx build system to ignore these):

```
node_modules
.git
.env*
uploads/
```

### 13.2 Deploy via Zip Deploy (Manual Method)

This is the simplest manual deployment approach — package your code as a ZIP and push it to Azure.

**Step 1: Build a ZIP of your project (excluding node_modules)**

```bash
# From your project root
# Make sure you're on the main branch
git checkout main
git pull origin main

# Create deployment ZIP (exclude node_modules, .git, .env files, uploads)
zip -r roomies-deploy.zip . \
  -x "node_modules/*" \
  -x ".git/*" \
  -x ".env*" \
  -x "uploads/*" \
  -x "*.zip"
```

**Step 2: Deploy to Azure using CLI**

```bash
az webapp deploy \
  --resource-group roomies-rg \
  --name roomies-api \
  --src-path roomies-deploy.zip \
  --type zip
```

Azure's **Oryx** build system will:

1. Detect `package.json`
2. Run `npm install --production` automatically (installs only `dependencies`, not `devDependencies`)
3. Set the startup command to `node src/server.js`

**Alternative: Deploy via Azure Portal**

Portal → App Service → **Deployment Center** → **FTPS credentials** tab → use an FTP client  
Or: App Service → **Advanced tools (Kudu)** → **Debug console** → navigate to `site/wwwroot` and drag-drop files

### 13.3 Monitor Startup Logs

After deployment, watch the logs to confirm the app started correctly:

```bash
# Stream live logs from App Service
az webapp log tail \
  --resource-group roomies-rg \
  --name roomies-api

# Or via portal: App Service → Log stream (left menu under Monitoring)
```

Expected successful startup output:

```
PostgreSQL connected
Redis connected
Media processing worker started
Notification delivery worker started
cron:listingExpiry — registered
cron:expiryWarning — registered
cron:hardDeleteCleanup — registered
Server running on port 8080 [production]
```

If you see Key Vault reference errors (`Reference to KeyVault Secret failed`), the most common causes are:

- Managed Identity not enabled (Phase 10.3)
- Role assignment not propagated yet (wait 2–5 minutes after assigning)
- Secret name mismatch (names are case-sensitive)

---

## 14. Phase 9 — Post-Deploy Verification

Run these checks after the first successful deployment.

### 14.1 Health Check

```bash
curl https://roomies-api.azurewebsites.net/api/v1/health
```

Expected:

```json
{
	"status": "ok",
	"timestamp": "2026-04-06T...",
	"services": {
		"database": "ok",
		"redis": "ok"
	}
}
```

### 14.2 Register a Test User

```bash
curl -X POST https://roomies-api.azurewebsites.net/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "TestPass1",
    "role": "student",
    "fullName": "Test User"
  }'
```

### 14.3 Verify Photo Upload Pipeline

1. Create a test listing via the API
2. Upload a test photo using `POST /listings/:id/photos`
3. Check that the `status: "processing"` response comes back quickly (202)
4. Wait 5–10 seconds and call `GET /listings/:id/photos` — the photo should appear with a blob URL
5. Open the blob URL in a browser — it should serve the WebP image directly

### 14.4 Verify Email Sends

1. Register a user with a non-institution email address
2. Call `POST /auth/otp/send` with a valid token
3. In Brevo dashboard → **Transactional → Logs** — you should see a send event
4. Check the email is received (use a real email address for this test)

### 14.5 Check App Service Application Settings

Verify Key Vault references resolved correctly:  
Portal → App Service → **Configuration** → look for **Key Vault Reference Status** column  
All secrets should show a green checkmark and `Resolved` status.

---

## 15. Phase 10 — CI/CD Pipeline (GitHub Actions)

> **Do this after Phase 9 verification confirms the manual deployment is stable.**

### 15.1 Get the App Service Publish Profile

Portal → App Service → **Overview** → **Get publish profile** button → save the downloaded `.PublishSettings` file.

### 15.2 Add the Publish Profile as a GitHub Secret

1. Go to your GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**
2. Name: `AZURE_WEBAPP_PUBLISH_PROFILE`
3. Value: Paste the entire contents of the downloaded `.PublishSettings` file
4. Click **Add secret**

### 15.3 Create the GitHub Actions Workflow

Create `.github/workflows/deploy.yml` in your repo:

```yaml
# .github/workflows/deploy.yml
name: Deploy to Azure App Service

on:
    push:
        branches:
            - main # Triggers on every push to main

jobs:
    deploy:
        runs-on: ubuntu-latest

        steps:
            - name: Checkout code
              uses: actions/checkout@v4

            - name: Setup Node.js
              uses: actions/setup-node@v4
              with:
                  node-version: "22"
                  cache: "npm"

            - name: Install dependencies
              run: npm ci --production

            - name: Deploy to Azure Web App
              uses: azure/webapps-deploy@v3
              with:
                  app-name: roomies-api
                  publish-profile: ${{ secrets.AZURE_WEBAPP_PUBLISH_PROFILE }}
                  package: .
```

### 15.4 How the Pipeline Works

1. You push to `main` branch
2. GitHub Actions checks out the code
3. Runs `npm ci --production` (installs only production dependencies)
4. Deploys the entire working directory to Azure App Service
5. Azure's Oryx build system detects Node.js and runs `npm install` again server-side (this is fine — it ensures all
   deps are present)
6. App Service restarts with the new code

### 15.5 Verify the Pipeline

Make a trivial commit to `main` (e.g., add a comment in `app.js`) and push. Go to **GitHub Actions** tab in your repo
and watch the workflow run. After it succeeds, hit your health endpoint to confirm the new version is live.

---

## 16. Phase 11 — Frontend (Vercel) CORS Wiring

When your React + Vite frontend is deployed on Vercel:

### 16.1 Update ALLOWED_ORIGINS in Key Vault

```bash
az keyvault secret set \
  --vault-name roomies-kv \
  --name "ALLOWED-ORIGINS" \
  --value "https://your-app-name.vercel.app"
```

Then restart the App Service for the new value to take effect:

```bash
az webapp restart --resource-group roomies-rg --name roomies-api
```

If you have multiple Vercel preview URLs (Vercel creates per-branch URLs), set ALLOWED_ORIGINS to a comma-separated
list:

```
https://your-app.vercel.app,https://your-app-git-develop-username.vercel.app
```

Your `app.js` already handles comma-separated origins correctly:

```javascript
ALLOWED_ORIGINS: parsed.data.ALLOWED_ORIGINS ? parsed.data.ALLOWED_ORIGINS.split(",").map((o) => o.trim()) : [];
```

### 16.2 Frontend Environment Variable (Vite)

In your Vercel project settings, add:

```
VITE_API_BASE_URL=https://roomies-api.azurewebsites.net/api/v1
```

In your React code, API calls use:

```javascript
const API_URL = import.meta.env.VITE_API_BASE_URL;
```

---

## 17. Phase 12 — Custom Domain (Future)

When you get a domain via GitHub Education (Namecheap `.me`, or similar):

### 17.1 Add Domain to App Service

Portal → App Service → **Custom domains** → **+ Add custom domain**  
Follow the wizard — you'll add a CNAME record in your domain registrar's DNS settings pointing to
`roomies-api.azurewebsites.net`.

### 17.2 Add Free SSL Certificate

Portal → App Service → **Custom domains** → **Add binding** for your domain → choose **App Service Managed Certificate**
(free, auto-renewing).

### 17.3 Update ALLOWED_ORIGINS

```bash
az keyvault secret set \
  --vault-name roomies-kv \
  --name "ALLOWED-ORIGINS" \
  --value "https://yourdomain.com,https://www.yourdomain.com,https://your-vercel-app.vercel.app"
```

### 17.4 Upgrade Brevo Sender Domain

Once you own a domain, add and authenticate it in Brevo for professional sender addresses like `noreply@yourdomain.com`.
Configure SPF, DKIM, and DMARC at your DNS provider, then switch `BREVO_SMTP_FROM` to the verified address.

---

## 18. Code Changes Required Before Deployment

Your codebase is already well-structured for production. These are the only changes needed:

### 18.1 Remove `ENV_FILE` Dependency from Production Path

In `src/config/env.js`, the top of the file does:

```javascript
const envFile = process.env.ENV_FILE;
if (envFile) {
	dotenv.config({ path: envFile });
} else {
	dotenv.config({ path: ".env.local" });
	dotenv.config({ path: ".env" });
}
```

In production (Azure App Service), `ENV_FILE` is not set, so dotenv tries `.env.local` and `.env`. Neither file exists
on App Service (and that's correct — all config comes from Application Settings/Key Vault). `dotenv.config` simply does
nothing when the file doesn't exist (no error). **No change needed** — this already works correctly in production.

### 18.2 Startup File

Confirmed: `src/server.js` is the entry point. No changes needed. The startup command `node src/server.js` is set
directly in App Service Configuration.

### 18.3 `package.json` — `engines` Field

Add an `engines` field so Azure's Oryx build system uses the correct Node.js version:

```json
{
	"engines": {
		"node": ">=22.0.0"
	}
}
```

### 18.4 Health Check Endpoint Path

Azure App Service health checks can be configured. Your health endpoint is at `/api/v1/health`. Configure it:

Portal → App Service → **Configuration** → **General settings** → **Health check path** → `/api/v1/health`

This tells Azure to consider the app unhealthy and restart it if the health endpoint returns non-2xx for a set number of
consecutive checks.

### 18.5 Static File Serving — Only in Dev

In `app.js`:

```javascript
if (config.STORAGE_ADAPTER === "local") {
	app.use("/uploads", express.static("uploads"));
}
```

This is already guarded correctly — `STORAGE_ADAPTER=azure` in production means the static middleware is never
registered. **No change needed.**

---

## 19. Security Checklist

Review each item before go-live:

- [ ] **No `.env` files committed to git** — verify with `git log --all -- '.env*'`
- [ ] **PostgreSQL firewall rules** — only your dev IP + Azure Services access. Remove `0.0.0.0` if added during
      testing.
- [ ] **Blob container is `blob` public access** (not `container`) — only individual blob URLs are public, not container
      listing
- [ ] **HTTPS enforced on App Service** — Portal → App Service → **TLS/SSL settings** → **HTTPS Only: On**
- [ ] **Key Vault soft-delete enabled** — enabled by default since 2020, but verify
- [ ] **Managed Identity is the only credential** — App Service accesses Key Vault via Managed Identity, not stored keys
- [ ] **`DUMMY_HASH` never removed from `auth.service.js`** — timing equalization on unknown email login
- [ ] **`NODE_ENV=production` set** — this activates secure cookie flags
      (`httpOnly: true, secure: true, sameSite: 'strict'`)
- [ ] **`ALLOWED_ORIGINS` set to your Vercel domain only** — not `*`
- [ ] **Redis TLS enabled** — your connection string starts with `rediss://` (double s)
- [ ] **PostgreSQL SSL required** — `sslmode=require` in connection string
- [ ] **App Service Always On: enabled** — prevents cold starts from token expiry

---

## 20. Cost Monitoring

### Set Up Budget Alerts

Prevent surprise credit depletion:

1. Portal → **Cost Management + Billing** → **Budgets** → **+ Add**
2. Scope: Your subscription
3. Amount: ₹1,500 (slightly above your ₹1,350 ceiling)
4. Alert conditions: 80% spent (₹1,200) and 100% spent (₹1,500)
5. Alert recipients: Your email

### View Current Spend

Portal → **Cost Management** → **Cost analysis** → filter by resource group `roomies-rg`  
This shows you exactly which service is spending most of your credits.

### Stop DB When Not Needed (Dev Cycle)

Azure PostgreSQL Flexible Server has a **Stop** feature. When stopped, you pay only for storage (not compute). During
active development gaps or holidays:

Portal → PostgreSQL server → **Overview** → **Stop**

> **Warning:** The server auto-restarts after 7 days if not manually started. When stopped, your App Service will still
> be running and health checks will fail — set health check notifications to avoid alarm.

---

## 21. Scaling Path (When Traffic Grows)

When Roomies grows beyond 100 users/day, upgrade in this order:

| Trigger                                  | Upgrade                                                  | Cost Impact         |
| ---------------------------------------- | -------------------------------------------------------- | ------------------- |
| DB CPU consistently > 70%                | PostgreSQL B1ms → B2ms                                   | +₹1,050/month       |
| Redis OOM errors or high latency         | Redis C0 → C1 (1GB)                                      | +₹1,050/month       |
| App Service CPU > 80% or memory pressure | B1 → B2 or S1                                            | +₹630–₹1,260/month  |
| Redis uptime required (SLA needed)       | Redis Basic → Standard                                   | +₹1,050/month       |
| Multiple backend instances needed        | App Service B1 → S1 (enables deployment slots + scaling) | +₹630/month         |
| Photo serving is slow globally           | Add Azure CDN in front of Blob Storage                   | ~₹50/month          |
| Real-time WebSocket (Phase 6)            | Sticky sessions on App Service S2+                       | Tier upgrade needed |

**Note:** You can scale up PostgreSQL and Redis without any downtime (Flexible Server applies SKU changes in-place). App
Service plan changes are also live with a brief restart.

---

## Appendix A — All Azure Resource Names Summary

| Resource            | Name              | URL/Endpoint                                                 |
| ------------------- | ----------------- | ------------------------------------------------------------ |
| Resource Group      | `roomies-rg`      | —                                                            |
| PostgreSQL Server   | `roomies-db`      | `roomies-db.postgres.database.azure.com`                     |
| PostgreSQL Database | `roomies_db`      | —                                                            |
| Redis Cache         | `roomies-redis`   | `roomies-redis.redis.cache.windows.net:6380`                 |
| Storage Account     | `roomiesblob`     | `roomiesblob.blob.core.windows.net`                          |
| Blob Container      | `roomies-uploads` | `https://roomiesblob.blob.core.windows.net/roomies-uploads/` |
| Key Vault           | `roomies-kv`      | `https://roomies-kv.vault.azure.net/`                        |
| App Service Plan    | `roomies-plan`    | —                                                            |
| App Service         | `roomies-api`     | `https://roomies-api.azurewebsites.net`                      |
| Email Provider      | `Brevo SMTP`      | `smtp-relay.brevo.com:587`                                   |

---

## Appendix B — Quick Reference: Useful CLI Commands

```bash
# View all resources in the group
az resource list --resource-group roomies-rg --output table

# Check App Service logs
az webapp log tail --resource-group roomies-rg --name roomies-api

# Restart App Service
az webapp restart --resource-group roomies-rg --name roomies-api

# Stop PostgreSQL (save credits during breaks)
az postgres flexible-server stop --resource-group roomies-rg --name roomies-db

# Start PostgreSQL
az postgres flexible-server start --resource-group roomies-rg --name roomies-db

# Update a Key Vault secret
az keyvault secret set --vault-name roomies-kv --name "SECRET-NAME" --value "new-value"

# List Key Vault secrets
az keyvault secret list --vault-name roomies-kv --output table

# Show current monthly cost estimate
az consumption usage list --billing-period-name $(date +%Y%m) --output table

# Deploy latest code (zip deploy)
zip -r roomies-deploy.zip . -x "node_modules/*" -x ".git/*" -x ".env*" -x "uploads/*" -x "*.zip"
az webapp deploy --resource-group roomies-rg --name roomies-api --src-path roomies-deploy.zip --type zip
```

---

_Last updated: April 6, 2026_  
_Architecture: Central India region, Azure for Students subscription_  
_Stack version: Node.js 22 LTS, PostgreSQL 16, Redis 6, PostGIS 3.5.2_
