# Roomies — Azure Account Reference

**Purpose:** Complete factual snapshot of the current Azure account, resources, access, and configuration. This is not
an execution plan; see `roomies-infra-migration-prd.md` for planned work. Update this document whenever a new Azure CLI
result changes reality.

**Last verified:** 2026-08-14  
**Verification method:** Azure Resource Graph (`az graph query`) for the primary resource inventory, then targeted
read-only Azure CLI management-plane and data-plane commands.  
**Security rule:** All values returned by Azure are recorded below except credentials and application secrets.
Secret-bearing app settings are documented by exact name, never value; this includes database, Redis, JWT, OAuth,
SMTP/API, and storage-connection secrets.

---

## 1. Subscription and signed-in identity

| Field                         | Value                                  |
| ----------------------------- | -------------------------------------- |
| Subscription name             | Azure for Students                     |
| Subscription ID               | `eaf92174-664c-4d77-b387-7f4da6bf8a36` |
| Subscription state            | Enabled                                |
| Cloud environment             | AzureCloud                             |
| Default subscription          | `true`                                 |
| Tenant ID / home tenant ID    | `1490b17d-5dc9-4cbf-aeba-a2e854f521b8` |
| Tenant display name           | Graphic Era University                 |
| Tenant default domain         | `geu.ac.in`                            |
| Signed-in user principal name | `2510090039@geu.ac.in`                 |
| Signed-in user display name   | Sumeet Yadav                           |
| User object ID                | `66829680-745e-4357-bfac-f8a335fe943a` |
| Account user type             | `user`                                 |
| Managed-by tenants            | `[]`                                   |

### Credit and budget

| Field                           | Current value                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Azure CLI budget list           | `[]` — no budget is configured                                                                                                                                     |
| Current remaining grant balance | Azure CLI consumption output did **not** return a numeric balance                                                                                                  |
| Current used percentage         | Azure CLI consumption output did **not** return a numeric percentage                                                                                               |
| Current reset cycle             | Not returned by Azure CLI                                                                                                                                          |
| August 2026 usage query         | Returned 16 consumption rows for `roomies-api` and `roomiesblob`, but every row had `pretaxCost: None`, `currency: null`, `usageStart: null`, and `usageEnd: null` |

The older ₹9,436.54 / 0.03% figures are not carried forward as current facts. Obtain a current student-grant balance
from the Azure portal before using it for a cost decision.

### Known subscription constraints

- This is a free education grant through the GitHub Student Developer Pack.
- Sponsored/student subscriptions can impose subscription-level region restrictions that are not represented by general
  SKU availability.
- `az consumption budget create` may be rejected on this subscription type; this has not been attempted in this audit.

---

## 2. Access, RBAC, and identities

### Role assignments

| Assignment ID                          | Principal                                                       | Principal type | Role                     | Scope                                                                                   | Created / updated                  |
| -------------------------------------- | --------------------------------------------------------------- | -------------- | ------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------- |
| `e533e20d-1f17-4851-b233-12e07d7ab9ce` | `2510090039@geu.ac.in` (`66829680-745e-4357-bfac-f8a335fe943a`) | User           | Owner                    | `/subscriptions/eaf92174-664c-4d77-b387-7f4da6bf8a36`                                   | `2025-09-10T14:19:26.389977+00:00` |
| `8cf8edf1-1552-4095-8a33-80244b6e6a87` | `2510090039@geu.ac.in` (`66829680-745e-4357-bfac-f8a335fe943a`) | User           | Owner                    | `/subscriptions/eaf92174-664c-4d77-b387-7f4da6bf8a36`                                   | `2025-09-10T14:19:26.420852+00:00` |
| `788b8371-533b-4229-b214-0899054bd13c` | `2510090039@geu.ac.in` (`66829680-745e-4357-bfac-f8a335fe943a`) | User           | Storage Blob Data Reader | `.../resourceGroups/roomies-rg/providers/Microsoft.Storage/storageAccounts/roomiesblob` | `2026-07-27T02:54:17.029660+00:00` |

