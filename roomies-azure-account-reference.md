# Roomies — Azure Account Reference

**Purpose:** Factual, current-state snapshot of the Azure account, resources, and access. Not a plan — see `roomies-infra-migration-prd.md` for the execution plan. Update this file each time a new `az` command output changes reality.

**Last verified:** 2026-07-28
**Verified via:** Azure CLI (`az`), commands and raw output on file

---

## 1. Subscription

| Field | Value |
|---|---|
| Subscription name | Azure for Students |
| Subscription ID | `eaf92174-664c-4d77-b387-7f4da6bf8a36` |
| Subscription type | Free education grant (GitHub Student Developer Pack) |
| State | Enabled |
| Cloud environment | AzureCloud |
| Is default subscription | Yes |
| Home tenant ID | `1490b17d-5dc9-4cbf-aeba-a2e854f521b8` |
| Tenant display name | Graphic Era University |
| Tenant default domain | `geu.ac.in` |
| Signed-in user | `2510090039@geu.ac.in` |
| User principal ID (object ID) | `66829680-745e-4357-bfac-f8a335fe943a` |
| User type | User (not Service Principal) |

### Credit status
| Field | Value |
|---|---|
| Remaining credit | ₹9,436.54 |
| Used | 0.03% of original grant |
| Reset cycle | 45 days (per GitHub Student Pack Azure grant terms) |
| Budget configured (`az consumption budget`) | **None as of last check** — `az consumption budget list` returned `[]` |

> ⚠️ No spend alert/budget is currently configured. See PRD Phase 1.2 for the planned budget creation step.

### Known constraints of this subscription type
- Some resource types / SKUs may have quota 0 in certain regions (not yet hit, but a possibility to watch for as more services are provisioned).
- `az consumption budget create` may be rejected for CLI-level writes on student subscriptions even with Owner role — untested as of last verification; portal UI is the fallback if so.

---

## 2. Access / RBAC

| Principal | Role | Scope |
|---|---|---|
| `2510090039@geu.ac.in` (`66829680-745e-4357-bfac-f8a335fe943a`) | **Owner** | `/subscriptions/eaf92174-664c-4d77-b387-7f4da6bf8a36` (entire subscription) |
| `2510090039@geu.ac.in` | **Storage Blob Data Reader** | Scoped to `roomiesblob` storage account only — added manually on 2026-07-27 to allow `az storage blob list --auth-mode login` (Owner role alone does not grant data-plane blob access; this is expected Azure RBAC behavior, not a misconfiguration) |

No other principals, service principals, or managed identities currently have any role assignments on this subscription or resource group.

---

## 3. Resource Group

| Field | Value |
|---|---|
| Name | `roomies-rg` |
| Location | Central India |
| Provisioning state | Succeeded |
| Resource locks | None (`az lock list` returned `[]`) |
| Policy assignments | None found at storage account scope |
| Diagnostic settings | None configured (`az monitor diagnostic-settings list` returned `[]`) |

---

## 4. Resources Inside `roomies-rg`

**Known deployed resources in `roomies-rg`:** the `roomiesblob` storage account, `roomies-api-plan` App Service Plan, and `roomies-api` Web App. The initial 2026-07-27 full-inventory snapshot pre-dated App Service provisioning.

### 4.1 Storage Account — `roomiesblob`

| Field | Value |
|---|---|
| Resource ID | `/subscriptions/eaf92174-664c-4d77-b387-7f4da6bf8a36/resourceGroups/roomies-rg/providers/Microsoft.Storage/storageAccounts/roomiesblob` |
| Kind | StorageV2 |
| SKU | Standard_LRS (locally redundant) |
| Tier | Standard |
| **Location** | **Southeast Asia** — ⚠️ note this differs from the resource group's own location (Central India). Flagging because Phase 1 provisions App Service in Central India; blob storage cross-region adds latency to photo upload/delete round-trips, though likely negligible relative to Neon's own `ap-southeast-1` location. Not a blocker, just documented for awareness. |
| Creation time | 2026-04-20T07:29:58Z |
| Access tier | Hot |
| Public network access | Enabled |
| Allow blob public access | **true** |
| Allow shared key access | true |
| Default to OAuth auth | false |
| Min TLS version | TLS1_2 |
| HTTPS-only traffic | Enforced (`supportsHttpsTrafficOnly: true`) |
| Network ACL default action | Allow (no IP restrictions) |
| Provisioning state | Succeeded |
| Status | Available |

**Endpoints:**
| Service | URL |
|---|---|
| Blob | `https://roomiesblob.blob.core.windows.net/` |
| DFS | `https://roomiesblob.dfs.core.windows.net/` |
| File | `https://roomiesblob.file.core.windows.net/` |
| Queue | `https://roomiesblob.queue.core.windows.net/` |
| Table | `https://roomiesblob.table.core.windows.net/` |
| Static website | `https://roomiesblob.z23.web.core.windows.net/` (not currently enabled — see Blob Service Properties below) |

