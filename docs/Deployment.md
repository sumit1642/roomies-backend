# Roomies — Azure Deployment Guide (2026 Edition)

> **Status:** Replace `docs/Deployment.md` entirely with this file.  
> **Written for:** Azure for Students subscription, no custom domain, API-only, ≤50 users/day.  
> **Last researched:** April 2026

---

## Part 0 — Critical Decisions Before You Start

Before touching the Azure portal, you need to understand five decisions that override everything in the old
`docs/Deployment.md`.

### Decision 1: No Docker Required

Azure App Service for Node.js supports **zip-based code deployment without Docker**. You zip your source, push it,
Azure's Oryx build system runs `npm install` automatically. Docker adds operational complexity and costs RAM you don't
have on B1. Skip it entirely.

### Decision 2: Upstash Redis (NOT Azure Cache for Redis)

The old plan used Azure Cache for Redis Basic C0 at ~₹1,050/month. This is your single biggest cost after PostgreSQL.

However, **BullMQ is NOT compatible with the Upstash free tier** (500K commands/month). Here is why:

BullMQ uses a blocking Redis command called `BZPOPMIN` to wait for new jobs. Even with zero user traffic, each of your 3
workers (media, notification, email) calls `BZPOPMIN` roughly once every 5 seconds. That's:

```
3 workers × 12 calls/min × 60 min × 24 hr × 30 days = ~1,555,200 commands/month
```

The 500K free tier is exhausted in **~10 days** just from idle polling. When it runs out, Redis gets rate-limited and
BullMQ stops processing jobs entirely.

**Use the Upstash Fixed 250MB plan at $10/month (~₹840/month).** Upstash explicitly documents this as the correct plan
for BullMQ. It is ₹210/month cheaper than Azure Redis.

### Decision 3: Single Process (No Worker Separation)

With ≤50 serious users/day, running Express + BullMQ workers + cron jobs in one App Service B1 process is correct.
Worker separation requires multiple App Service instances or Container Apps, which would double or triple your compute
cost. The B1 has 1.75GB RAM; your app uses roughly 200–350MB at idle. You have headroom.

### Decision 4: Zero Code Changes for Upstash

Your codebase already handles everything correctly. Both `src/cache/client.js` (node-redis v5) and
`src/workers/bullConnection.js` (BullMQ ioredis) already parse `rediss://` TLS URLs and extract host, port, password,
and TLS settings automatically. The only change is the `REDIS_URL` environment variable value.

### Decision 5: Revised Realistic Budget

| Service                        | Tier                     | Price/month                 |
| ------------------------------ | ------------------------ | --------------------------- |
| Azure App Service B1 Linux     | Basic (1 vCore, 1.75GB)  | ~₹1,092 (~$13)              |
| Azure PostgreSQL Flexible B1ms | Burstable (1 vCore, 2GB) | ~₹1,043 (~$12.41) + storage |
| PostgreSQL storage (32GB P4)   | Provisioned SSD          | ~₹280 (~$3.33)              |
| Upstash Redis Fixed 250MB      | Fixed plan               | ~₹840 (~$10)                |
| Azure Blob Storage LRS         | Hot tier, first 5GB      | ~₹42 (~$0.50)               |
| Azure Key Vault Standard       | ~5K ops/month            | ~₹5 (~$0.06)                |
| **Total**                      |                          | **~₹3,302/month**           |

With ₹9,480 credits: **~2.9 months of runtime.**

Azure for Students credits renew annually. By the time they run out, you will have real users and can justify either
renewal or a paid plan. Stop the PostgreSQL server when you are not developing (the stop/start feature saves compute
cost, you only pay for storage).

---

## Part 1 — Architecture Overview

