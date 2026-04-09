# Deployment Plan (Research Notes, Archived)

> ⚠️ **Historical research notes — not the source of truth.**
>
> This document contains earlier exploration and cost assumptions.
> For current deployment decisions and execution steps, use:
>
> - `docs/Deployment.md` (canonical deployment plan)
>
> Last reviewed: **2026-04-09**

This deployment plan uses Azure PaaS services (and Vercel for the frontend) to host the Roomies API and its data components. All resources live in a single **Resource Group** in the **Central India (Pune)** region【39†L1-L4】. We will organize Azure services by role: database, cache, storage, secrets, compute, and email. Budget is tight (₹800–900/month target), so we’ll use free tiers where possible and the smallest paid SKUs for critical parts. The initial deployment is manual (from the `main` branch), with GitHub Actions CI/CD to follow after testing. Below are the detailed components and steps.

## Azure Subscription & Resource Group

- **Subscription & Region:** Use the student Azure subscription and create a new Resource Group in **Central India (Pune)**【39†L1-L4】. Central India has availability zones and good latency for North India. All resources (App Service, Database, etc.) go in this resource group and region.  
- **Budget & Tier Choices:** To save cost, use the **Linux App Service** Basic tier (B1) for the Node.js API (≈$13.14 US/month = ~₹1,000【36†L143-L150】). The Azure free account grants 750 hrs/mo of a B1MS PostgreSQL Flexible server (32 GB)【51†L573-L581】, so use that for the database. Where possible, pick the smallest size (e.g. 1 vCore, minimal RAM) and stop or delete resources when idle to conserve credits. 60% of the budget will go to database, cache, and storage (critical data services), with the rest on App Service and networking. Using Key Vault (free tier for students) and the free 250 MB Static Website feature of Blob storage further reduces costs. 

## Azure Database for PostgreSQL (Flexible Server)

- **Tier & Size:** Provision an **Azure Database for PostgreSQL – Flexible Server** in the same Central India region. Choose the **Burstable (B)** compute tier, e.g. **B1MS** (1 vCore, ~2 GB RAM) with 32 GB storage. This is covered by the free grant: *“750 hours of Flexible Server—Burstable B1MS Instance, 32 GB storage”*【51†L573-L581】. This gives a free PostgreSQL server for the month (no extra cost, aside from storage above 32 GB if used).  
- **High Availability:** For cost reasons, use a **single-zone, no‑HA** setup. (Zone-redundant standby duplicates resources and doubles cost.) At 100 users/day, a single node is adequate. 
- **PostGIS Extension:** After creating the server, **enable the PostGIS extension** so the schema can use geospatial features. In Azure Portal, open *Server parameters*, find the parameter `azure.extensions`, and add `postgis` (and related extensions like `postgis_raster`) to the allow-list【45†L99-L107】. Save, then connect with psql and run `CREATE EXTENSION postgis;` in your database. This grants geometry support for the app’s needs.  
- **Backups:** Azure automatically takes daily backups. Keep the default retention (7 days) as it costs nothing extra up to your storage. No special backup plan needed for now.  

## Azure Cache for Redis

【80†embed_image】 *Figure: Azure Cache for Redis (Standard tier) architecture with a primary and replica node【58†L135-L143】.* We use **Azure Cache for Redis** to power BullMQ queues and caching. For our low traffic, the **Basic tier** (single node) may suffice to save cost, but it has no SLA【58†L135-L143】. To improve reliability, the **Standard tier** (1 primary + 1 replica) provides a 99.9% SLA and automatic failover【58†L135-L143】. Initially we’ll choose the Basic tier (e.g. C0 for 250 MB) to minimize cost; it roughly costs only a few dollars/month in India. If worker jobs are critical, we can upgrade to Standard C0 (~$40 US/mo) later. The diagram above illustrates the Standard (primary-replica) setup. The primary Redis node stores all data and asynchronously replicates to the replica, ensuring availability in case of maintenance or failures. For now, we’ll rely on Basic mode and monitor performance. 

## Azure Blob Storage for Media