**Encryption:**
- Key source: Microsoft.Storage (platform-managed keys, not customer-managed)
- Blob encryption: enabled
- File encryption: enabled
- Infrastructure encryption (double encryption): not required/not enabled

#### 4.1.1 Blob Service Properties

| Field | Value |
|---|---|
| Soft-delete (blob) | Enabled, 7-day retention, permanent delete not allowed within window |
| Soft-delete (container) | Enabled, 7-day retention |
| Versioning | Not enabled |
| Change feed | Not enabled |
| CORS rules | **None configured** — relevant if any browser-side code ever calls the blob endpoint directly rather than through the backend |
| Static website hosting | Disabled |
| Last-access time tracking | Not enabled |
| Lifecycle management policy | **None** (`ManagementPolicyNotFound` — no automatic tiering/expiry rules exist) |

#### 4.1.2 Container — `roomies-uploads`

| Field | Value |
|---|---|
| Public access level | **blob** (individual blobs are publicly readable via direct URL; container listing is not) — this matches `AzureBlobAdapter`'s design of returning direct public URLs for listing/profile photos |
| Last modified | 2026-04-20T07:33:33Z |
| Lease state | Available / unlocked |
| Immutability policy | None |
| Legal hold | None |
| Current blob count | **0** — confirmed via `az storage blob list`, returned `[]` (empty container as of last check; expected, since it's newly created and the app isn't deployed anywhere yet) |

---

### 4.2 App Service Plan — `roomies-api-plan`

| Field | Value |
|---|---|
| Resource ID | `/subscriptions/eaf92174-664c-4d77-b387-7f4da6bf8a36/resourceGroups/roomies-rg/providers/Microsoft.Web/serverfarms/roomies-api-plan` |
| Location | **Southeast Asia** (not Central India — see §5 for why) |
| Kind | linux |
| SKU | B1 (Basic tier, family B, capacity 1) |
| Reserved (Linux flag) | true |
| Provisioning state | Succeeded |
| Status | Ready |
| Number of workers | 1 |
| Number of sites currently on plan | 1 (`roomies-api`) |
| Zone redundant | false |
| Created | 2026-07-27 |
| ⚠️ Notable field | `freeOfferExpirationTime: 2027-01-27` — plan response includes a free-offer expiration date roughly 6 months out; meaning not yet fully understood (possibly a remaining free-tier App Service allowance layered under the Student subscription). Flagged for awareness, not yet actioned. |

### 4.3 Web App — `roomies-api`

| Field | Value |
|---|---|
| Resource group | `roomies-rg` |
| App Service Plan | `roomies-api-plan` |
| Runtime | Node 22 LTS (`NODE|22-lts`) |
| Default hostname | `roomies-api.azurewebsites.net` |
| State | **Running** |
| Availability state | **Normal** |
| App Settings | **24 configured:** 23 application variables mirrored from `.env.azure`, plus `WEBSITES_PORT=3000` |
| Slot settings | All app settings reported `SlotSetting: False` (expected for a non-slot deployment) |

> **Verification note:** The response echoed by `az webapp config appsettings set` can display setting values as `null`. Do not treat that echo as authoritative. Re-run `az webapp config appsettings list`; the 2026-07-28 follow-up confirmed that all 24 settings were present.

---

## 5. Region Availability (verified for future provisioning)

⚠️ **Correction (2026-07-27):** `az appservice list-locations --sku B1 --linux-workers-enabled` reported Central India as available (listed below), but this command only reflects general SKU/region availability — it does **not** reflect subscription-level region-restriction policies. Actual App Service Plan creation in Central India failed with:

```
(RequestDisallowedByAzure) Resource 'roomies-api-plan' was disallowed by Azure: This policy
maintains a set of best available regions where your subscription can deploy resources...
```

This is a known behavior on Azure for Students / sponsored subscriptions — Azure enforces an additional subscription-scoped allowlist of regions on top of general SKU availability, and there is no single clean `az` query to list that allowlist directly. It must be discovered by attempting creation and reading the policy response, or via Azure Portal (Subscriptions → [sub] → Settings → Resource providers / Usage + quotas gives more detail than CLI in some cases).

**Confirmed NOT deployable (App Service, this subscription):**
- Central India — rejected by subscription region policy (2026-07-27)

**Confirmed DEPLOYABLE (App Service, this subscription):**
- ✅ **Southeast Asia** — App Service Plan created successfully 2026-07-27 (`roomies-api-plan`, B1 Linux). Also co-locates with the existing `roomiesblob` storage account.

