# Tier 2 Deployment Guide — Roomies Backend

## Full Azure Migration with Zero-Downtime Cutover

> **You are reading this because** you are migrating from Tier 0/1 (Render + external providers) to a full Azure setup
> using your student credits, OR you are setting up Azure from scratch for the first time. **Backend URL stays the
> same:** `https://api.roomies.sumitly.app` — the DNS change is the last step, done only after Azure is fully verified.
> **Key principle:** Set up the entire Azure environment in parallel. Only cut DNS over when everything is confirmed
> working. Downtime = 0–5 minutes.

---

## When to Migrate to Tier 2

Move here when at least one of these is true:

- External vendor spend (Upstash + Neon paid + Render Starter) approaches ₹2,500/month — at that point Azure is
  similarly priced with better features
- You need "Always On" compute with an SLA guarantee (Render Starter has no uptime SLA; Azure B1 does)
- Your student credits balance is healthy (above ₹5,000) and you want to consolidate everything
- You are building features that integrate with other Azure services (Azure Monitor, VNet, etc.)
- Render has caused repeated reliability issues (the Singapore region has had occasional free-tier instability)

---

## Understanding What Changes in Tier 2

You are replacing three external services with Azure equivalents:

- Render free web service → Azure App Service B1 Linux (always-on, ~₹1,092/month)
- Neon PostgreSQL → Azure Database for PostgreSQL Flexible Server B1ms (always-on, ~₹1,323/month including storage)
- Upstash Redis → stays on Upstash Fixed OR moves to Azure Cache for Redis C0 (~₹1,050/month)

**Azure Blob Storage and Brevo email stay unchanged.** Your existing `AzureBlobAdapter` already uses Azure Blob. Email
moves back to SMTP now that you are on Azure App Service (which does not block SMTP ports). Or keep using the Brevo API
— both work fine. Keeping the API is simpler since no code changes are needed.

**The DNS change is the migration moment.** While Azure is being set up, your Render service continues serving all
traffic. You only flip the DNS CNAME record from `roomies-api.onrender.com` to `roomies-api.azurewebsites.net` after
Azure is fully tested. This is called a parallel deployment.

---

## Pre-Migration Checklist

Before touching Azure, complete these tasks on your local machine.

**Take a database backup.** This is non-negotiable before any migration involving real user data:

```bash
# Set your current Neon URL
export NEON_URL="postgresql://neondb_owner:PASSWORD@ep-ENDPOINT.ap-southeast-1.aws.neon.tech/neondb?sslmode=require"

# Create a timestamped backup in your project root
pg_dump "$NEON_URL" > roomies_backup_$(date +%Y%m%d_%H%M%S).sql

# Verify the backup is not empty
wc -l roomies_backup_*.sql
# Should show hundreds of lines, not 0 or a very small number
```

**Store this backup in a safe location** — not inside your Git repository (the file will be large and may contain hashed
passwords). Move it to a secure folder:

```bash
mkdir -p ~/roomies-backups
mv roomies_backup_*.sql ~/roomies-backups/
```

**Install the Azure CLI** if you don't have it:

```bash
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
az --version  # Verify installation
az login      # Opens a browser — log in with your Azure student account
az account set --subscription "Azure for Students"
az configure --defaults location=centralindia group=roomies-rg
```

---

## Phase 1 — Resource Group

A Resource Group is a logical container. Deleting `roomies-rg` deletes everything inside it at once. This is useful when
you want to clean up or start over.

```bash
az group create --name roomies-rg --location centralindia
# Expected output: "provisioningState": "Succeeded"
```

---

## Phase 2 — Azure PostgreSQL Flexible Server

### 2.1 Create the Server

**Via Azure Portal:**