```
Internet
    │
    ▼
[Azure App Service B1 Linux — Central India]
  Node.js 22 LTS
  src/server.js — Express + BullMQ workers + node-cron (single process)
    │
    ├───────────────────────────────────────────┐
    │                                           │
    ▼                                           ▼
[Azure PostgreSQL Flexible B1ms]         [Upstash Redis Fixed 250MB]
 PostgreSQL 16 + PostGIS                  Mumbai or Singapore region
 Central India                            rediss:// TLS connection
    │
    ▼
[Azure Blob Storage Standard LRS]
 Central India
 Container: roomies-uploads (public blob read)
    │
    ▼
[Azure Key Vault Standard]
 Stores all secrets
 App Service reads via Managed Identity (zero credentials stored)
    │
    ▼
[Brevo SMTP Relay]
 smtp-relay.brevo.com:587
 Transactional email (OTPs, verification)
```

API base URL (no custom domain): `https://roomies-api.azurewebsites.net/api/v1`

---

## Part 2 — Pre-Deployment Checklist

Do these before you open the Azure portal.

### 2.1 Create Accounts

- [ ] **Azure portal** — go to [portal.azure.com](https://portal.azure.com), sign in with your student email. You should
      see ₹9,480 (or equivalent) in credits under "Azure for Students."
- [ ] **Upstash account** — go to [upstash.com](https://upstash.com), sign up free.
- [ ] **Brevo account** — go to [brevo.com](https://brevo.com), sign up free. Free tier allows 300 emails/day forever.

### 2.2 Gather Credentials Before Starting

You will need these handy during setup. Write them somewhere secure:

```
Azure PostgreSQL admin username: roomiesadmin
Azure PostgreSQL admin password: [generate: 16+ chars, mixed case, numbers, symbols]
JWT_SECRET: [generate: openssl rand -base64 48]
JWT_REFRESH_SECRET: [generate: openssl rand -base64 48]
```

To generate secrets locally:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

---

## Part 3 — Step-by-Step Azure Setup

### Phase 1: Resource Group

A resource group is a logical container. Deleting it later removes everything at once — useful for cleanup.

**Portal steps:**

1. Go to [portal.azure.com](https://portal.azure.com)
2. Search for **"Resource groups"** in the top search bar
3. Click **+ Create**
4. Fill in:
    - Subscription: `Azure for Students`
    - Resource group name: `roomies-rg`
    - Region: `Central India`
5. Click **Review + create** → **Create**

**CLI equivalent (optional, install Azure CLI):**

```bash
az login
az account set --subscription "Azure for Students"
az configure --defaults location=centralindia group=roomies-rg
az group create --name roomies-rg --location centralindia
```

---

### Phase 2: PostgreSQL Database

#### 2.1 Create the Server

**Portal steps:**

1. Search **"Azure Database for PostgreSQL flexible server"**
2. Click **+ Create** → **Flexible server**
3. **Basics tab:**
    - Resource group: `roomies-rg`
    - Server name: `roomies-db` → URL becomes `roomies-db.postgres.database.azure.com`
    - Region: `Central India`
    - PostgreSQL version: **16**
    - Workload type: **Development** (pre-selects Burstable tier)
    - Click **Configure server**:
        - Compute tier: **Burstable**
        - Compute size: **Standard_B1ms** (1 vCore, 2 GiB)
        - Storage size: **32 GiB**
        - Storage auto-grow: **Enabled**
    - Availability zone: **No preference**
    - High availability: **Disabled**
4. **Authentication tab:**
    - Authentication method: **PostgreSQL authentication only**
    - Admin username: `roomiesadmin`
    - Password: your generated strong password
5. **Networking tab:**
    - Connectivity: **Public access (allowed IP addresses)**
    - Allow public access: **Yes**
    - Click **+ Add current client IP address** (adds your dev machine)
    - Azure services access: **Yes** ← critical, allows App Service to connect
6. **Security tab:** Leave SSL enforced ON (default)
7. **Backups tab:**
    - Retention: **7 days**
    - Redundancy: **Locally redundant**
8. Click **Review + create** → **Create** (takes 3–5 minutes)

#### 2.2 Enable PostGIS and pgcrypto Extensions

Azure requires allowlisting extensions before `CREATE EXTENSION` works in SQL.

**Portal steps:**

1. Go to your PostgreSQL server → left menu → **Server parameters**
2. Search for: `azure.extensions`
3. In the Value dropdown, select: **POSTGIS** and **PGCRYPTO**
4. Click **Save** at the top
5. Wait 1–2 minutes

**CLI equivalent:**

```bash
az postgres flexible-server parameter set \
  --resource-group roomies-rg \
  --server-name roomies-db \
  --name azure.extensions \
  --value POSTGIS,PGCRYPTO
```

#### 2.3 Create Application Database

**Portal steps:**

1. Go to server → **Databases** (left menu) → **+ Add**
2. Database name: `roomies_db`
3. Click **Save**

**CLI equivalent:**

```bash
az postgres flexible-server db create \
  --resource-group roomies-rg \
  --server-name roomies-db \
  --database-name roomies_db
```

#### 2.4 Run Your Schema

Your connection string will be:

```
postgresql://roomiesadmin:YOUR_PASSWORD@roomies-db.postgres.database.azure.com:5432/roomies_db?sslmode=require
```

From your local terminal:

```bash
# Test connection first
psql "host=roomies-db.postgres.database.azure.com port=5432 dbname=roomies_db user=roomiesadmin password=YOUR_PASSWORD sslmode=require"
# If it connects, exit with \q

# Run the schema
psql "host=roomies-db.postgres.database.azure.com port=5432 dbname=roomies_db user=roomiesadmin password=YOUR_PASSWORD sslmode=require" \
  -f migrations/001_initial_schema.sql

psql "host=roomies-db.postgres.database.azure.com port=5432 dbname=roomies_db user=roomiesadmin password=YOUR_PASSWORD sslmode=require" \
  -f migrations/002_verification_event_outbox.sql

# Verify PostGIS works
psql "..." -c "SELECT ST_AsText(ST_MakePoint(77.21, 28.63));"
# Should print: POINT(77.21 28.63)
```

**Run migrations via the npm script** (requires `DATABASE_URL` in your local env):

```bash
ENV_FILE=.env.azure node src/db/migrate.js
# or just psql as shown above — both work fine
```

#### 2.5 Run the Amenity Seed

After setting up `.env.azure` in Phase 7:

```bash
npm run seed:amenities
```

---

### Phase 3: Upstash Redis

#### 3.1 Create the Database

1. Go to [console.upstash.com](https://console.upstash.com)
2. Click **Create database**
3. Fill in:
    - Name: `roomies-redis`
    - Type: **Regional** (not Global)
    - Region: **AWS ap-south-1 (Mumbai)** — closest to Central India Azure
    - Plan: **Fixed 250MB** ← critical, do NOT use Pay-as-you-go for BullMQ
    - TLS: **Enabled** (default, leave on)
4. Click **Create**

#### 3.2 Get Connection Details

From the database overview page, click **Connect** and copy:

- **Endpoint**: something like `amusing-panda-12345.upstash.io`
- **Password**: a long random string

Your `REDIS_URL` will be:

```
rediss://default:YOUR_UPSTASH_PASSWORD@amusing-panda-12345.upstash.io:6380
```

The format is: `rediss://default:PASSWORD@ENDPOINT:6380`

- `rediss://` (double-s) = TLS
- `default` = username (Upstash always uses "default")
- Port `6380` = TLS port

**Verify your existing code handles this:** `bullConnection.js` and `cache/client.js` both parse this URL format
correctly. No code changes needed.

---

### Phase 4: Blob Storage

#### 4.1 Create Storage Account

**Portal steps:**

1. Search **"Storage accounts"** → **+ Create**
2. **Basics:**
    - Resource group: `roomies-rg`
    - Storage account name: `roomiesblob` (must be globally unique, lowercase, no hyphens)
    - Region: `Central India`
    - Performance: **Standard**
    - Redundancy: **Locally redundant storage (LRS)**
3. **Advanced tab:**
    - Allow blob anonymous access: **Enabled** ← required for photo URLs to be publicly viewable
    - Minimum TLS version: **TLS 1.2**
4. **Review + create** → **Create**

#### 4.2 Create the Blob Container

1. Storage account → **Containers** (left menu under Data storage) → **+ Container**
2. Name: `roomies-uploads`
3. Public access level: **Blob (anonymous read access for blobs only)**
4. Click **Create**

#### 4.3 Get the Connection String

1. Storage account → **Access keys** (left menu under Security)
2. Click **Show** next to **Connection string** under key1
3. Copy the full string — this is `AZURE_STORAGE_CONNECTION_STRING`

Example format:

```
DefaultEndpointsProtocol=https;AccountName=roomiesblob;AccountKey=XXXX==;EndpointSuffix=core.windows.net
```

---

### Phase 5: Key Vault

Key Vault stores all secrets. App Service reads them via Managed Identity — you never store raw credentials in App
Service settings.

#### 5.1 Create the Key Vault

**Portal steps:**

1. Search **"Key vaults"** → **+ Create**
2. **Basics:**
    - Resource group: `roomies-rg`
    - Key vault name: `roomies-kv` (must be globally unique)
    - Region: `Central India`
    - Pricing tier: **Standard**
3. **Access configuration tab:**
    - Permission model: **Azure role-based access control (RBAC)**
4. **Review + create** → **Create**

#### 5.2 Grant Yourself Admin Access

1. Go to your Key Vault → **Access control (IAM)** → **+ Add role assignment**
2. Role: **Key Vault Administrator**
3. Assign access to: **User, group, or service principal**
4. Select your own Azure account
5. Click **Review + assign**

#### 5.3 Store All Secrets

Go to Key Vault → **Secrets** → **+ Generate/Import** for each of these:

| Secret Name                       | Value                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `DATABASE-URL`                    | `postgresql://roomiesadmin:PASSWORD@roomies-db.postgres.database.azure.com:5432/roomies_db?sslmode=require` |
| `REDIS-URL`                       | `rediss://default:UPSTASH_PASSWORD@YOUR-ENDPOINT.upstash.io:6380`                                           |
| `JWT-SECRET`                      | your generated 64-char secret                                                                               |
| `JWT-REFRESH-SECRET`              | your second generated 64-char secret                                                                        |
| `AZURE-STORAGE-CONNECTION-STRING` | the full connection string from Phase 4.3                                                                   |
| `AZURE-STORAGE-CONTAINER`         | `roomies-uploads`                                                                                           |
| `EMAIL-PROVIDER`                  | `brevo`                                                                                                     |
| `BREVO-SMTP-LOGIN`                | your Brevo SMTP login email                                                                                 |
| `BREVO-SMTP-KEY`                  | your Brevo SMTP key (starts with `xsmtpsib-`)                                                               |
| `BREVO-SMTP-FROM`                 | your verified sender email in Brevo                                                                         |
| `GOOGLE-CLIENT-ID`                | your Google OAuth client ID (or skip if not ready)                                                          |
| `GOOGLE-CLIENT-SECRET`            | your Google OAuth client secret (or skip if not ready)                                                      |
| `ALLOWED-ORIGINS`                 | `*` for now (tighten later when frontend is deployed)                                                       |

**Naming rules:** Use hyphens in secret names (Key Vault convention). App Service environment variable names use
underscores. Azure maps `DATABASE-URL` secret → `DATABASE_URL` environment variable via Key Vault references.

**CLI equivalent (faster for bulk entry):**

```bash
# Replace values with your actual credentials
az keyvault secret set --vault-name roomies-kv --name "DATABASE-URL" \
  --value "postgresql://roomiesadmin:PASSWORD@roomies-db.postgres.database.azure.com:5432/roomies_db?sslmode=require"

az keyvault secret set --vault-name roomies-kv --name "REDIS-URL" \
  --value "rediss://default:PASS@ENDPOINT.upstash.io:6380"

az keyvault secret set --vault-name roomies-kv --name "JWT-SECRET" \
  --value "$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")"

az keyvault secret set --vault-name roomies-kv --name "JWT-REFRESH-SECRET" \
  --value "$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")"

az keyvault secret set --vault-name roomies-kv --name "AZURE-STORAGE-CONNECTION-STRING" \
  --value "DefaultEndpointsProtocol=https;AccountName=roomiesblob;AccountKey=XXXX;EndpointSuffix=core.windows.net"

az keyvault secret set --vault-name roomies-kv --name "AZURE-STORAGE-CONTAINER" --value "roomies-uploads"
az keyvault secret set --vault-name roomies-kv --name "EMAIL-PROVIDER" --value "brevo"
az keyvault secret set --vault-name roomies-kv --name "BREVO-SMTP-LOGIN" --value "your-login@smtp-brevo.com"
az keyvault secret set --vault-name roomies-kv --name "BREVO-SMTP-KEY" --value "xsmtpsib-xxxxx"
az keyvault secret set --vault-name roomies-kv --name "BREVO-SMTP-FROM" --value "noreply@yourdomain.com"
az keyvault secret set --vault-name roomies-kv --name "ALLOWED-ORIGINS" --value "*"
```

---

### Phase 6: App Service

#### 6.1 Create App Service Plan

**Portal steps:**

1. Search **"App Service plans"** → **+ Create**
2. Resource group: `roomies-rg`
3. Name: `roomies-plan`
4. Operating System: **Linux**
5. Region: `Central India`
6. Pricing plan: **Basic B1** (click "Explore pricing plans" to select it)
7. **Review + create** → **Create**

#### 6.2 Create the Web App

1. Search **"App Services"** → **+ Create** → **Web App**
2. **Basics:**
    - Resource group: `roomies-rg`
    - Name: `roomies-api` → URL: `https://roomies-api.azurewebsites.net`
    - Publish: **Code**
    - Runtime stack: **Node 22 LTS**
    - Operating System: **Linux**
    - Region: `Central India`
    - App Service Plan: `roomies-plan`
3. **Deployment tab:** Continuous deployment: **Disable** (manual first)
4. **Monitoring tab:** Application Insights: **No**
5. **Review + create** → **Create**

#### 6.3 Enable Managed Identity

This lets App Service talk to Key Vault without any stored credentials.

1. App Service (`roomies-api`) → **Identity** (left menu under Settings)
2. **System assigned** tab → Status: **On** → **Save** → confirm with **Yes**
3. Note the **Object (principal) ID** that appears — you need it next

#### 6.4 Grant App Service Access to Key Vault

1. Go to Key Vault → **Access control (IAM)** → **+ Add role assignment**
2. Role: **Key Vault Secrets User**
3. Assign access to: **Managed identity**
4. Select your App Service (`roomies-api`)
5. **Review + assign**

Wait 2–3 minutes for Azure RBAC propagation before the next step.

#### 6.5 Configure Application Settings

App Service reads secrets via Key Vault References — a special syntax that Azure resolves at startup by fetching from
Key Vault. Your code just reads `process.env.DATABASE_URL` normally.

**Portal steps:**

1. App Service → **Configuration** (left menu) → **Application settings** tab
2. Click **+ New application setting** for each row below:

**Key Vault References (copy-paste the @Microsoft.KeyVault(...) value exactly):**

| Name                              | Value                                                                                                        |
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
| `ALLOWED_ORIGINS`                 | `@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/ALLOWED-ORIGINS/)`                 |

**Plain settings (add these directly, no Key Vault):**

| Name                     | Value        |
| ------------------------ | ------------ |
| `NODE_ENV`               | `production` |
| `PORT`                   | `8080`       |
| `STORAGE_ADAPTER`        | `azure`      |
| `JWT_EXPIRES_IN`         | `15m`        |
| `JWT_REFRESH_EXPIRES_IN` | `7d`         |
| `TRUST_PROXY`            | `1`          |

3. Click **Save** at the top of the page

#### 6.6 Set Startup Command and General Settings

1. App Service → **Configuration** → **General settings** tab
2. **Startup Command:** `node src/server.js`
3. **Always On:** **On**
4. Click **Save**

#### 6.7 Enable HTTPS Only

1. App Service → **TLS/SSL settings** (left menu)
2. **HTTPS Only:** **On**
3. Click **Save**

#### 6.8 Configure Health Check

1. App Service → **Configuration** → **General settings**
2. **Health check path:** `/api/v1/health`
3. Click **Save**

---

### Phase 7: Brevo Email Setup

1. Log in to [brevo.com](https://brevo.com)
2. Go to **Settings** → **SMTP & API** → **SMTP**
3. Copy your **SMTP login** (e.g., `12345xyz@smtp-brevo.com`) → this is `BREVO_SMTP_LOGIN`
4. Under **SMTP Keys**, generate a new key (starts with `xsmtpsib-`) → this is `BREVO_SMTP_KEY`
5. Go to **Senders & Domains** → add and verify your sender email → this is `BREVO_SMTP_FROM`

Common mistake: confusing the API key (`xkeysib-`) with the SMTP key (`xsmtpsib-`). They look similar but are different
credentials. Your app already has a startup guard that catches this mistake and exits with a clear error message.

---

### Phase 8: Create `.env.azure` for Local Testing

This lets you test your app locally against all Azure services before deploying. Never commit this file.

Create `project_root/.env.azure`:

```env
# .env.azure — local testing against Azure services
# ADD TO .gitignore IMMEDIATELY — never commit

NODE_ENV=production
PORT=3000
ENV_FILE=.env.azure

# Azure PostgreSQL
DATABASE_URL=postgresql://roomiesadmin:YOUR_PASSWORD@roomies-db.postgres.database.azure.com:5432/roomies_db?sslmode=require

# Upstash Redis (Fixed 250MB plan)
REDIS_URL=rediss://default:YOUR_UPSTASH_PASSWORD@YOUR-ENDPOINT.upstash.io:6380

# JWT
JWT_SECRET=YOUR_JWT_SECRET_FROM_KEYVAULT
JWT_REFRESH_SECRET=YOUR_JWT_REFRESH_SECRET_FROM_KEYVAULT
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# Azure Blob Storage
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

# Google OAuth
GOOGLE_CLIENT_ID=YOUR_CLIENT_ID
GOOGLE_CLIENT_SECRET=YOUR_CLIENT_SECRET

TRUST_PROXY=false
```

Verify it works locally:

```bash
npm run dev:azure
# In another terminal:
curl http://localhost:3000/api/v1/health
# Expected: {"status":"ok","services":{"database":"ok","redis":"ok"}}
```

If the health check fails:

- `database: "unhealthy"` → your dev machine IP is not whitelisted in PostgreSQL firewall rules. Go to PostgreSQL →
  Networking → Add your current IP.
- `redis: "unhealthy"` → verify the Upstash URL format. It must start with `rediss://` (double-s).

---

## Part 4 — First Deployment

### Step 1: Prepare the Code

Add a `.webignore` to your project root. This tells Azure's Oryx build system what to skip:

```
node_modules
.git
.env*
uploads/
*.zip
```

Verify `package.json` already has (it does from your codebase):

```json
"engines": { "node": ">=22.0.0" }
```

### Step 2: Create the Deployment ZIP

```bash
# From project root
zip -r roomies-deploy.zip . \
  -x "node_modules/*" \
  -x ".git/*" \
  -x ".env*" \
  -x "uploads/*" \
  -x "*.zip"
```

### Step 3: Deploy

```bash
az webapp deploy \
  --resource-group roomies-rg \
  --name roomies-api \
  --src-path roomies-deploy.zip \
  --type zip
```

Or via the portal:

1. App Service → **Deployment Center** → **FTPS credentials** tab
2. Use an FTP client to upload, or
3. App Service → **Advanced Tools (Kudu)** → **Debug console** → drag-drop files to `site/wwwroot`

### Step 4: Watch the Startup Logs

```bash
az webapp log tail --resource-group roomies-rg --name roomies-api
```

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
Server running on port 8080 [production]
```

**If you see "Reference to KeyVault Secret failed":**

- The Managed Identity RBAC propagation takes up to 5 minutes
- Verify Managed Identity is On in App Service → Identity
- Verify the Key Vault Secrets User role was assigned to the App Service identity
- Check for typos in the secret name inside the `@Microsoft.KeyVault(...)` reference

---

## Part 5 — Post-Deployment Verification

Run these in order. Stop if any fail before moving on.

### 5.1 Health Check

```bash
curl https://roomies-api.azurewebsites.net/api/v1/health
```

Expected: `{"status":"ok","services":{"database":"ok","redis":"ok"}}`

### 5.2 Test Registration

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

Expected: `201` with a `data.user` object and `sid`.

### 5.3 Verify Photo Upload Pipeline

1. Create a listing via API
2. Upload a photo via `POST /listings/:id/photos` (multipart)
3. Check the immediate response is `202` with `status: "processing"`
4. Wait 10 seconds, call `GET /listings/:id/photos`
5. A photo with a `blob.core.windows.net` URL should appear
6. Open that URL in a browser — it should serve a WebP image

### 5.4 Verify Email Delivery

1. Register with a real email address
2. Call `POST /api/v1/auth/otp/send` (requires auth token from registration)
3. Check Brevo dashboard → **Transactional** → **Logs** for a delivery event
4. Check your inbox for the OTP email

### 5.5 Check Key Vault Reference Status

Portal → App Service → **Configuration** → look at the **Source** column for your Key Vault references. Each should show
a green checkmark and **Key vault reference** status. If any show a red error, click on it to see the reason.

---

## Part 6 — CI/CD with GitHub Actions

Do this after manual deployment is stable.

### 6.1 Get Publish Profile

Portal → App Service → **Overview** → **Get publish profile** button → save the file.

### 6.2 Add to GitHub Secrets

GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

- Name: `AZURE_WEBAPP_PUBLISH_PROFILE`
- Value: entire contents of the downloaded `.PublishSettings` file

### 6.3 Create Workflow File

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Azure App Service

on:
    push:
        branches:
            - main

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

            - name: Install production dependencies
              run: npm ci --production

            - name: Deploy to Azure Web App
              uses: azure/webapps-deploy@v3
              with:
                  app-name: roomies-api
                  publish-profile: ${{ secrets.AZURE_WEBAPP_PUBLISH_PROFILE }}
                  package: .
```

Push to `main` → GitHub Actions tab → watch the deployment run → hit `/health` to confirm.

---

## Part 7 — Cost Management

### 7.1 Set Budget Alert

1. Portal → **Cost Management + Billing** → **Budgets** → **+ Add**
2. Scope: Azure for Students subscription
3. Amount: ₹3,500
4. Alert at 80% (₹2,800) and 100% (₹3,500)
5. Email: your address

### 7.2 Stop PostgreSQL When Not Needed

When you are not actively working on the project for more than a day:

```bash
az postgres flexible-server stop --resource-group roomies-rg --name roomies-db
```

When you resume:

```bash
az postgres flexible-server start --resource-group roomies-rg --name roomies-db
```

When stopped, you only pay for storage (~₹280/month), not compute (~₹1,043). Over a week-long break, this saves ~₹240.

**Warning:** Azure auto-restarts the server after 7 days regardless of your stop command. Set a reminder if you are
taking a longer break.

### 7.3 Monitor Spend

```bash
az resource list --resource-group roomies-rg --output table
```

Portal → **Cost Management** → **Cost analysis** → filter by `roomies-rg` to see a per-service breakdown.

---

## Part 8 — Common Issues and Fixes

| Symptom                                        | Cause                              | Fix                                                                                                                   |
| ---------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `redis: "unhealthy"` on health check           | Wrong REDIS_URL format             | Must start with `rediss://` (not `redis://`)                                                                          |
| App starts then crashes in < 30s               | Key Vault references not resolving | Check RBAC propagation, wait 5 min, restart app                                                                       |
| `TypeError: config.GOOGLE_CLIENT_ID undefined` | Missing optional env var           | Add `GOOGLE_CLIENT_ID` to Key Vault if you want OAuth; if not using OAuth yet, the app handles `undefined` gracefully |
| Photos not processing                          | BullMQ media worker not starting   | Check logs for `Media processing worker started`; verify Redis URL                                                    |
| `BullMQ BZPOPMIN timeout` errors in logs       | Normal Redis round-trip variance   | Increase `commandTimeout` in ioredis config or ignore — it self-recovers                                              |
| OTP emails not arriving                        | Brevo sender not verified          | Verify the `BREVO_SMTP_FROM` email address in Brevo → Senders & Domains                                               |
| `ECONNREFUSED` from PostgreSQL                 | Your dev IP not in firewall        | Portal → PostgreSQL → Networking → Add current client IP                                                              |
| App works locally but fails on Azure           | `NODE_ENV=production` not set      | Verify `NODE_ENV=production` in App Service settings                                                                  |

---

## Part 9 — All Resource Names Summary

| Resource            | Name              | URL/Endpoint                                                 |
| ------------------- | ----------------- | ------------------------------------------------------------ |
| Resource Group      | `roomies-rg`      | —                                                            |
| PostgreSQL Server   | `roomies-db`      | `roomies-db.postgres.database.azure.com`                     |
| PostgreSQL Database | `roomies_db`      | —                                                            |
| Upstash Redis       | `roomies-redis`   | `YOUR-ENDPOINT.upstash.io:6380`                              |
| Storage Account     | `roomiesblob`     | `roomiesblob.blob.core.windows.net`                          |
| Blob Container      | `roomies-uploads` | `https://roomiesblob.blob.core.windows.net/roomies-uploads/` |
| Key Vault           | `roomies-kv`      | `https://roomies-kv.vault.azure.net/`                        |
| App Service Plan    | `roomies-plan`    | —                                                            |
| App Service         | `roomies-api`     | `https://roomies-api.azurewebsites.net`                      |
| Email Provider      | Brevo SMTP        | `smtp-relay.brevo.com:587`                                   |

---

## Part 10 — Quick Reference CLI Commands

```bash
# Stream live logs
az webapp log tail --resource-group roomies-rg --name roomies-api

# Restart App Service
az webapp restart --resource-group roomies-rg --name roomies-api

# Stop/start PostgreSQL (saves compute cost during breaks)
az postgres flexible-server stop  --resource-group roomies-rg --name roomies-db
az postgres flexible-server start --resource-group roomies-rg --name roomies-db

# Update a secret
az keyvault secret set --vault-name roomies-kv --name "ALLOWED-ORIGINS" \
  --value "https://your-frontend.vercel.app"

# List all resources
az resource list --resource-group roomies-rg --output table

# Redeploy (full cycle)
zip -r roomies-deploy.zip . -x "node_modules/*" ".git/*" ".env*" "uploads/*" "*.zip"
az webapp deploy --resource-group roomies-rg --name roomies-api \
  --src-path roomies-deploy.zip --type zip

# Run migrations against Azure DB
ENV_FILE=.env.azure node src/db/migrate.js

# Run amenity seed against Azure DB
ENV_FILE=.env.azure node src/db/seeds/amenities.js
```

---

## Appendix — What the Old Deployment.md Got Wrong

| Old plan                                       | Problem                                     | This plan                                     |
| ---------------------------------------------- | ------------------------------------------- | --------------------------------------------- |
| Azure Cache for Redis Basic C0 (~₹1,050/month) | Expensive, adds ₹210/month vs better option | Upstash Redis Fixed 250MB ($10 = ~₹840/month) |
| Upstash free tier                              | BullMQ exhausts 500K commands in <10 days   | Upstash Fixed plan designed for BullMQ        |
| Total budget ~₹2,875/month                     | Underestimated storage cost                 | ~₹3,302/month (includes P4 SSD storage)       |
| Docker mention as potential option             | Unnecessary complexity for a Node.js app    | No Docker, direct code deploy via zip         |
| No mention of migration runner                 | Schema setup unclear                        | Explicit `migrate.js` usage documented        |
| Missing Upstash setup entirely                 | Redis section only covered Azure            | Full Upstash walkthrough                      |

---

_Guide version: April 2026. Architecture: Central India Azure + Upstash Mumbai. Node.js 22 LTS, PostgreSQL 16 + PostGIS,
Upstash Fixed Redis._