- **Storage Account:** Create an **Azure Storage Account** (General-purpose v2) in Central India. Use **Hot** access tier for frequently served images.  
- **Blob Container:** Make a container (e.g. “media” or “$web” for static website mode). If the frontend or app needs to serve user photos or static media, upload them here.  
- **Static Website (Optional):** We can optionally enable the **Static website** feature. This incurs no extra cost beyond storage and operations【70†L206-L209】. Static website hosting lets you serve blobs via a web URL (e.g. `https://<account>.zxx.web.core.windows.net/filename`) without writing server code. (Enable it if you want a simple fallback or want to host documentation, etc.) Note: CORS must be enabled on the storage account so the frontend can fetch images.  
- **Content Delivery:** For now, use direct blob URLs. A CDN (Azure CDN or Front Door) can accelerate global access but adds cost, so skip it until needed. 

## Azure Key Vault for Secrets

- **Key Vault:** Create an **Azure Key Vault** in the same RG/region. This is free under Azure for Students (small per-operation charges are negligible at 100 users/day).  
- **Secrets:** Store sensitive values here: database connection string (or password), Redis access key, JWT signing key, email API keys, etc. Key Vault is centralized and more secure than storing secrets in code. Use distinct secret names (e.g. `DbConnectionString`, `JwtSecret`, `RedisKey`).  
- **Access from App Service:** We’ll assign a **Managed Identity** to the App Service and grant it “get” access to the vault’s secrets【72†L52-L60】. In App Service configuration, use Key Vault references (in App Settings) like `@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/DbConnectionString/)`【72†L52-L60】. The platform will fetch secrets at runtime. This keeps code free of secrets and lets us rotate values without code changes. 

## Azure Communication Services (Email)

- **ACS Email:** Provision an **Azure Communication Services** resource with the Email capability. In the Azure portal, under Communication Services, create an Email domain. We *don’t* have a custom domain yet, so use the **Azure-managed domain (azurecomm.net)**【77†L60-L66】. This gives a free subdomain (e.g. `xxxxxxxx-xxxx.azurecomm.net`) for sending emails. For example, you might send from `donotreply@<your-id>.azurecomm.net`. The managed domain is pre-verified and supports SPF/DKIM by default【77†L60-L66】, so no DNS setup is needed now.  
- **Sending Emails:** Update your Node.js code to use the ACS Email SDK or REST API with the connection string from Key Vault. If for any reason ACS email doesn’t work (e.g. account limitations), as a fallback you could use Nodemailer with a service like Ethereal for testing. But ACS with the free azurecomm.net domain should suffice for development and low-volume email. 

## Azure App Service (Backend API)

- **App Service Plan:** Create an **App Service Plan** (Linux) using the **Basic B1** SKU (1 vCore, ~1.75 GB RAM) for ₹600–700/month (about $13.14 USD【36†L143-L150】). This plan is always-on and sufficient for ~100 daily users. In Azure for Students, pay-as-you-go pricing applies; we have no free tier for production apps.  
- **Web App:** Under that plan, create a **Web App** with a Node.js runtime. Choose the Node.js version that matches your code (for example, “NODE|18-lts”). Use Linux for lower cost and easy Node support.  
- **Deployment:** Initially deploy manually. For example, you can zip your Node.js code and run:  
  ```bash
  az webapp deploy --resource-group <RG> --name <app-name> --src-path roomies-backend.zip --type zip
  ```  
  Or use the Azure portal “Deployment Center” to configure a GitHub/Git or ZIP deployment. The app’s default domain will be something like `roomies-backend.azurewebsites.net`.  