The two Owner assignments are duplicate role assignments for the same principal and scope. They do not grant more than
Owner, but both exist. The Storage Blob Data Reader assignment is required for Entra ID data-plane blob access;
subscription Owner alone does not grant blob data-plane access.

No other principals, service principals, or managed identities appear in the returned subscription/RG/storage-scope RBAC
assignments.

### Managed identity — corrected finding

| Field                                       | Value            |
| ------------------------------------------- | ---------------- |
| Web App `keyVaultReferenceIdentity` setting | `SystemAssigned` |
| Web App `identity` object                   | `null`           |
| `az webapp identity show` result            | Empty output     |
| Actual system-assigned managed identity     | **Not assigned** |

The `keyVaultReferenceIdentity` setting must not be treated as proof that an identity exists. There is currently no
usable Web App managed identity and no Key Vault.

---

## 3. Resource group

| Field                             | Value                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------- |
| Name                              | `roomies-rg`                                                                    |
| Resource ID                       | `/subscriptions/eaf92174-664c-4d77-b387-7f4da6bf8a36/resourceGroups/roomies-rg` |
| Location                          | `centralindia` (Central India)                                                  |
| Provisioning state                | Succeeded                                                                       |
| Tags                              | `null` (none)                                                                   |
| Managed by                        | `null`                                                                          |
| Resource locks                    | `[]` (none)                                                                     |
| Resource-group policy assignments | `[]` (none)                                                                     |

---

## 4. Resource Graph inventory

Azure Resource Graph confirms exactly **three** resources in `roomies-rg`:

| Type                                | Name               | Location        | Kind / SKU               | Provisioning state |
| ----------------------------------- | ------------------ | --------------- | ------------------------ | ------------------ |
| `microsoft.storage/storageaccounts` | `roomiesblob`      | `southeastasia` | StorageV2 / Standard_LRS | Succeeded          |
| `microsoft.web/serverfarms`         | `roomies-api-plan` | `southeastasia` | linux / B1 Basic         | Succeeded          |
| `microsoft.web/sites`               | `roomies-api`      | `southeastasia` | app,linux / Basic        | Running            |

No additional Azure resources exist in this resource group according to the Graph query.

---

## 5. Storage account — `roomiesblob`

### Core account properties

| Field                                    | Value                                                                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Resource ID                              | `/subscriptions/eaf92174-664c-4d77-b387-7f4da6bf8a36/resourceGroups/roomies-rg/providers/Microsoft.Storage/storageAccounts/roomiesblob` |
| Type / kind                              | `Microsoft.Storage/storageAccounts` / StorageV2                                                                                         |
| SKU / tier                               | Standard_LRS / Standard                                                                                                                 |
| Location / primary location              | Southeast Asia / `southeastasia`                                                                                                        |
| Creation time                            | `2026-04-20T07:29:58.547Z`                                                                                                              |
| Provisioning state                       | Succeeded                                                                                                                               |
| Primary status                           | available                                                                                                                               |
| Access tier                              | Hot                                                                                                                                     |
| Tags                                     | `{}`                                                                                                                                    |
| Public network access                    | Enabled                                                                                                                                 |
| Network ACL default action               | Allow                                                                                                                                   |
| Network ACL bypass                       | AzureServices                                                                                                                           |
| IPv4 rules / IPv6 rules / VNet rules     | `[]` / `[]` / `[]`                                                                                                                      |
| Private endpoints                        | `[]`                                                                                                                                    |
| Allow blob public access                 | `true`                                                                                                                                  |
| Allow shared-key access                  | `true`                                                                                                                                  |
| Default to OAuth authentication          | `false`                                                                                                                                 |
| Allow cross-tenant replication           | `false`                                                                                                                                 |
| Allow cross-tenant delegation SAS        | `false`                                                                                                                                 |
| HTTPS-only traffic                       | `true`                                                                                                                                  |
| Minimum TLS version                      | TLS1_2                                                                                                                                  |
| Hierarchical namespace                   | `null`                                                                                                                                  |
| NFS v3                                   | `null`                                                                                                                                  |
| SFTP                                     | `null`                                                                                                                                  |
| Local users                              | `null`                                                                                                                                  |
| System/user-assigned identity            | `null`                                                                                                                                  |
| Secondary location/endpoints             | `null`                                                                                                                                  |
| Failover in progress / last geo failover | `null` / `null`                                                                                                                         |