1. Go to [portal.azure.com](https://portal.azure.com) and search for "Azure Database for PostgreSQL flexible server" in
   the top search bar.
2. Click **+ Create** → **Flexible server**.
3. On the Basics tab, fill in:
    - **Subscription:** Azure for Students
    - **Resource group:** `roomies-rg`
    - **Server name:** `roomies-db` (becomes `roomies-db.postgres.database.azure.com`)
    - **Region:** Central India
    - **PostgreSQL version:** **16** (must match your schema)
    - **Workload type:** Development (this pre-selects Burstable tier — correct for your scale)
    - Click **Configure server**: select **Standard_B1ms** (1 vCore, 2 GB RAM), storage **32 GiB**, storage auto-growth
      **Enabled**
4. On the Authentication tab:
    - **Authentication method:** PostgreSQL authentication only
    - **Admin username:** `roomiesadmin`
    - **Password:** generate a strong password (16+ characters, mix of uppercase, lowercase, numbers, symbols). **Write
      it down immediately** — you cannot recover it and you will need it several times.
5. On the Networking tab:
    - **Connectivity method:** Public access (allowed IP addresses)
    - **Allow public access:** Yes
    - Click **+ Add current client IP address** to add your home IP
    - **Azure services access:** Yes (required for App Service to connect)
6. Click **Review + create** → **Create**

Deployment takes 3–5 minutes.

**Alternatively, via CLI:**

```bash
az postgres flexible-server create \
  --resource-group roomies-rg \
  --name roomies-db \
  --location centralindia \
  --admin-user roomiesadmin \
  --admin-password "YOUR_STRONG_PASSWORD_HERE" \
  --sku-name Standard_B1ms \
  --tier Burstable \
  --storage-size 32 \
  --version 16 \
  --public-access 0.0.0.0 \
  --backup-retention 7
```

### 2.2 Enable Required Extensions

Your schema uses PostGIS and pgcrypto. Azure requires these to be allowlisted before you can `CREATE EXTENSION`. This is
a one-time setup:

```bash
az postgres flexible-server parameter set \
  --resource-group roomies-rg \
  --server-name roomies-db \
  --name azure.extensions \
  --value POSTGIS,PGCRYPTO
```

Wait 1–2 minutes for the parameter change to apply. No server restart is needed.

### 2.3 Create the Database

```bash
az postgres flexible-server db create \
  --resource-group roomies-rg \
  --server-name roomies-db \
  --database-name roomies_db
```

### 2.4 Build Your Azure Connection String

```
postgresql://roomiesadmin:YOUR_PASSWORD@roomies-db.postgres.database.azure.com:5432/roomies_db?sslmode=require
```

### 2.5 Run Migrations Against Azure PostgreSQL

Connect from your local machine (your IP was whitelisted in step 2.1):

```bash
export AZURE_DB_URL="postgresql://roomiesadmin:YOUR_PASSWORD@roomies-db.postgres.database.azure.com:5432/roomies_db?sslmode=require"

# Test connection first
psql "$AZURE_DB_URL" -c "SELECT version();"
# Should print PostgreSQL version info

# Run migrations in order
psql "$AZURE_DB_URL" -f migrations/001_initial_schema.sql
psql "$AZURE_DB_URL" -f migrations/002_verification_event_outbox.sql

# Verify tables exist
psql "$AZURE_DB_URL" -c "\dt"

# Verify PostGIS works
psql "$AZURE_DB_URL" -c "SELECT ST_AsText(ST_MakePoint(77.21, 28.63));"
# Should return: POINT(77.21 28.63)
```

### 2.6 Zero-Downtime Data Migration From Neon

This is the most delicate part of the migration. You need to move all existing user data from Neon to Azure PostgreSQL
without losing any writes that happen during the migration window.

**The strategy:** Because your app uses Render and Neon until you flip DNS, you have a window where you can:

1. Export a full Neon backup
2. Import it into Azure PostgreSQL
3. Accept that there may be a small gap of data (writes between export and import)
4. During the DNS cutover (which is the actual "downtime"), no writes happen

For a low-traffic app, the simplest approach that gives effectively zero data loss is:

**Step 1 — Export from Neon:**

```bash
# Use your most recent backup, or create a fresh one right now
export NEON_URL="postgresql://neondb_owner:PASSWORD@ep-ENDPOINT.ap-southeast-1.aws.neon.tech/neondb?sslmode=require"
pg_dump "$NEON_URL" --no-owner --no-acl > roomies_migration_$(date +%Y%m%d_%H%M%S).sql
```

The `--no-owner` and `--no-acl` flags strip Neon-specific ownership and access control information that would cause
errors on Azure PostgreSQL.

**Step 2 — Import into Azure PostgreSQL:**

```bash
export AZURE_DB_URL="postgresql://roomiesadmin:YOUR_PASSWORD@roomies-db.postgres.database.azure.com:5432/roomies_db?sslmode=require"
psql "$AZURE_DB_URL" < roomies_migration_YYYYMMDD_HHMMSS.sql
```

This may take a few minutes depending on data size. Watch for any ERROR lines in the output. The most common error at
this step is a PostGIS extension function that exists in Neon but needed to be explicitly created on Azure first — but
since you already ran your migrations in step 2.5, these should resolve correctly.

**Step 3 — Verify data integrity:**

```bash
# Check row counts match between Neon and Azure
psql "$NEON_URL" -c "SELECT COUNT(*) FROM users;"
psql "$AZURE_DB_URL" -c "SELECT COUNT(*) FROM users;"
# These should match (or be very close — a few writes may have happened during migration)

psql "$NEON_URL" -c "SELECT COUNT(*) FROM listings;"
psql "$AZURE_DB_URL" -c "SELECT COUNT(*) FROM listings;"
```

**Step 4 — Handle the gap:** Between the moment you took the Neon export and the moment you flip DNS, some writes may
have happened. For most low-traffic apps, this is 0–10 rows. The options are:

- Accept the small gap (appropriate for early-stage apps where a few records being in Neon-but-not-Azure is acceptable)
- Do a second `pg_dump --data-only` immediately before the DNS cutover and import just the data, which will catch the
  writes that happened since step 1

For most teams at this stage, accepting the small gap during the migration window is the right call. During the DNS
cutover itself (next phase), no traffic is hitting the server at all, so there is no gap during the actual switch.

---

## Phase 3 — Redis Decision: Upstash Fixed vs Azure Cache for Redis

At Tier 2, you have two options for Redis. Review both and make a decision before proceeding.

**Keep Upstash Fixed ($10/month ~₹840):** Your existing `REDIS_URL` does not change. No code changes. No deployment
needed. Upstash Fixed gives you 250 MB Redis with unlimited commands — more than enough for your scale indefinitely.
Your `bullConnection.js` already handles `rediss://` TLS URLs correctly.

**Switch to Azure Cache for Redis C0 (~₹1,050/month from student credits):** This consolidates billing onto Azure and
avoids a separate vendor. However, it costs ₹210/month more than Upstash Fixed, and the only benefit is consolidation.
There is no performance or reliability difference at your scale.

**Recommendation:** Keep Upstash Fixed. The ₹210/month savings are not trivial when your student credit runway is
finite, and the operational simplicity of not migrating Redis is valuable.

If you want Azure Redis anyway, create it via the portal: search "Azure Cache for Redis" → create a Basic C0 (250 MB) in
Central India. After creation, find the primary connection string in Access Keys → it looks like
`roomies-redis.redis.cache.windows.net:6380,password=XXXX,ssl=True`. Convert this to your app's URL format:

```
rediss://:YOUR_ACCESS_KEY@roomies-redis.redis.cache.windows.net:6380
```

Note the `:` before the password (no username — Azure Redis Basic tier uses password-only auth).

---

## Phase 4 — Azure App Service

### 4.1 Create App Service Plan

The plan is the underlying VM. The App Service (your app) runs on the plan.

```bash
az appservice plan create \
  --resource-group roomies-rg \
  --name roomies-plan \
  --location centralindia \
  --is-linux \
  --sku B1
```

### 4.2 Create the Web App

```bash
az webapp create \
  --resource-group roomies-rg \
  --plan roomies-plan \
  --name roomies-api \
  --runtime "NODE:22-lts"
```

This creates `roomies-api.azurewebsites.net`. This is a temporary URL — you will eventually point your custom domain
here.

### 4.3 Enable Managed Identity

Managed Identity allows the App Service to authenticate to Key Vault without storing any credentials. It is the secure
way to manage secrets in Azure.

```bash
az webapp identity assign \
  --resource-group roomies-rg \
  --name roomies-api
# This command outputs a principalId — write it down
```

### 4.4 Configure Startup and Runtime Settings

```bash
# Set Node.js startup command
az webapp config set \
  --resource-group roomies-rg \
  --name roomies-api \
  --startup-file "node src/server.js"

# Enable Always On (critical — without this, the B1 tier still sleeps)
az webapp config set \
  --resource-group roomies-rg \
  --name roomies-api \
  --always-on true

# Set health check path
az webapp config set \
  --resource-group roomies-rg \
  --name roomies-api \
  --generic-configurations '{"healthCheckPath": "/api/v1/health"}'
```

---

## Phase 5 — Key Vault for Secrets

Key Vault is a secure secret store. App Service reads secrets from it at runtime via Managed Identity — no secrets ever
appear in plaintext in the App Service configuration. This is the production-grade approach.

### 5.1 Create the Key Vault

```bash
az keyvault create \
  --resource-group roomies-rg \
  --name roomies-kv \
  --location centralindia \
  --sku standard \
  --enable-rbac-authorization true
```

### 5.2 Grant Yourself Admin Access

```bash
# Get your Azure account's object ID
MY_OBJECT_ID=$(az ad signed-in-user show --query id -o tsv)

# Assign Key Vault Administrator to yourself
az role assignment create \
  --role "Key Vault Administrator" \
  --assignee "$MY_OBJECT_ID" \
  --scope $(az keyvault show --name roomies-kv --query id -o tsv)
```

### 5.3 Grant App Service Access to Key Vault

```bash
# Get the App Service's managed identity principal ID
APP_PRINCIPAL_ID=$(az webapp identity show \
  --resource-group roomies-rg \
  --name roomies-api \
  --query principalId -o tsv)

# Grant it permission to read secrets
az role assignment create \
  --role "Key Vault Secrets User" \
  --assignee "$APP_PRINCIPAL_ID" \
  --scope $(az keyvault show --name roomies-kv --query id -o tsv)
```

### 5.4 Store All Secrets in Key Vault

Run each of these commands, substituting your actual values:

```bash
KV="--vault-name roomies-kv"

az keyvault secret set $KV --name "DATABASE-URL" \
  --value "postgresql://roomiesadmin:YOUR_PASSWORD@roomies-db.postgres.database.azure.com:5432/roomies_db?sslmode=require"

az keyvault secret set $KV --name "REDIS-URL" \
  --value "rediss://default:YOUR_UPSTASH_PASSWORD@YOUR-ENDPOINT.upstash.io:6380"
# (or Azure Redis URL if you chose that in Phase 3)

# Generate new JWT secrets — use fresh ones for Azure, not the same as Render
az keyvault secret set $KV --name "JWT-SECRET" \
  --value "$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")"

az keyvault secret set $KV --name "JWT-REFRESH-SECRET" \
  --value "$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")"

az keyvault secret set $KV --name "AZURE-STORAGE-CONNECTION-STRING" \
  --value "DefaultEndpointsProtocol=https;AccountName=roomiesblob;AccountKey=YOUR_KEY;EndpointSuffix=core.windows.net"

az keyvault secret set $KV --name "AZURE-STORAGE-CONTAINER" --value "roomies-uploads"

az keyvault secret set $KV --name "EMAIL-PROVIDER" --value "brevo-api"
# Keep brevo-api — no code change needed, and it works fine on Azure too

az keyvault secret set $KV --name "BREVO-API-KEY" \
  --value "xkeysib-YOUR_API_KEY"

az keyvault secret set $KV --name "BREVO-SMTP-FROM" \
  --value "your-verified-sender@example.com"

az keyvault secret set $KV --name "GOOGLE-CLIENT-ID" \
  --value "YOUR_GOOGLE_CLIENT_ID"

az keyvault secret set $KV --name "GOOGLE-CLIENT-SECRET" \
  --value "YOUR_GOOGLE_CLIENT_SECRET"

az keyvault secret set $KV --name "ALLOWED-ORIGINS" \
  --value "https://roomies.sumitly.app"
```

---

## Phase 6 — App Service Environment Variables

Azure App Service reads secrets from Key Vault using a special `@Microsoft.KeyVault(SecretUri=...)` reference syntax.
The App Service resolves these at startup — your Node.js process sees them as plain `process.env` values.

Add these via the Azure Portal: App Service → **Configuration** (left sidebar) → **Application settings** tab → **+ New
application setting** for each row below.

**Direct settings (not secrets — put these as plain values):**

```
NODE_ENV = production
PORT = 8080
STORAGE_ADAPTER = azure
JWT_EXPIRES_IN = 15m
JWT_REFRESH_EXPIRES_IN = 7d
TRUST_PROXY = 1
```

**Key Vault references (use this syntax exactly — replace `roomies-kv` with your actual vault name if different):**

```
DATABASE_URL
@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/DATABASE-URL/)

REDIS_URL
@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/REDIS-URL/)

JWT_SECRET
@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/JWT-SECRET/)

JWT_REFRESH_SECRET
@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/JWT-REFRESH-SECRET/)

AZURE_STORAGE_CONNECTION_STRING
@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/AZURE-STORAGE-CONNECTION-STRING/)

AZURE_STORAGE_CONTAINER
@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/AZURE-STORAGE-CONTAINER/)

EMAIL_PROVIDER
@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/EMAIL-PROVIDER/)

BREVO_API_KEY
@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/BREVO-API-KEY/)

BREVO_SMTP_FROM
@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/BREVO-SMTP-FROM/)

GOOGLE_CLIENT_ID
@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/GOOGLE-CLIENT-ID/)

GOOGLE_CLIENT_SECRET
@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/GOOGLE-CLIENT-SECRET/)

ALLOWED_ORIGINS
@Microsoft.KeyVault(SecretUri=https://roomies-kv.vault.azure.net/secrets/ALLOWED-ORIGINS/)
```

Click **Save** after adding all settings.

To verify that Key Vault references resolved correctly: App Service → Configuration → look at the **Key Vault Reference
Status** column next to each KV-referenced setting. Each should show a green checkmark and "Resolved". If any show
"Unresolved", common causes are:

- The Managed Identity role assignment (Phase 4.3) hasn't propagated yet — wait 5 minutes and refresh
- The secret name in Key Vault does not match exactly (names are case-sensitive)
- The Key Vault URI in the reference is wrong — check for typos

---

## Phase 7 — First Azure Deployment

### 7.1 Create the Deployment ZIP

From your project root on your local machine:

```bash
# Ensure you're on main branch with all changes committed
git checkout main
git pull origin main

# Create the deployment archive
zip -r roomies-deploy.zip . \
  -x "node_modules/*" \
  -x ".git/*" \
  -x ".env*" \
  -x "uploads/*" \
  -x "*.zip" \
  -x "*.sql"

# Verify the archive is reasonable (should be tens of MB, not hundreds)
ls -lh roomies-deploy.zip
```

### 7.2 Deploy to Azure

```bash
az webapp deploy \
  --resource-group roomies-rg \
  --name roomies-api \
  --src-path roomies-deploy.zip \
  --type zip
```

Azure's Oryx build system will detect `package.json`, run `npm install --production`, and start the app with
`node src/server.js`. This takes 3–5 minutes.

### 7.3 Watch the Startup Logs

```bash
az webapp log tail \
  --resource-group roomies-rg \
  --name roomies-api
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

### 7.4 Test the Azure URL

Before touching DNS, verify everything works on the Azure `.azurewebsites.net` URL:

```bash
# Health check
curl https://roomies-api.azurewebsites.net/api/v1/health
# Expected: {"status":"ok","services":{"database":"ok","redis":"ok"}}

# Register a test user (use a throwaway email)
curl -X POST https://roomies-api.azurewebsites.net/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"azure_test@example.com","password":"TestPass1","role":"student","fullName":"Azure Test"}'
# Expected: 201 Created
```

Do not proceed to DNS cutover until the Azure URL is fully working. Your Render service is still serving all real user
traffic during this phase.

---

## Phase 8 — Set Up Custom Domain on Azure App Service

Azure needs to know about your custom domain before you redirect traffic to it.

### 8.1 Add Custom Domain to App Service

Go to Azure Portal → your App Service → **Custom domains** (left sidebar) → **+ Add custom domain**.

Enter `api.roomies.sumitly.app`. Azure will tell you what TXT and CNAME records to add for verification. It will show
you something like:

- **TXT record:** Host = `asuid.api.roomies`, Value = a long verification string
- **CNAME record:** Host = `api.roomies`, Value = `roomies-api.azurewebsites.net`

### 8.2 Add the Verification TXT Record on name.com

Go to name.com → My Domains → `sumitly.app` → Manage DNS Records.

Add a **TXT record**:

- **Type:** TXT
- **Host:** `asuid.api.roomies`
- **Answer:** the long verification string from Azure (something like `3A8B2C...`)
- **TTL:** 300 (default)

Click **Add Record**.

### 8.3 Add the App Service Managed Certificate (Free SSL)

After Azure verifies the TXT record (may take a few minutes), go back to **Custom domains** → **Add custom domain** →
complete the binding → select **App Service Managed Certificate** — this is a free, auto-renewing SSL certificate.

---

## Phase 9 — The DNS Cutover (Zero-Downtime Migration)

This is the moment where you switch traffic from Render to Azure. The window between removing the old CNAME and DNS
propagating to the new one is when a small amount of traffic might get errors (cached DNS entries taking different
amounts of time to expire). For a low-traffic app, this window is typically 0–60 seconds.

**To minimise this window, temporarily lower TTL before the cutover.** Do this 24 hours before you plan to cut over:

Go to name.com → DNS records → find your existing `api.roomies` CNAME (pointing to `roomies-api.onrender.com`) → edit it
to set TTL to **60 seconds** (the minimum name.com allows).

After 24 hours, most of the world's DNS resolvers have refreshed their cached record with the 60-second TTL. That means
when you change the CNAME target, propagation will happen within 60 seconds instead of up to 24 hours.

**On the day of the cutover:**

Step 1 — Pick a low-traffic time. Look at your Render logs and pick a time when you see the fewest requests (typically
2–5 AM India time).

Step 2 — Take a final Neon backup immediately before the cutover:

```bash
pg_dump "$NEON_URL" --no-owner --no-acl > ~/roomies-backups/final_pre_cutover_$(date +%Y%m%d_%H%M%S).sql
```

Step 3 — Do a second data import to Azure to catch any writes since your first migration (Phase 2.6):

```bash
# Export only data (no DDL — schema is already in Azure)
pg_dump "$NEON_URL" --data-only --no-owner --no-acl > /tmp/final_data.sql

# Import into Azure (some rows may conflict with existing data — that's OK)
psql "$AZURE_DB_URL" --single-transaction < /tmp/final_data.sql 2>&1 | grep -v "ERROR.*duplicate" | grep -v "^$"
# Filtering out expected duplicate-key errors from data that was already imported
```

Step 4 — Update the CNAME on name.com:

Go to name.com → DNS records → find the `api.roomies` CNAME → edit it:

- **Answer:** change from `roomies-api.onrender.com` to `roomies-api.azurewebsites.net`
- **TTL:** set back to 300 (default)

Click **Save**.

Step 5 — Verify the change is propagating:

```bash
# Watch DNS propagation
watch -n 5 'dig CNAME api.roomies.sumitly.app +short'
# Should change from roomies-api.onrender.com to roomies-api.azurewebsites.net within ~60 seconds
```

Step 6 — Test the production URL over HTTPS:

```bash
curl https://api.roomies.sumitly.app/api/v1/health
# Expected: {"status":"ok","services":{"database":"ok","redis":"ok"}}
```

Step 7 — Update Google OAuth callback URL in Google Cloud Console to confirm
`https://api.roomies.sumitly.app/api/v1/auth/google/callback` is listed.

Step 8 — Keep Render running for 48 hours after the cutover. Old DNS entries may still point to Render. After 48 hours,
you can safely suspend or delete the Render service.

---

## Phase 10 — CI/CD Pipeline for Azure

Set up automatic deployment on push to `main` so you don't have to manually create ZIP files.

### 10.1 Get the App Service Publish Profile

Azure Portal → your App Service → **Overview** → click **Get publish profile** → save the downloaded file.

### 10.2 Add to GitHub Secrets

Go to your GitHub repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

- **Name:** `AZURE_WEBAPP_PUBLISH_PROFILE`
- **Value:** paste the entire contents of the downloaded `.PublishSettings` file

### 10.3 Create the GitHub Actions Workflow

Create `.github/workflows/deploy-azure.yml`:

```yaml
name: Deploy to Azure App Service

on:
    push:
        branches: [main]

jobs:
    deploy:
        runs-on: ubuntu-latest
        steps:
            - name: Checkout code
              uses: actions/checkout@v4

            - name: Setup Node.js 22
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

When you push to `main`, GitHub Actions runs this workflow. Deploys take 3–5 minutes. You can watch progress in GitHub →
Actions tab.

---

## Phase 11 — Setting Up a Cost Budget Alert

Your student credits are finite. Set up an alert so you're notified before they run out.

Azure Portal → search "Cost Management + Billing" → **Budgets** → **+ Add**.

Fill in:

- **Scope:** your Azure for Students subscription
- **Budget name:** `roomies-monthly`
- **Reset period:** Monthly
- **Budget amount:** ₹1,500 (slightly above expected ~₹1,323/month for Tier 2 minus Redis)
- **Alert conditions:**
    - Alert at 80% (₹1,200) — send an email to your address
    - Alert at 100% (₹1,500) — send another email

This gives you two warnings before you significantly overspend.

---

## Post-Migration Verification Checklist

Run all of these after the DNS cutover:

```bash
# Health
curl https://api.roomies.sumitly.app/api/v1/health

# Authentication
curl -X POST https://api.roomies.sumitly.app/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"your_real_user@example.com","password":"their_password"}'

# Photo URL check — make sure existing photos still load
curl -I https://roomiesblob.blob.core.windows.net/roomies-uploads/listings/SOME_LISTING_ID/some_photo.webp
# Should return 200 OK

# OTP email
# Register a test account and trigger an OTP — confirm it arrives
```

---

## Tier 2 Monthly Cost Summary

| Service                        | Tier             | Cost/month        |
| ------------------------------ | ---------------- | ----------------- |
| Azure App Service B1           | Basic            | ~₹1,092           |
| Azure PostgreSQL Flexible B1ms | Burstable        | ~₹1,043           |
| PostgreSQL storage 32 GB       | SSD              | ~₹280             |
| Upstash Redis Fixed 250MB      | Fixed            | ~₹840             |
| Azure Blob Storage             | Always-free 5 GB | ₹0                |
| Brevo Email API                | Free 300/day     | ₹0                |
| **Total**                      |                  | **~₹3,255/month** |

With ₹9,480 student credits: approximately **2.9 months** of full Tier 2 operation. By then, either your student credits
will have renewed (Azure for Students renews annually) or the project will have paying users covering costs.

**Cost-saving tip:** Azure PostgreSQL Flexible Server has a **Stop** feature. When you are not actively developing or
expecting traffic, stop the server — you pay only for storage (~₹280/month), not compute (~₹1,043/month). Restart it
before your next session. The server auto-restarts after 7 days if you forget.

```bash
# Stop to save credits
az postgres flexible-server stop --resource-group roomies-rg --name roomies-db

# Start again before developing
az postgres flexible-server start --resource-group roomies-rg --name roomies-db
```

---

## All Tier 2 Azure Resource Names

| Resource              | Name              | URL / Endpoint                                               |
| --------------------- | ----------------- | ------------------------------------------------------------ |
| Resource Group        | `roomies-rg`      | —                                                            |
| PostgreSQL Server     | `roomies-db`      | `roomies-db.postgres.database.azure.com`                     |
| PostgreSQL Database   | `roomies_db`      | —                                                            |
| App Service Plan      | `roomies-plan`    | —                                                            |
| App Service (Web App) | `roomies-api`     | `roomies-api.azurewebsites.net`                              |
| Key Vault             | `roomies-kv`      | `https://roomies-kv.vault.azure.net`                         |
| Storage Account       | `roomiesblob`     | `roomiesblob.blob.core.windows.net`                          |
| Blob Container        | `roomies-uploads` | `https://roomiesblob.blob.core.windows.net/roomies-uploads/` |
| Redis (Upstash)       | `roomies-redis`   | `YOUR-ENDPOINT.upstash.io:6380`                              |
| Custom Domain         | —                 | `api.roomies.sumitly.app`                                    |