- **Environment Settings:** In the Web App’s Configuration (Application Settings), define the usual Node environment variables: `NODE_ENV=production`, etc. For secrets (DB URL, Redis URL, JWT key), use **Key Vault references** as noted above【72†L52-L60】. For example, set an app setting `DB_CONNECTION` to `@Microsoft.KeyVault(SecretUri=<vault-uri>)`. This way, your Node app can read `process.env.DB_CONNECTION` and it will contain the secret.  
- **CORS:** Since the frontend (on Vercel) is on a different domain, configure CORS on the backend. In your Express setup, allow the Vercel domain (or use a wildcard `*.vercel.app` if you plan multiple branches). This is a code change, not Azure-specific, but ensure it’s in the deployment.  
- **Networking:** We won’t use a VNet or private endpoints for now (to save complexity/credits). The app will connect to the database, Redis, and Key Vault over the internet (which is allowed). For security, set all services to only allow connections from Azure or specific IPs if needed.  
- **Monitoring:** For now, rely on the app’s Pino console logs (which App Service can capture). In future, you can enable Azure Application Insights for better telemetry, but that’s optional initially. 

## Frontend (React+Vite on Vercel)

- **Hosting:** The React/Vite frontend will be deployed on Vercel (free tier for hobby sites). Configure its build (e.g. `npm run build`) and set the environment variable for the API base URL to the Azure App Service URL (e.g. `https://roomies-backend.azurewebsites.net/api`).  
- **CORS & HTTPS:** Ensure the frontend uses HTTPS endpoints. No Azure config needed here since it’s on Vercel. Remember to match the CORS setting in the API.  

## CI/CD Pipeline (GitHub Actions)

After manual deployment success, automate with GitHub Actions. Use the official Azure Action **`azure/webapps-deploy`** to deploy on pushes to `main`. For example, the workflow (see GitHub docs) can build and test your Node app, then use the `Azure/webapps-deploy` action with the publish profile secret【75†L444-L452】. In summary:

1. In GitHub repo, store the Azure publish profile (for the Web App) as a secret `AZURE_WEBAPP_PUBLISH_PROFILE`.  
2. Create a workflow (on push to `main`) that checks out code, installs Node, runs tests/build, and then runs:  
   ```yaml
   - name: Deploy to Azure WebApp  
     uses: azure/webapps-deploy@v2  
     with:  
       app-name: <your-webapp-name>  
       publish-profile: ${{ secrets.AZURE_WEBAPP_PUBLISH_PROFILE }}  
       package: '.'  
   ```  
3. This will push the built app to Azure automatically. (The snippet above is adapted from official docs【75†L444-L452】.) 

Setting up CI/CD ensures future commits to `main` auto-deploy after tests pass. Initially, you can deploy manually via the portal or CLI to verify everything works, then switch to Actions.

## Networking & DNS

- **Public Endpoints:** We’re not using a custom domain yet. The API is at `https://<app-name>.azurewebsites.net`. The frontend has a `<project>.vercel.app` URL. This is acceptable for now. In future, when a domain is purchased (Student Developer Pack may have options), you can map both the API and frontend to custom domains (and provision SSL via Azure-managed certs).  
- **Virtual Network (VNet):** Not needed for this small setup; all traffic is internet-based but internal to Azure where possible. The database and Redis allow public endpoints.

## Cost and Free Tiers

- **PostgreSQL:** *Free.* The Azure free offer includes 750 hrs of a B1MS server (32 GB)【51†L573-L581】, which covers the whole month of operation. If stopped, you only pay for storage.  
- **Key Vault:** *Free tier.* Azure for Students includes a free tier (operations charged per 10k calls, negligible for 100 users).  
- **App Service:** *~₹900–1000/mo.* (B1 Linux, fixed).  
- **Redis:** *Low cost.* Basic C0 (~256 MB) is only a few dollars/month. No SLA, but adequate for dev.  
- **Blob Storage:** *Minimal.* Storage costs ~₹6.5/GB-month (hot). Even 10 GB is only ~₹65/mo. Static website feature is free【70†L206-L209】.  
- **Communication Services Email:** *Usage-based.* Free to set up the resource and send via the free domain. Sending 100 emails is trivial cost.  
- **Total:** We aim to stay under ₹800–900/month. Using the free DB tier saves a lot. The main recurring will be App Service and any non-free Redis usage. Monitor the Azure cost reports and stop resources during long inactivity to extend credits.

## Deployment Steps