### Endpoints

| Service | Endpoint                                        |
| ------- | ----------------------------------------------- |
| Blob    | `https://roomiesblob.blob.core.windows.net/`    |
| DFS     | `https://roomiesblob.dfs.core.windows.net/`     |
| File    | `https://roomiesblob.file.core.windows.net/`    |
| Queue   | `https://roomiesblob.queue.core.windows.net/`   |
| Table   | `https://roomiesblob.table.core.windows.net/`   |
| Web     | `https://roomiesblob.z23.web.core.windows.net/` |

### Encryption

| Field                                     | Value                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| Key source                                | Microsoft.Storage (platform-managed)                                         |
| Customer Key Vault properties             | `null`                                                                       |
| Infrastructure/double encryption required | `false`                                                                      |
| Blob encryption                           | enabled; key type `Account`; last enabled `2026-04-20T07:29:58.712526+00:00` |
| File encryption                           | enabled; key type `Account`; last enabled `2026-04-20T07:29:58.712526+00:00` |
| Queue/table encryption entries            | `null` / `null`                                                              |
| Key creation time, key1 / key2            | `2026-04-20T07:29:58.690193+00:00` / `2026-04-20T07:29:58.690193+00:00`      |

### Blob service properties

| Field                       | Value                                                |
| --------------------------- | ---------------------------------------------------- |
| Blob soft delete            | enabled, 7 days; permanent delete `false`            |
| Container soft delete       | enabled, 7 days; permanent-delete field `null`       |
| Blob versioning             | `null` (not enabled)                                 |
| Change feed                 | `null` (not enabled)                                 |
| CORS rules                  | `[]`                                                 |
| Static website              | disabled; index document and 404 document are `null` |
| Last-access time tracking   | `null` (not enabled)                                 |
| Restore policy              | `null`                                               |
| Default service version     | `null`                                               |
| Automatic snapshot policy   | `null`                                               |
| Lifecycle management policy | None — command returned `ManagementPolicyNotFound`   |
| Storage diagnostic settings | `[]`                                                 |

### Container — `roomies-uploads`

| Field                             | Value                                                           |
| --------------------------------- | --------------------------------------------------------------- |
| Only container returned           | `roomies-uploads`                                               |
| Public access                     | `blob` (individual blobs are publicly readable; listing is not) |
| Blob count                        | `0`                                                             |
| Last modified                     | `2026-04-20T07:33:33+00:00`                                     |
| ETag                              | `"0x8DE9EAF20C1B678"`                                           |
| Lease                             | state `available`, status `unlocked`, duration `null`           |
| Immutability policy               | `false`                                                         |
| Legal hold                        | `false`                                                         |
| Container metadata                | `{}`                                                            |
| Default encryption scope          | `$account-encryption-key`                                       |
| Prevent encryption-scope override | `false`                                                         |
| Immutable storage with versioning | `false`                                                         |
| Deleted / version                 | `null` / `null`                                                 |

---

## 6. App Service Plan — `roomies-api-plan`