Original (misleading) SKU-availability output, retained for reference only — do not treat as "deployable":

- Central India ❌ (SKU says available, subscription policy disallows — see correction above)
- South India (untested)
- West India (untested)
- Southeast Asia (where the storage account currently lives — testing now)
- East Asia (untested)
- *(+ 44 other global regions listed as SKU-available; subscription-policy status unknown for all except Central India)*

## 6. Runtime / Provider Registration State

| Item | Status |
|---|---|
| `Microsoft.Web` resource provider | **Registered** (confirmed via `az provider show`) — required before first App Service creation; this was NOT registered by default and had to be explicitly registered on 2026-07-27 |
| Node runtime available | `NODE|24-lts` (Active, EOL 2028-04-30) and `NODE|22-lts` (Near EOL, EOL 2027-04-30) |
| Node runtime selected for `roomies-api` | `NODE|22-lts` — matches `package.json` engines field (`"node": ">=22.0.0"`) |

---

## 7. What Does NOT Exist Yet (as of last verification)

Explicitly noting these as "not yet provisioned" so nothing is assumed to exist for the remaining Phase 1 work:

- ~~No App Service Plan~~ **Now exists** — `roomies-api-plan` (Southeast Asia, B1) — see §4.2
- ~~No App Service / Web App~~ **Now exists** — `roomies-api` is Running and Normal at `roomies-api.azurewebsites.net` — see §4.3
- No Azure Database for PostgreSQL (not planned — Neon stays, see PRD non-goals)
- No Azure Cache for Redis (not planned — Upstash stays)
- No Key Vault — application configuration, including sensitive values, is currently stored in Azure App Settings for the deployed Web App; a Key Vault migration has not been evaluated
- No budget or cost alert
- No custom domain bindings
- No Application Insights / monitoring
- No deployment credentials or GitHub Actions secrets configured for Azure

---

## 8. Command Log

Raw commands run to produce this snapshot, for reproducibility:

```bash
az account show
az account list -o table
az group list -o table
az resource list -g roomies-rg -o table
az group show --name roomies-rg --subscription eaf92174-664c-4d77-b387-7f4da6bf8a36 -o json
az graph query -q "Resources | project name, type, resourceGroup, location, subscriptionId, id" --subscriptions eaf92174-664c-4d77-b387-7f4da6bf8a36 -o json
az resource show --ids "/subscriptions/.../storageAccounts/roomiesblob" -o json
az storage account show --name roomiesblob --resource-group roomies-rg -o json
az storage account blob-service-properties show --account-name roomiesblob --resource-group roomies-rg -o json
az storage container list --account-name roomiesblob --auth-mode login -o json
az storage container show --account-name roomiesblob --name roomies-uploads --auth-mode login -o json
az storage account management-policy show --account-name roomiesblob --resource-group roomies-rg -o json
az monitor diagnostic-settings list --resource "/subscriptions/.../storageAccounts/roomiesblob" -o json
az lock list --resource-group roomies-rg -o json
az role assignment list --scope "/subscriptions/eaf92174-664c-4d77-b387-7f4da6bf8a36" --include-inherited -o table
az role assignment create --assignee-object-id 66829680-745e-4357-bfac-f8a335fe943a --assignee-principal-type User --role "Storage Blob Data Reader" --scope "/subscriptions/.../storageAccounts/roomiesblob"
az appservice list-locations --sku B1 --linux-workers-enabled -o table
az webapp list-runtimes --os-type linux -o table
az provider register --namespace Microsoft.Web
az provider show --namespace Microsoft.Web --query "registrationState" -o tsv
az consumption budget list
az webapp show --name roomies-api --resource-group roomies-rg --query "{state:state, defaultHostName:defaultHostName, availabilityState:availabilityState}" -o table
# Port the 23 `.env.azure` keys using values supplied outside source control; do not record values here.
az webapp config appsettings set --name roomies-api --resource-group roomies-rg --settings "WEBSITES_PORT=3000"
az webapp config appsettings list --name roomies-api --resource-group roomies-rg -o table
```

---

## 9. Update Log

| Date | What changed |
|---|---|
| 2026-07-27 | Initial snapshot created from full account audit. Confirmed: 1 resource (storage account) exists, B1 quota available in Central India, Microsoft.Web registered, no budget configured. |
| 2026-07-27 | App Service Plan `roomies-api-plan` provisioned in Southeast Asia after Central India was rejected by subscription policy. |
| 2026-07-28 | Web App `roomies-api` confirmed Running and Normal at `roomies-api.azurewebsites.net`. Its 23 `.env.azure` application variables and `WEBSITES_PORT=3000` were verified in App Settings (24 settings total); no values are recorded in this document. |