1. **Create Resource Group**:  
   ```bash
   az group create --name roomies-rg --location centralindia
   ```
2. **Provision PostgreSQL**:  
   ```bash
   az postgres flexible-server create \
     --resource-group roomies-rg --name roomies-db --location centralindia \
     --admin-user adminuser --admin-password '<password>' \
     --sku-name GP_Burstable_B1ms --storage-size 32
   ```  
   After creation, set `azure.extensions=postgis,postgis_raster` via CLI or portal【45†L99-L107】. Connect locally with `psql` and run your `CREATE EXTENSION postgis;` (and run the schema SQL).  
3. **Provision Redis Cache**:  
   ```bash
   az redis create --resource-group roomies-rg --name roomies-redis \
     --location centralindia --sku Basic --vm-size C0
   ```  
   (This makes a Basic-tier 250 MB cache.) Note the hostname and key.  
4. **Provision Blob Storage**:  
   ```bash
   az storage account create --resource-group roomies-rg \
     --name roomiesstorage --location centralindia --sku Standard_LRS
   ```  
   Create a container, e.g. “media” (or enable static website and use `$web`). Set CORS on the storage account to allow the Vercel domain.  
5. **Provision Key Vault**:  
   ```bash
   az keyvault create --resource-group roomies-rg --name roomies-vault --location centralindia
   ```  
   Store secrets:  
   ```bash
   az keyvault secret set --vault-name roomies-vault --name DbPassword --value '<password>'
   ```  
   (Repeat for Redis key, JWT secret, etc.)  
6. **Provision Communication Services Email**:  
   (Through portal: create an Email Communication resource.) No CLI shortcut; then configure the Azure-managed domain.  
7. **Provision App Service Plan & Web App**:  
   ```bash
   az appservice plan create --name roomies-plan --resource-group roomies-rg --sku B1 --is-linux
   az webapp create --name roomies-api --plan roomies-plan --resource-group roomies-rg --runtime "NODE|18-lts"
   ```  
8. **Configure App Settings**:  
   - In Azure portal, under the Web App’s Configuration: add settings for `PORT`, `NODE_ENV=production`, etc.  
   - Add database URL, Redis URL, JWT secret as Key Vault references, e.g.:  
     ```
     DB_CONNECTION = @Microsoft.KeyVault(SecretUri=https://roomies-vault.vault.azure.net/secrets/DbPassword/)
     REDIS_KEY     = @Microsoft.KeyVault(SecretUri=https://roomies-vault.vault.azure.net/secrets/RedisKey/)
     ```
   - Add any other needed variables (e.g. email connection string from Key Vault).  
9. **Deploy Code**: Use `az webapp deploy` or Kudu/FTP. Confirm the API works (try a test endpoint). Check logs in Azure Portal under *Log stream*.  
10. **Test Integration**: Ensure the frontend on Vercel can call the API (adjust CORS as needed). Test database and Redis operations.  
11. **Set Up CI/CD**: Add GitHub Actions workflow as described above【75†L444-L452】. Store the Web App publish profile in GitHub Secrets (`AZURE_WEBAPP_PUBLISH_PROFILE`). On push to `main`, GitHub will rebuild and redeploy the API.

By following these steps with the chosen SKUs and configurations, the Roomies API will be fully deployed on Azure (with frontend on Vercel) using best practices and current Azure documentation guidelines【36†L143-L150】【45†L99-L107】【72†L52-L60】【77†L60-L66】. All connections are secured, secrets are managed by Key Vault, and free or low-cost tiers are used wherever appropriate. This plan is based on the latest Azure guidance as of 2026, and should leave room in the student budget for other projects. 

**Sources:** Official Azure docs on regions【39†L1-L4】, App Service pricing【36†L143-L150】, PostgreSQL extensions【45†L99-L107】【41†L58-L66】, Azure Cache tiers【58†L135-L143】, Blob static website【70†L206-L209】, Key Vault usage【72†L52-L60】, ACS email domains【77†L60-L66】, and GitHub Actions deployment【75†L444-L452】.