| Field                                              | Value                                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Resource ID                                        | `/subscriptions/eaf92174-664c-4d77-b387-7f4da6bf8a36/resourceGroups/roomies-rg/providers/Microsoft.Web/serverfarms/roomies-api-plan` |
| Type / kind                                        | `Microsoft.Web/serverfarms` / linux                                                                                                  |
| Location / geo region                              | Southeast Asia / Southeast Asia                                                                                                      |
| SKU                                                | B1, Basic, family B, capacity 1                                                                                                      |
| Compute mode / plan name                           | Dedicated / VirtualDedicatedPlan                                                                                                     |
| Reserved Linux flag                                | `true`                                                                                                                               |
| Provisioning state / status / power state          | Succeeded / Ready / Running                                                                                                          |
| Created time                                       | `2026-07-27T04:16:26.4533333`                                                                                                        |
| Free-offer expiration time                         | `2027-01-27T04:16:24.0066667`                                                                                                        |
| Number of sites / workers                          | 1 / 1                                                                                                                                |
| Current worker size / ID                           | Small / 0                                                                                                                            |
| Current number of workers / zones used             | 1 / 1                                                                                                                                |
| Maximum workers / elastic workers / zones          | 3 / 1 / 1                                                                                                                            |
| Per-site scaling / elastic scaling / async scaling | false / false / false                                                                                                                |
| Zone redundant                                     | false                                                                                                                                |
| Spot / custom mode / Xenon / Hyper-V               | false / false / false / false                                                                                                        |
| VNet connections used / maximum                    | 0 / 2                                                                                                                                |
| Web space                                          | `roomies-rg-SoutheastAsiawebspace-Linux`                                                                                             |
| MDM ID / server farm ID                            | `waws-prod-sg1-089_31656` / 31656                                                                                                    |
| Tags                                               | `null`                                                                                                                               |
| Plan diagnostic settings                           | `[]`                                                                                                                                 |

---

## 7. Web App — `roomies-api`

### Core site properties

| Field                                       | Value                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Resource ID                                 | `/subscriptions/eaf92174-664c-4d77-b387-7f4da6bf8a36/resourceGroups/roomies-rg/providers/Microsoft.Web/sites/roomies-api` |
| Type / kind                                 | `Microsoft.Web/sites` / `app,linux`                                                                                       |
| Location                                    | Southeast Asia                                                                                                            |
| App Service Plan                            | `roomies-api-plan` (`.../serverfarms/roomies-api-plan`)                                                                   |
| State / availability / runtime availability | Running / Normal / Normal                                                                                                 |
| Enabled                                     | `true`                                                                                                                    |
| Default hostname                            | `roomies-api.azurewebsites.net`                                                                                           |
| Enabled hostnames                           | `roomies-api.azurewebsites.net`, `roomies-api.scm.azurewebsites.net`                                                      |
| SKU                                         | Basic                                                                                                                     |
| Last modified UTC                           | `2026-08-09T13:35:30.333333`                                                                                              |
| Public network access                       | Enabled                                                                                                                   |
| HTTPS-only                                  | `false`                                                                                                                   |
| Client certificate enabled / mode           | false / Required                                                                                                          |
| Client affinity / proxy affinity            | true / false                                                                                                              |
| HTTP IP mode                                | IPv4                                                                                                                      |
| Site tags                                   | `null`                                                                                                                    |
| Web App identity                            | `null`                                                                                                                    |
| Key Vault reference identity setting        | SystemAssigned (no actual identity is assigned; see §2)                                                                   |
| In-flight features                          | `["SiteContainers"]`                                                                                                      |
| End-to-end encryption                       | `false`                                                                                                                   |
| VNet subnet / VNet integration              | `null` / `[]`                                                                                                             |
| Deployment slots                            | `[]`                                                                                                                      |
| Managed environment / private endpoints     | `null` / `[]`                                                                                                             |
| Web App diagnostic settings                 | `[]`                                                                                                                      |

### Network addresses

| Address type                 | Value                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Inbound IPv4                 | `20.212.64.12,20.212.79.14`                                                                                                                                                                            |
| Inbound IPv6                 | `2603:1040:5:4::d`                                                                                                                                                                                     |
| Current outbound IPv4        | `20.43.151.254,20.44.216.33,20.44.216.231,20.44.216.245,20.43.151.165,20.44.218.63,20.212.64.12,20.212.79.14`                                                                                          |
| Current outbound IPv6        | `2603:1040:2:e::aa,2603:1040:2:6::96,2603:1040:2:b::95,2603:1040:2:d::9a,2603:1040:2:c::a8,2603:1040:2:f::a7,2603:1040:5:4::d,2603:10e1:100:2::14d4:400c,2603:1040:5:4::34,2603:10e1:100:2::14d4:4f0e` |
| Possible outbound IPv4 count | 27 (returned by Azure; dynamic platform data)                                                                                                                                                          |
| Possible outbound IPv6 count | 30 (returned by Azure; dynamic platform data)                                                                                                                                                          |
| Outbound VNet routing        | allTraffic, applicationTraffic, backupRestoreTraffic, contentShareTraffic, imagePullTraffic, managedIdentityTraffic: all `false`                                                                       |

### Runtime, application configuration, and deployment surface

| Field                                                        | Value                                                                                                                                     |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Runtime stack                                                | `NODE                                                                                                                                     | 22-lts` |
| Always On                                                    | `false`                                                                                                                                   |
| Minimum TLS / SCM minimum TLS                                | 1.2 / 1.2                                                                                                                                 |
| FTPS state                                                   | FtpsOnly                                                                                                                                  |
| FTP publishing endpoint                                      | `ftps://waws-prod-sg1-089.ftp.azurewebsites.windows.net/site/wwwroot`                                                                     |
| FTP username                                                 | `roomies-api\\$roomies-api`                                                                                                               |
| Publishing password                                          | Secret — not recorded                                                                                                                     |
| HTTP/2 / HTTP/2 proxy                                        | false / 0                                                                                                                                 |
| WebSockets                                                   | false                                                                                                                                     |
| Health check path                                            | `null`                                                                                                                                    |
| Auto-heal / detailed errors / request tracing / HTTP logging | false / false / false / false                                                                                                             |
| Remote debugging                                             | false                                                                                                                                     |
| `use32BitWorkerProcess`                                      | true                                                                                                                                      |
| Worker count / pre-warmed instances / min elastic instances  | 1 / 0 / 0                                                                                                                                 |
| Load balancing                                               | LeastRequests                                                                                                                             |
| SCM type                                                     | None                                                                                                                                      |
| Main IP restrictions                                         | one `Allow all` rule for `Any`, priority 2147483647                                                                                       |
| SCM IP restrictions                                          | one `Allow all` rule for `Any`, priority 2147483647                                                                                       |
| SCM uses main restrictions                                   | false                                                                                                                                     |
| App command line                                             | empty string                                                                                                                              |
| Azure Storage mounts                                         | `{}`                                                                                                                                      |
| Connection strings                                           | `null`                                                                                                                                    |
| Site CORS configuration                                      | `null`                                                                                                                                    |
| Default documents                                            | `Default.htm`, `Default.html`, `Default.asp`, `index.htm`, `index.html`, `iisstart.htm`, `default.aspx`, `index.php`, `hostingstart.html` |
| Virtual application                                          | `/` → `site\\wwwroot`; preload false                                                                                                      |
| Website timezone                                             | `null`                                                                                                                                    |
| Web jobs enabled                                             | false                                                                                                                                     |

### Hostnames, certificates, and custom domains

| Field                                       | Value                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| Hostname binding count                      | 1                                                                             |
| Hostname binding                            | `roomies-api.azurewebsites.net`                                               |
| Binding type                                | Verified (the standard Azure hostname, not a custom domain)                   |
| Binding SSL state / thumbprint / virtual IP | `null` / `null` / `null`                                                      |
| `azurewebsites.net` hostname SSL state      | Disabled (Azure platform hostname; this does not create a custom certificate) |
| SCM hostname SSL state                      | Disabled                                                                      |
| Custom domain bindings                      | None                                                                          |
| Certificates / managed certificates         | `[]`                                                                          |

### App settings

Exactly **24** settings are present, and all have `slotSetting: false`:

| Setting name                      | Current value / handling                                                |
| --------------------------------- | ----------------------------------------------------------------------- |
| `NODE_ENV`                        | `production`                                                            |
| `PORT`                            | `3000`                                                                  |
| `DATABASE_URL`                    | Secret — not recorded                                                   |
| `REDIS_URL`                       | Secret — not recorded                                                   |
| `JWT_SECRET`                      | Secret — not recorded                                                   |
| `JWT_REFRESH_SECRET`              | Secret — not recorded                                                   |
| `JWT_EXPIRES_IN`                  | `15m`                                                                   |
| `JWT_REFRESH_EXPIRES_IN`          | `7d`                                                                    |
| `GOOGLE_CLIENT_ID`                | Sensitive identifier — not recorded                                     |
| `GOOGLE_CLIENT_SECRET`            | Secret — not recorded                                                   |
| `BREVO_SMTP_SERVER`               | `smtp-relay.brevo.com`                                                  |
| `BREVO_SMTP_PORT`                 | `587`                                                                   |
| `BREVO_SMTP_LOGIN`                | Sensitive credential identifier — not recorded                          |
| `BREVO_SMTP_KEY`                  | Secret — not recorded                                                   |
| `BREVO_SMTP_FROM`                 | `sumity1642@gmail.com`                                                  |
| `BREVO_API_KEY`                   | Secret — not recorded                                                   |
| `EMAIL_PROVIDER`                  | `brevo-api`                                                             |
| `STORAGE_ADAPTER`                 | `azure`                                                                 |
| `AZURE_STORAGE_CONNECTION_STRING` | Secret — not recorded                                                   |
| `AZURE_STORAGE_CONTAINER`         | `roomies-uploads`                                                       |
| `ALLOWED_ORIGINS`                 | `https://roomies.sumitbuilds.app,https://roomies-api.azurewebsites.net` |
| `TRUST_PROXY`                     | `1`                                                                     |
| `DB_POOL_MAX`                     | `10`                                                                    |
| `WEBSITES_PORT`                   | `3000`                                                                  |

The 23 project-defined setting names match `.env.azure`; `WEBSITES_PORT` is the only Azure platform-added setting. Every
non-sensitive value selected above was re-read directly from Azure. Sensitive values remain intentionally excluded to
prevent credential disclosure.

### Recent Activity Log records (8–14 Aug 2026)

The retrieved activity records contain no Web App configuration write that explains the 9 Aug `lastModifiedTimeUtc`.
They show only publishing-profile / publishing-credential access:

| UTC time                     | Caller                 | Operation                      | Status    |
| ---------------------------- | ---------------------- | ------------------------------ | --------- |
| 2026-08-14T02:36:02.1230572Z | `2510090039@geu.ac.in` | Get Web App Publishing Profile | Succeeded |
| 2026-08-13T04:16:21.7425283Z | `2510090039@geu.ac.in` | Get Web App Publishing Profile | Succeeded |
| 2026-08-13T04:09:46Z         | Not populated by Azure | ListPublishingCredentials      | Succeeded |
| 2026-08-13T03:35:11Z         | Not populated by Azure | ListPublishingCredentials      | Succeeded |

---

## 8. Region availability and provider state

### Historic App Service region findings

These are retained from the 2026-07-27 provisioning attempt. They were not re-proven by creating resources during this
read-only audit.

| Region                             | Status                                  | Evidence                                                                                                        |
| ---------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Central India                      | Not deployable for this subscription    | App Service Plan creation returned `RequestDisallowedByAzure` due to the sponsored-subscription regional policy |
| Southeast Asia                     | Deployable                              | `roomies-api-plan` was successfully created there on 2026-07-27                                                 |
| South India, West India, East Asia | Untested under this subscription policy | General SKU availability must not be treated as deployability                                                   |

### Provider registration and selected runtime

| Item                     | Value      |
| ------------------------ | ---------- | ------- |
| `Microsoft.Web`          | Registered |
| `Microsoft.Storage`      | Registered |
| Selected Web App runtime | `NODE      | 22-lts` |

The CLI runtime/region-list filters in this audit returned no matching records despite the deployed runtime and existing
plan. The deployed resource is the authoritative result for this account; do not infer a subscription policy allowlist
from general `az appservice list-locations` output.

---

## 9. Resources and capabilities that do not exist

- No Azure Database for PostgreSQL; Neon remains the intended database.
- No Azure Cache for Redis; Upstash remains the intended Redis provider.
- No Key Vault.
- No actual Web App managed identity.
- No budget or cost alert.
- No Azure resource locks.
- No resource-group policy assignments.
- No custom domain bindings or certificates.
- No deployment slots.
- No VNet integration or private endpoint connections.
- No Application Insights or Azure diagnostic settings on storage, plan, or Web App.
- No storage lifecycle-management policy.

GitHub Actions secrets and GitHub deployment configuration are not Azure resources and were not queried in this
Azure-only audit. FTP/FTPS publishing is enabled by the Web App platform (`FtpsOnly`).

---

## 10. Command log

Commands used for this verification; all were read-only:

```bash
az account show
az ad signed-in-user show
az group show --name roomies-rg
az graph query -q "Resources | where resourceGroup =~ 'roomies-rg' | project id, name, type, location, resourceGroup, subscriptionId, kind, sku, tags, properties"
az role assignment list --scope /subscriptions/eaf92174-664c-4d77-b387-7f4da6bf8a36 --include-inherited
az role assignment list --scope /subscriptions/.../storageAccounts/roomiesblob --include-inherited
az lock list --resource-group roomies-rg
az policy assignment list --resource-group roomies-rg
az storage account show --name roomiesblob --resource-group roomies-rg
az storage account blob-service-properties show --account-name roomiesblob --resource-group roomies-rg
az storage account network-rule list --account-name roomiesblob --resource-group roomies-rg
az storage container list --account-name roomiesblob --auth-mode login
az storage container show --account-name roomiesblob --name roomies-uploads --auth-mode login
az storage blob list --account-name roomiesblob --container-name roomies-uploads --auth-mode login --query 'length(@)'
az storage account management-policy show --account-name roomiesblob --resource-group roomies-rg
az appservice plan show --name roomies-api-plan --resource-group roomies-rg
az webapp show --name roomies-api --resource-group roomies-rg
az webapp config show --name roomies-api --resource-group roomies-rg
az webapp identity show --name roomies-api --resource-group roomies-rg
az webapp config appsettings list --name roomies-api --resource-group roomies-rg --query '[].{name:name,slotSetting:slotSetting}'
az webapp config hostname list --webapp-name roomies-api --resource-group roomies-rg
az webapp config ssl list --resource-group roomies-rg
az webapp deployment slot list --name roomies-api --resource-group roomies-rg
az webapp vnet-integration list --resource-group roomies-rg --name roomies-api
az monitor diagnostic-settings list --resource /subscriptions/.../storageAccounts/roomiesblob
az monitor diagnostic-settings list --resource /subscriptions/.../serverfarms/roomies-api-plan
az monitor diagnostic-settings list --resource /subscriptions/.../sites/roomies-api
az provider show --namespace Microsoft.Web
az provider show --namespace Microsoft.Storage
az consumption budget list --subscription eaf92174-664c-4d77-b387-7f4da6bf8a36
az consumption usage list --start-date 2026-08-01 --end-date 2026-08-14
az monitor activity-log list --resource-id /subscriptions/.../sites/roomies-api --start-time 2026-08-08T00:00:00Z --end-time 2026-08-14T23:59:59Z
```

---

## 11. Update log

| Date       | Change                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-27 | Initial account snapshot; Storage account confirmed. App Service Plan later created in Southeast Asia after Central India was rejected by subscription policy.                                                                                                                                                                                                   |
| 2026-07-28 | Web App confirmed Running with 24 app settings.                                                                                                                                                                                                                                                                                                                  |
| 2026-08-14 | Full read-only re-verification and reference expansion. Resource Graph confirms three resources. Corrected the prior document: `keyVaultReferenceIdentity: SystemAssigned` does not mean a system-assigned identity exists; the actual identity is `null`. Added all verified storage, plan, Web App, RBAC, diagnostics, policy, and deployment-surface details. |
