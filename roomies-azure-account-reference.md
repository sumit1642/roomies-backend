# Roomies — Azure Account Reference

**Purpose:** A strict, safe superset of the original 2026-07-28 Azure reference. This is a factual account record, not
an execution plan; see `roomies-infra-migration-prd.md` for planned work.

**Last live verification:** 2026-08-16 (UTC) — GitHub deploy configuration, GitHub repo secrets presence, OIDC role assignment, and App Settings names/value parity with `.env.azure` were re-verified during the first live deploy debugging session; other sections retain their earlier timestamps unless individually noted.

**Safety rule:** No credential, token, password, connection
string, key, or publishing credential is recorded. App-setting values are not retained; only names and sanitized host/context notes are recorded.

## Evidence labels

- **[Graph verified]** Azure Resource Graph result from this audit.
- **[CLI verified]** Targeted, read-only Azure CLI result from this audit.
- **[Historical]** Detail retained from the original 2026-07-28 reference or prior provisioning evidence; it is not
  represented as current unless also live verified.
- **[Unavailable]** The source cannot expose the field safely or the documented query failed; the failure and fallback
  are recorded.

The audit starts every resource, RBAC, and policy check in Resource Graph. A `[]` CLI result is treated as conclusive
only where the matching Graph query or a Graph-supported parent property corroborates it. Resource Graph is optimized
for inventory and property discovery; its supported tables include the relevant `Resources`, `AuthorizationResources`,
and `PolicyResources` records.
[Microsoft Learn: Resource Graph](https://learn.microsoft.com/en-us/azure/governance/resource-graph/concepts/explore-resources)

---

## 1. Subscription and grant context

| Field                                      | Value                                                                                                          | Source                                                                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Subscription name                          | Azure for Students                                                                                             | [CLI verified]                                                                                                         |
| Subscription ID                            | `eaf92174-664c-4d77-b387-7f4da6bf8a36`                                                                         | [CLI verified]                                                                                                         |
| Subscription state                         | Enabled                                                                                                        | [CLI verified]                                                                                                         |
| Tenant ID                                  | `1490b17d-5dc9-4cbf-aeba-a2e854f521b8`                                                                         | [CLI verified]                                                                                                         |
| Signed-in principal                        | `2510090039@geu.ac.in` (user)                                                                                  | [CLI verified]                                                                                                         |
| Cloud environment / default subscription   | AzureCloud / `true`                                                                                            | [Historical] — retained from old account snapshot; not re-queried in this narrow audit.                                |
| Tenant display name / default domain       | Graphic Era University / `geu.ac.in`                                                                           | [Historical]                                                                                                           |
| User display name / object ID              | Sumeet Yadav / `66829680-745e-4357-bfac-f8a335fe943a`                                                          | [Historical] — object ID is corroborated by live RBAC.                                                                 |
| Subscription type                          | Free education grant through GitHub Student Developer Pack                                                     | [Historical]                                                                                                           |
| Remaining credit                           | ₹9,436.54                                                                                                      | [Historical] — 2026-07-28 value, not current.                                                                          |
| Used percentage                            | 0.03% of original grant                                                                                        | [Historical] — 2026-07-28 value, not current.                                                                          |
| Reset cycle                                | 45 days                                                                                                        | [Historical] — 2026-07-28 value, not current.                                                                          |
| Current grant balance / percentage / reset | Not obtained                                                                                                   | [Unavailable] — this audit did not read portal-only grant-balance data.                                                |
| August 2026 consumption usage query        | 16 rows for `roomies-api` and `roomiesblob`; every row was previously recorded with null cost and date fields. | [Historical] — retained from the pre-rebuild reference; it is not a current cost figure.                               |
| Budget resources                           | No budget resource                                                                                             | [Graph verified] `microsoft.consumption/budgets` count `0`; [CLI verified] `az consumption budget list` returned `[]`. |
| Budget-alert warning                       | No Azure budget or cost alert is documented                                                                    | [Graph verified] and [CLI verified] as above.                                                                          |

The historical warning remains applicable: student subscriptions can impose resource/SKU restrictions, and Azure CLI
budget creation may require a portal fallback. [Historical]

---

## 2. Live Resource Graph inventory

Resource Graph reports **3 resources** in `roomies-rg`; the reported resource-type set is exactly the three entries
below. [Graph verified]

| Type                                | Name               | Resource group | Location        | State / SKU                 | Source                           |
| ----------------------------------- | ------------------ | -------------- | --------------- | --------------------------- | -------------------------------- |
| `microsoft.storage/storageaccounts` | `roomiesblob`      | `roomies-rg`   | `southeastasia` | Succeeded / `Standard_LRS`  | [Graph verified], [CLI verified] |
| `microsoft.web/serverfarms`         | `roomies-api-plan` | `roomies-rg`   | `southeastasia` | Succeeded, Ready / B1 Basic | [Graph verified], [CLI verified] |
| `microsoft.web/sites`               | `roomies-api`      | `roomies-rg`   | `southeastasia` | Running, Normal / Basic     | [Graph verified], [CLI verified] |

No fourth resource is inferred from an empty normal CLI listing: the count and exact type set above are Graph-derived.
[Graph verified]

---

## 3. Access, RBAC, and managed identity

As of 2026-08-14, `AuthorizationResources` returned 3 role-assignment resources (subscription-level Owner ×2, plus
Storage Blob Data Reader on `roomiesblob`). A 4th assignment was added 2026-08-15 for GitHub Actions OIDC federation
(CLI-verified independently; Resource Graph was not re-queried for this addition — see row below). [Graph verified] (rows 1–3), [CLI verified] (rows 1–4)

| Assignment ID                          | Principal                                                       | Principal type | Role                     | Scope                         | Created              | Source                           |
| -------------------------------------- | --------------------------------------------------------------- | -------------- | ------------------------ | ----------------------------- | -------------------- | -------------------------------- |
| `e533e20d-1f17-4851-b233-12e07d7ab9ce` | `2510090039@geu.ac.in` (`66829680-745e-4357-bfac-f8a335fe943a`) | User           | Owner                    | subscription                  | 2025-09-10T14:19:26Z | [Graph verified], [CLI verified] |
| `8cf8edf1-1552-4095-8a33-80244b6e6a87` | same principal                                                  | User           | Owner                    | subscription                  | 2025-09-10T14:19:26Z | [Graph verified], [CLI verified] |
| `788b8371-533b-4229-b214-0899054bd13c` | same principal                                                  | User           | Storage Blob Data Reader | `roomiesblob` storage account | 2026-07-27T02:54:17Z | [Graph verified], [CLI verified] |
| `387eb9fc-9ce0-4568-a5e0-448be2b3f6d3` | `roomies-api-github-oidc` service principal (`55431d16-3577-4c3f-a97b-ffa03d2e5b2c`) | Service Principal | Contributor | `roomies-rg` (resource group) | 2026-08-15T02:12:23Z | [CLI verified] |

The two Owner assignments are duplicates at the same subscription scope. The Storage Blob Data Reader assignment is the
data-plane access used for `--auth-mode login`; subscription Owner does not by itself establish Blob data-plane
authorization. [Graph verified], [Historical]


### GitHub Actions OIDC federation (added 2026-08-15)

A dedicated App Registration was created to allow GitHub Actions to authenticate to Azure via
OIDC (workload identity federation), with no client secret stored anywhere.

| Field | Value | Source |
|---|---|---|
| App Registration display name | `roomies-api-github-oidc` | [CLI verified] |
| Application (client) ID | `1d2282ba-5347-4153-a18a-16b95a18068e` | [CLI verified] |
| Application object ID | `880d4a39-fb7f-454b-8c15-e84d6cc4dfb1` | [CLI verified] |
| Service principal object ID | `55431d16-3577-4c3f-a97b-ffa03d2e5b2c` | [CLI verified] |
| Sign-in audience | `AzureADMyOrg` | [CLI verified] |
| Federated credential name | `roomies-api-main-branch-deploy` | [CLI verified] |
| Federated credential issuer | `https://token.actions.githubusercontent.com` | [CLI verified] |
| Federated credential subject | `repo:sumit1642/roomies-backend:ref:refs/heads/main` | [CLI verified] |
| Federated credential audience | `api://AzureADTokenExchange` | [CLI verified] |
| Client secret | None — not created, not needed for OIDC | [CLI verified] |
| Federation scope | `main`-branch pushes only. `tier0` (the active development branch) and pull requests have **no** Azure federation — they continue to run only `ci.yml`'s existing `npm ci` test step. | [CLI verified] |
| Role assignment | `Contributor` at `roomies-rg` scope (see updated role-assignment table above) | [CLI verified] |

**Repo/branch context:** `main` (`https://github.com/sumit1642/roomies-backend`) is the deploy
branch; it currently holds minimal content. `tier0`
(`https://github.com/sumit1642/roomies-backend/tree/tier0`) is the active development branch
holding the full application. The operator's stated plan is to merge `tier0` → `main`, and that
merge (a push to `main`) now triggers `.github/workflows/deploy.yml`, the Azure deploy workflow added on 2026-08-16.

**Scope decision rationale:** `Contributor` was assigned at the `roomies-rg` resource-group
level rather than scoped to the single `roomies-api` Web App resource. This was a deliberate
choice, made after the tighter resource-level scope was initially recommended: the operator
intends to migrate the database and other services into this same resource group later, and
deploys are solo-triggered, reducing the multi-contributor compromise surface that motivated the
tighter recommendation. This broadens the blast radius of a compromised `main`-branch workflow
run (or a leaked `AZURE_CLIENT_ID` combined with the federation trust) to include `roomiesblob`
and `roomies-api-plan`, not just `roomies-api` — noted here so a future audit doesn't need to
re-derive the reasoning.

| Managed-identity field                                   | Result           | Source                           |
| -------------------------------------------------------- | ---------------- | -------------------------------- |
| Web App `keyVaultReferenceIdentity`                      | `SystemAssigned` | [Graph verified], [CLI verified] |
| Web App `identity` object                                | `null`           | [Graph verified], [CLI verified] |
| `az webapp identity show`                                | Empty output     | [CLI verified]                   |
| Actual system-assigned or user-assigned managed identity | **None exists**  | [Graph verified], [CLI verified] |

`keyVaultReferenceIdentity: SystemAssigned` is a setting, not proof of an assigned identity. There is no usable managed
identity and no Key Vault resource. [Graph verified], [CLI verified]

---

## 4. Subscription policy and resource group

### `sys.regionrestriction`

`PolicyResources` returned exactly **1** subscription policy assignment. [Graph verified]

| Field                                            | Value                                                                                                                                  | Source                                                                                                         |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Assignment name / display name                   | `sys.regionrestriction` / Allowed resource deployment regions                                                                          | [Graph verified]                                                                                               |
| Scope                                            | subscription                                                                                                                           | [Graph verified]                                                                                               |
| Assignment type / enforcement                    | System / Default                                                                                                                       | [Graph verified]                                                                                               |
| Definition                                       | `b86dabb9-b578-4d7b-b842-3b45e95769a1`                                                                                                 | [Graph verified]                                                                                               |
| Allowed regions                                  | `koreacentral`, `malaysiawest`, `eastasia`, `uaenorth`, `southeastasia`                                                                | [Graph verified]                                                                                               |
| Region-policy reason                             | The policy’s own non-compliance message says it constrains deployment to regions with full service access and optimal performance.     | [Graph verified]                                                                                               |
| Direct `az policy assignment show/list` fallback | Not available through this installed CLI: both documented scoped forms returned `usage error: --scope SCOPE \| --resource-group NAME`. | [Unavailable] — Graph exposes the complete assignment and parameter list, so it is the authoritative fallback. |

### Resource group — `roomies-rg`

| Field                             | Value                                                                           | Source                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Resource ID                       | `/subscriptions/eaf92174-664c-4d77-b387-7f4da6bf8a36/resourceGroups/roomies-rg` | [Graph verified], [CLI verified]                                                                                                     |
| Location                          | `centralindia` (Central India)                                                  | [Graph verified], [CLI verified]                                                                                                     |
| Provisioning state                | Succeeded                                                                       | [Graph verified], [CLI verified]                                                                                                     |
| Tags / managed by                 | `null` or none / `null`                                                         | [CLI verified]                                                                                                                       |
| Resource locks                    | None                                                                            | [Graph verified] `microsoft.authorization/locks` count `0`; [CLI verified] `az lock list --resource-group roomies-rg` returned `[]`. |
| Resource-group policy assignments | None at the RG scope                                                            | [Graph verified] — the only policy assignment has subscription scope.                                                                |
| RG diagnostic settings            | None documented                                                                 | [Historical] — old reference reported `[]`; this audit checked diagnostics on the three actual resources instead.                    |

---

## 5. Storage account — `roomiesblob`

### Account and network properties

| Field                                                | Value                                                             | Source                                             |
| ---------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| Resource ID / kind                                   | `.../Microsoft.Storage/storageAccounts/roomiesblob` / StorageV2   | [Graph verified], [CLI verified]                   |
| Location / primary location                          | Southeast Asia / `southeastasia`                                  | [Graph verified], [CLI verified]                   |
| SKU / tier                                           | Standard_LRS (locally redundant) / Standard                       | [Graph verified], [CLI verified]                   |
| Creation time                                        | 2026-04-20T07:29:58Z                                              | [Graph verified], [CLI verified]                   |
| Access tier                                          | Hot                                                               | [Graph verified], [CLI verified]                   |
| Provisioning state / status                          | Succeeded / available                                             | [Graph verified], [CLI verified]                   |
| Public network access                                | Enabled                                                           | [Graph verified], [CLI verified]                   |
| Allow blob public access                             | `true`                                                            | [Graph verified], [CLI verified]                   |
| Allow shared-key access / default OAuth              | `true` / `false`                                                  | [Graph verified], [CLI verified]                   |
| Minimum TLS / HTTPS-only                             | TLS 1.2 / enforced                                                | [Graph verified], [CLI verified]                   |
| Network ACL                                          | Default Allow; bypass AzureServices; no IPv4, IPv6, or VNet rules | [Graph verified], [CLI verified]                   |
| Private endpoints                                    | `[]`                                                              | [Graph verified], [CLI verified]                   |
| Tags / identity                                      | none / `null`                                                     | [CLI verified]                                     |
| Cross-tenant replication / delegation SAS            | `false` / `false`                                                 | [Graph verified], [CLI verified]                   |
| Hierarchical namespace / NFS v3 / SFTP / local users | `null` / `null` / `null` / `null`                                 | [Historical] — pre-rebuild safe resource response. |
| Secondary location/endpoints / geo-failover fields   | `null`                                                            | [Historical] — pre-rebuild safe resource response. |

The storage account is intentionally in Southeast Asia while its resource group is Central India. The old reference’s
proposed Central India App Service placement is historical; the live subscription policy now explains why the deployed
plan is instead co-located with storage in Southeast Asia. [Graph verified], [Historical]

### Endpoints and encryption

| Field                                                  | Value                                           | Source                                             |
| ------------------------------------------------------ | ----------------------------------------------- | -------------------------------------------------- |
| Blob endpoint                                          | `https://roomiesblob.blob.core.windows.net/`    | [Graph verified], [CLI verified]                   |
| DFS endpoint                                           | `https://roomiesblob.dfs.core.windows.net/`     | [Graph verified], [CLI verified]                   |
| File endpoint                                          | `https://roomiesblob.file.core.windows.net/`    | [Graph verified], [CLI verified]                   |
| Queue endpoint                                         | `https://roomiesblob.queue.core.windows.net/`   | [Graph verified], [CLI verified]                   |
| Table endpoint                                         | `https://roomiesblob.table.core.windows.net/`   | [Graph verified], [CLI verified]                   |
| Static-web endpoint                                    | `https://roomiesblob.z23.web.core.windows.net/` | [Graph verified], [CLI verified]                   |
| Key source                                             | Microsoft.Storage (platform-managed)            | [Graph verified], [CLI verified]                   |
| Blob / file encryption                                 | enabled / enabled, Account key type             | [Graph verified], [CLI verified]                   |
| Infrastructure (double) encryption                     | not required / false                            | [Graph verified], [CLI verified]                   |
| Customer Key Vault properties / queue-table encryption | `null` / `null`                                 | [Historical] — pre-rebuild safe resource response. |
| Account key-creation timestamps                        | key1 and key2: 2026-04-20T07:29:58Z             | [Graph verified], [CLI verified]                   |

### Blob-service and container properties

| Field                                                                | Value                                                              | Source                                                                                                                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Blob soft delete                                                     | enabled, 7 days, permanent delete disabled                         | [CLI verified]                                                                                                                                                                 |
| Container soft delete                                                | enabled, 7 days                                                    | [CLI verified]                                                                                                                                                                 |
| Versioning / change feed / last-access tracking                      | not enabled (`null`) / not enabled (`null`) / not enabled (`null`) | [CLI verified]                                                                                                                                                                 |
| CORS rules                                                           | none (`[]`)                                                        | [CLI verified]                                                                                                                                                                 |
| Static website hosting                                               | disabled                                                           | [CLI verified]                                                                                                                                                                 |
| Static-website index / 404 documents                                 | `null` / `null`                                                    | [CLI verified]                                                                                                                                                                 |
| Restore policy / default service version / automatic snapshot policy | `null` / `null` / `null`                                           | [Historical] — pre-rebuild safe response fields.                                                                                                                               |
| Lifecycle-management policy                                          | None                                                               | [Historical] — prior management-plane result was `ManagementPolicyNotFound`; not re-run because it is a known absence and the original failure evidence is retained.           |
| Container name                                                       | `roomies-uploads`                                                  | [CLI verified]                                                                                                                                                                 |
| Container Graph representation                                       | none                                                               | [Graph verified] — `Resources` contains no `microsoft.storage/storageaccounts/blobservices/containers` record; this data-plane object is verified through the scoped Blob CLI. |
| Public access                                                        | `blob` — individual blobs are publicly readable; listing is not    | [CLI verified]                                                                                                                                                                 |
| Last modified                                                        | 2026-04-20T07:33:33Z                                               | [CLI verified]                                                                                                                                                                 |
| Lease state / status                                                 | available / unlocked                                               | [CLI verified]                                                                                                                                                                 |
| Immutability policy / legal hold                                     | none / none                                                        | [CLI verified]                                                                                                                                                                 |
| Blob count                                                           | 0                                                                  | [CLI verified] `az storage blob list ... --query '[].name'` returned `[]`; the parent storage resource is corroborated by Graph.                                               |
| Only container returned                                              | `roomies-uploads`                                                  | [Historical] — pre-rebuild container-list result; the scoped show confirms this named container live.                                                                          |
| ETag / metadata                                                      | `"0x8DE9EAF20C1B678"` / `{}`                                       | [Historical] — pre-rebuild safe data-plane response.                                                                                                                           |
| Default encryption scope / override prevention                       | `$account-encryption-key` / `false`                                | [Historical] — pre-rebuild safe data-plane response.                                                                                                                           |
| Immutable storage with versioning / deleted / version                | `false` / `null` / `null`                                          | [Historical] — pre-rebuild safe data-plane response.                                                                                                                           |

---

## 6. App Service Plan — `roomies-api-plan`

| Field                                           | Value                                                                          | Source                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Resource ID                                     | `.../Microsoft.Web/serverfarms/roomies-api-plan`                               | [Graph verified], [CLI verified]                                                                     |
| Location / kind                                 | Southeast Asia / `linux`                                                       | [Graph verified], [CLI verified]                                                                     |
| SKU                                             | B1, Basic, family B, capacity 1                                                | [Graph verified], [CLI verified]                                                                     |
| Reserved Linux flag                             | `true`                                                                         | [Graph verified], [CLI verified]                                                                     |
| Compute mode / plan name                        | Dedicated / VirtualDedicatedPlan                                               | [Graph verified], [CLI verified]                                                                     |
| Provisioning state / status / power state       | Succeeded / Ready / Running                                                    | [Graph verified], [CLI verified]                                                                     |
| Workers / sites                                 | 1 / 1 (`roomies-api`)                                                          | [Graph verified], [CLI verified]                                                                     |
| Worker size                                     | Small                                                                          | [Graph verified], [CLI verified]                                                                     |
| Current worker size ID / current zones utilized | 0 / 1                                                                          | [Graph verified], [CLI verified]                                                                     |
| Created                                         | 2026-07-27T04:16:26Z                                                           | [Graph verified], [CLI verified]                                                                     |
| Zone redundant                                  | `false`                                                                        | [Graph verified], [CLI verified]                                                                     |
| Per-site / elastic / async scale                | `false` / `false` / `false`                                                    | [Graph verified], [CLI verified]                                                                     |
| Maximum workers / elastic workers / zones       | 3 / 1 / 1                                                                      | [Graph verified], [CLI verified]                                                                     |
| VNet connections used / maximum                 | 0 / 2                                                                          | [Graph verified], [CLI verified]                                                                     |
| Spot / custom mode / Xenon / Hyper-V            | all `false`                                                                    | [Graph verified], [CLI verified]                                                                     |
| Web space / MDM ID / server farm ID             | `roomies-rg-SoutheastAsiawebspace-Linux` / `waws-prod-sg1-089_31656` / `31656` | [Graph verified], [CLI verified]                                                                     |
| Free-offer expiration                           | 2027-01-27T04:16:24Z; meaning not established                                  | [Graph verified], [CLI verified]                                                                     |
| Tags / plan diagnostic settings                 | `null` / none                                                                  | [CLI verified] — diagnostics call returned `[]`; Graph confirms this is one of only three resources. |

---

## 7. Web App — `roomies-api`

### Core and network properties

| Field                                          | Value                                                                                                                                                                                                  | Source                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Resource ID / type / kind                      | `.../Microsoft.Web/sites/roomies-api` / Microsoft.Web/sites / `app,linux`                                                                                                                              | [Graph verified], [CLI verified]                                                                                            |
| Location / App Service Plan                    | Southeast Asia / `roomies-api-plan`                                                                                                                                                                    | [Graph verified], [CLI verified]                                                                                            |
| State / availability / runtime availability    | Running / Normal / Normal                                                                                                                                                                              | [Graph verified]                                                                                                            |
| Enabled / public network access / HTTPS-only   | `true` / Enabled / `false`                                                                                                                                                                             | [Graph verified]                                                                                                            |
| Default hostname / enabled hostnames           | `roomies-api.azurewebsites.net` / standard and SCM Azure hostnames                                                                                                                                     | [Graph verified]                                                                                                            |
| SKU / last modified                            | Basic / 2026-08-09T13:35:30Z                                                                                                                                                                           | [Graph verified]                                                                                                            |
| Client certificate / mode                      | disabled / Required                                                                                                                                                                                    | [Graph verified]                                                                                                            |
| Client affinity / proxy affinity / IP mode     | `true` / `false` / IPv4                                                                                                                                                                                | [Graph verified]                                                                                                            |
| Tags / managed environment / private endpoints | `null` / `null` / `[]`                                                                                                                                                                                 | [Graph verified], [CLI verified]                                                                                            |
| In-flight features / end-to-end encryption     | `["SiteContainers"]` / `false`                                                                                                                                                                         | [Graph verified]                                                                                                            |
| VNet subnet / VNet integration                 | `null` / none                                                                                                                                                                                          | [Graph verified]; [CLI verified] `az webapp vnet-integration list` returned `[]`.                                           |
| Deployment slots                               | none                                                                                                                                                                                                   | [CLI verified] `az webapp deployment slot list` returned `[]`; Graph confirms no additional `Microsoft.Web/sites` resource. |
| Web App diagnostic settings                    | none                                                                                                                                                                                                   | [CLI verified] scoped diagnostics returned `[]`; Graph confirms the three-resource inventory.                               |
| Inbound IPv4 / IPv6                            | `20.212.64.12,20.212.79.14` / `2603:1040:5:4::d`                                                                                                                                                       | [Graph verified]                                                                                                            |
| Current outbound IPv4 count / IPv6 count       | 8 / 10                                                                                                                                                                                                 | [Graph verified]                                                                                                            |
| Current outbound IPv4                          | `20.43.151.254,20.44.216.33,20.44.216.231,20.44.216.245,20.43.151.165,20.44.218.63,20.212.64.12,20.212.79.14`                                                                                          | [Graph verified]                                                                                                            |
| Current outbound IPv6                          | `2603:1040:2:e::aa,2603:1040:2:6::96,2603:1040:2:b::95,2603:1040:2:d::9a,2603:1040:2:c::a8,2603:1040:2:f::a7,2603:1040:5:4::d,2603:10e1:100:2::14d4:400c,2603:1040:5:4::34,2603:10e1:100:2::14d4:4f0e` | [Graph verified]                                                                                                            |
| Possible outbound IPv4 count / IPv6 count      | 27 / 30                                                                                                                                                                                                | [Graph verified]                                                                                                            |
| Outbound VNet routing flags                    | all false                                                                                                                                                                                              | [Graph verified]                                                                                                            |

### Runtime and configuration surface

| Field                                                               | Value                                                                                                                                     | Source                                                     |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Deployed runtime stack                                              | `NODE\|22-lts`                                                                                                                            | [Graph verified], [CLI verified]                           |
| Always On                                                           | `false`                                                                                                                                   | [CLI verified]                                             |
| Minimum TLS / SCM minimum TLS                                       | 1.2 / 1.2                                                                                                                                 | [CLI verified]                                             |
| FTPS state                                                          | FtpsOnly                                                                                                                                  | [CLI verified]                                             |
| HTTP/2 / WebSockets                                                 | `false` / `false`                                                                                                                         | [CLI verified]                                             |
| Health check / remote debugging                                     | `null` / `false`                                                                                                                          | [CLI verified]                                             |
| 32-bit worker / worker count / load balancing                       | `true` / 1 / LeastRequests                                                                                                                | [CLI verified]                                             |
| SCM type / command line / connection strings / site CORS            | None / empty / `null` / `null`                                                                                                            | [CLI verified]                                             |
| Website timezone / web jobs                                         | `null` / `null` in config response                                                                                                        | [CLI verified]                                             |
| HTTP/2 proxy / auto-heal / detailed errors / tracing / HTTP logging | `0` / all `false`                                                                                                                         | [CLI verified]                                             |
| Pre-warmed / minimum elastic instances                              | 0 / 0                                                                                                                                     | [CLI verified]                                             |
| Main and SCM IP restrictions                                        | One `Allow all` rule for `Any`, priority 2147483647, at each surface                                                                      | [CLI verified]                                             |
| SCM uses main restrictions / Azure Storage mounts                   | `false` / `{}`                                                                                                                            | [CLI verified]                                             |
| Default documents                                                   | `Default.htm`, `Default.html`, `Default.asp`, `index.htm`, `index.html`, `iisstart.htm`, `default.aspx`, `index.php`, `hostingstart.html` | [CLI verified]                                             |
| Virtual application                                                 | `/` to `site\\wwwroot`; preload `false`                                                                                                   | [CLI verified]                                             |
| Hostname binding count / binding type                               | 1 / Verified Azure platform hostname                                                                                                      | [CLI verified]                                             |
| Hostname SSL state / thumbprint / virtual IP                        | `null` / `null` / `null`                                                                                                                  | [CLI verified]                                             |
| Custom-domain bindings / certificates                               | none / `[]`                                                                                                                               | [CLI verified]                                             |
| Publishing credentials                                              | Not inspected and not recorded                                                                                                            | [Unavailable] — prohibited by this document’s safety rule. |

### App Settings

The scoped app-settings query found **24 names**; all have `slotSetting: false`. Values were checked only for parity against `.env.azure` during the 2026-08-16 incident fix and are still not recorded here. Azure
documents that App Service app settings are encrypted at rest and injected into the app environment, which is why this
reference retains names but no secret values. [CLI verified],
[Microsoft Learn](https://learn.microsoft.com/en-us/azure/app-service/configure-common?tabs=portalfli)

| Setting name                      | Stored value                                        | Source         |
| --------------------------------- | --------------------------------------------------- | -------------- |
| `NODE_ENV`                        | `<stored in Azure App Settings; not recorded here>` | [CLI verified] |
| `PORT`                            | `<stored in Azure App Settings; not recorded here>` | [CLI verified] |
| `DATABASE_URL`                    | `<stored in Azure App Settings; not recorded here>` | [CLI verified] |
| `REDIS_URL`                       | `<stored in Azure App Settings; not recorded here>` | [CLI verified] |
| `JWT_SECRET`                      | `<stored in Azure App Settings; not recorded here>` | [CLI verified] |
| `JWT_REFRESH_SECRET`              | `<stored in Azure App Settings; not recorded here>` | [CLI verified] |
| `JWT_EXPIRES_IN`                  | `<stored in Azure App Settings; not recorded here>` | [CLI verified] |
| `JWT_REFRESH_EXPIRES_IN`          | `<stored in Azure App Settings; not recorded here>` | [CLI verified] |
| `GOOGLE_CLIENT_ID`                | `<stored in Azure App Settings; not recorded here>` | [CLI verified] |
| `GOOGLE_CLIENT_SECRET`            | `<stored in Azure App Settings; not recorded here>` | [CLI verified] |
| `BREVO_SMTP_SERVER`               | `<stored in Azure App Settings; not recorded here>` | [CLI verified] |
| `BREVO_SMTP_PORT`                 | `<stored in Azure App Settings; not recorded here>` | [CLI verified] |
| `BREVO_SMTP_LOGIN`                | `<stored in Azure App Settings; not recorded here>` | [CLI verified] |
| `BREVO_SMTP_KEY`                  | `<stored in Azure App Settings; not recorded here>` | [CLI verified] |
| `BREVO_SMTP_FROM`                 | `<stored in Azure App Settings; not recorded here>` | [CLI verified] |
| `BREVO_API_KEY`                   | `<stored in Azure App Settings; not recorded here>` | [CLI verified] |
| `EMAIL_PROVIDER`                  | `<stored in Azure App Settings; not recorded here>` | [CLI verified] |
| `STORAGE_ADAPTER`                 | `<stored in Azure App Settings; not recorded here>` | [CLI verified] |
| `AZURE_STORAGE_CONNECTION_STRING` | `<stored in Azure App Settings; not recorded here>` | [CLI verified] |
| `AZURE_STORAGE_CONTAINER`         | `<stored in Azure App Settings; not recorded here>` | [CLI verified] |
| `ALLOWED_ORIGINS`                 | `<stored in Azure App Settings; not recorded here>` | [CLI verified] |
| `TRUST_PROXY`                     | `<stored in Azure App Settings; not recorded here>` | [CLI verified] |
| `DB_POOL_MAX`                     | `<stored in Azure App Settings; not recorded here>` | [CLI verified] |
| `WEBSITES_PORT`                   | `<stored in Azure App Settings; not recorded here>` | [CLI verified] |

**Historical verification note:** the original 2026-07-28 follow-up verified 23 `.env.azure` variables plus
`WEBSITES_PORT` and warned that the `appsettings set` echo can show `null` values. The list operation, not that echo, is
the authoritative presence check. On 2026-08-16, a startup failure revealed that Azure `DATABASE_URL` still pointed at a stale Neon host (`ep-divine-field-a16dgg7p-pooler.ap-southeast-1`). It was replaced with the verified `.env.azure` Neon target (`ep-gentle-meadow-ax07bhxf-pooler.c-4.us-east-2`), and all 24 App Settings were re-listed for parity with `.env.azure`; values remain intentionally omitted from this reference. [Historical], [CLI verified]

**Pre-rebuild value handling:** the immediately preceding reference displayed some non-secret setting values. Those
fields are retained above by name, but all values are now uniformly replaced by the required placeholder so this
reference cannot leak a value that later becomes sensitive. [Historical], [CLI verified]

### Historical activity evidence

The pre-rebuild activity-log excerpt contained four successful deployment-profile/authentication events between
2026-08-13 and 2026-08-14 and no configuration write explaining the 9 Aug modification timestamp. Event operation names,
profile references, and timestamps are intentionally not copied because this reference prohibits publishing material.
[Historical]

---

## 8. Region, runtime, and provider evidence

| Item                                     | Result                                                                                                                                                                                                                       | Source                                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Central India App Service deployability  | Rejected on 2026-07-27 with `RequestDisallowedByAzure` under the sponsored-subscription region policy.                                                                                                                       | [Historical] — no resource-creation probe was performed in this read-only audit.                                            |
| Southeast Asia deployability             | Confirmed by the successful deployed plan and Web App.                                                                                                                                                                       | [Graph verified], [CLI verified]                                                                                            |
| South India / West India / East Asia     | Untested for this subscription, except East Asia is in the current policy’s allowed list.                                                                                                                                    | [Historical], [Graph verified]                                                                                              |
| `Microsoft.Web` provider                 | Registered                                                                                                                                                                                                                   | [CLI verified]                                                                                                              |
| `Microsoft.Storage` provider             | Registered                                                                                                                                                                                                                   | [CLI verified]                                                                                                              |
| Available App Service Linux Node runtime | `NODE\|24-lts`, Active, Azure CLI EOL `2028-04-30`; `NODE\|22-lts`, Near, Azure CLI EOL `2027-04-30`.                                                                                                                        | [CLI verified]                                                                                                              |
| Deployed Node runtime                    | `NODE\|22-lts`                                                                                                                                                                                                               | [Graph verified], [CLI verified]                                                                                            |
| Node Project public schedule             | Node 22 is shown as LTS with a 2026-06-22 date; this conflicts with the platform runtime inventory above. Treat Azure’s advertised runtime state as deployment availability and plan an upgrade after checking both sources. | [Unavailable] — external schedule conflict recorded from [Node.js Releases](https://nodejs.org/en/about/previous-releases). |
| Old `package.json` compatibility claim   | The old document recorded `engines.node: >=22.0.0` compatibility.                                                                                                                                                            | [Historical] — not used as a live Azure assertion.                                                                          |

---

## 9. Explicit “does not exist” inventory

| Item                                                      | Finding                               | Source                                                                                            |
| --------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Azure Database for PostgreSQL                             | None                                  | [Graph verified] — no flexible-server resource; Neon remains the intended database.               |
| Azure Cache for Redis                                     | None                                  | [Graph verified] — no Redis resource; Upstash remains the intended Redis provider.                |
| Key Vault                                                 | None                                  | [Graph verified]                                                                                  |
| Managed identity                                          | None                                  | [Graph verified], [CLI verified]                                                                  |
| Budget / cost alert                                       | None                                  | [Graph verified], [CLI verified]                                                                  |
| Resource locks                                            | None                                  | [Graph verified], [CLI verified]                                                                  |
| Extra Azure resources in `roomies-rg`                     | None                                  | [Graph verified] — inventory count is 3.                                                          |
| Application Insights                                      | None                                  | [Graph verified] — no `microsoft.insights/components` resource.                                   |
| Storage, plan, and Web App diagnostic settings            | None                                  | [CLI verified] — each resource-scoped query returned `[]`; Graph confirms the resource inventory. |
| Deployment slots                                          | None                                  | [CLI verified] — scoped list returned `[]`; Graph has only one Web App parent resource.           |
| VNet integration / private endpoint connection            | None                                  | [Graph verified], [CLI verified]                                                                  |
| Storage lifecycle-management policy                       | None documented                       | [Historical] — prior `ManagementPolicyNotFound` result retained.                                  |
| Custom domain bindings / certificates                     | None documented                       | [Historical] — prior resource-scoped lists were empty.                                            |
| Azure deployment credentials (secrets/passwords/publish profiles) | None exist — OIDC federation was chosen specifically to avoid this class of credential. A GitHub Actions OIDC identity (App Registration + federated credential + service principal + RBAC role) now exists as of 2026-08-15 — see §3, "GitHub Actions OIDC federation." That identity has no password, secret, or certificate credential attached. | [CLI verified] |
| GitHub Actions deployment configuration or GitHub secrets | Deploy workflow exists and repo secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID` were confirmed present on 2026-08-16; secret values are not recorded. | [CLI verified] |

---

## 10. Evidence command log

All commands below were read-only. The listed output was either fully non-secret or projected to a safe subset.

| Command / scope                                                        | Result                                                                                 | Source                           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------- |
| `az account show`                                                      | active Azure for Students subscription and signed-in user                              | [CLI verified]                   |
| Graph `Resources` at subscription                                      | 3 resources                                                                            | [Graph verified]                 |
| Graph `AuthorizationResources` role assignments                        | 3 assignments                                                                          | [Graph verified]                 |
| Graph `PolicyResources` policy assignments                             | 1 assignment: `sys.regionrestriction`                                                  | [Graph verified]                 |
| Scoped `az role assignment list` at subscription and storage account   | corroborates the 3 Graph assignments                                                   | [CLI verified]                   |
| Scoped policy CLI `show` and `list`                                    | both failed with `usage error: --scope SCOPE \| --resource-group NAME`                 | [Unavailable]                    |
| `az resource show` / `az webapp config show`                           | corroborates resource and safe configuration properties                                | [CLI verified]                   |
| Graph container query then Blob data-plane CLI                         | Graph count 0 for container resources; CLI verifies `roomies-uploads`, then zero blobs | [Graph verified], [CLI verified] |
| App-settings list with name-only projection                            | 24 names, all non-slot                                                                 | [CLI verified]                   |
| Graph absence query plus locks, diagnostics, slots, and VNet CLI       | Graph absence set count 0; all resource-scoped lists returned `[]`                     | [Graph verified], [CLI verified] |
| `az webapp list-runtimes --os-type linux --runtime node --support all` | Node 24 Active, Node 22 Near, Node 20/18 EOL                                           | [CLI verified]                   |
| Graph budget query plus `az consumption budget list`                   | Graph count 0 and CLI `[]`                                                             | [Graph verified], [CLI verified] |

---

## 11. Sanitized raw responses

These are exact safe projections or faithful redactions of the non-secret results used above. They intentionally omit
all App Setting values, publishing material, custom-domain verification tokens, and FTP/publishing identifiers.

### A. Graph resource inventory — [Graph verified]

```json
{
	"count": 3,
	"data": [
		{
			"name": "roomiesblob",
			"type": "microsoft.storage/storageaccounts",
			"resourceGroup": "roomies-rg",
			"location": "southeastasia",
			"sku": { "name": "Standard_LRS", "tier": "Standard" }
		},
		{
			"name": "roomies-api-plan",
			"type": "microsoft.web/serverfarms",
			"resourceGroup": "roomies-rg",
			"location": "southeastasia",
			"sku": { "name": "B1", "tier": "Basic" }
		},
		{
			"name": "roomies-api",
			"type": "microsoft.web/sites",
			"resourceGroup": "roomies-rg",
			"location": "southeastasia"
		}
	]
}
```

### B. Graph RBAC and policy summary — [Graph verified]

```json
{
	"roleAssignmentCount": 3,
	"assignments": [
		{
			"id": "e533e20d-1f17-4851-b233-12e07d7ab9ce",
			"principalId": "66829680-745e-4357-bfac-f8a335fe943a",
			"role": "Owner",
			"scope": "/subscriptions/eaf92174-664c-4d77-b387-7f4da6bf8a36"
		},
		{
			"id": "8cf8edf1-1552-4095-8a33-80244b6e6a87",
			"principalId": "66829680-745e-4357-bfac-f8a335fe943a",
			"role": "Owner",
			"scope": "/subscriptions/eaf92174-664c-4d77-b387-7f4da6bf8a36"
		},
		{
			"id": "788b8371-533b-4229-b214-0899054bd13c",
			"principalId": "66829680-745e-4357-bfac-f8a335fe943a",
			"role": "Storage Blob Data Reader",
			"scope": ".../storageAccounts/roomiesblob"
		}
	],
	"policyAssignmentCount": 1,
	"policy": {
		"name": "sys.regionrestriction",
		"allowedLocations": ["koreacentral", "malaysiawest", "eastasia", "uaenorth", "southeastasia"]
	}
}
```

### C. Resource-scoped CLI summary — [CLI verified]

```json
{
	"resourceGroup": { "name": "roomies-rg", "location": "centralindia", "provisioningState": "Succeeded" },
	"storage": {
		"name": "roomiesblob",
		"kind": "StorageV2",
		"sku": "Standard_LRS",
		"accessTier": "Hot",
		"publicNetworkAccess": "Enabled",
		"minimumTlsVersion": "TLS1_2",
		"supportsHttpsTrafficOnly": true
	},
	"plan": {
		"name": "roomies-api-plan",
		"kind": "linux",
		"sku": "B1",
		"status": "Ready",
		"numberOfWorkers": 1,
		"numberOfSites": 1
	},
	"webApp": {
		"name": "roomies-api",
		"kind": "app,linux",
		"state": "Running",
		"identity": null,
		"keyVaultReferenceIdentity": "SystemAssigned",
		"linuxFxVersion": "NODE|22-lts"
	}
}
```

### D. Storage data-plane and app-settings-name summary — [CLI verified]

```json
{
	"container": {
		"name": "roomies-uploads",
		"publicAccess": "blob",
		"lease": { "state": "available", "status": "unlocked" },
		"hasImmutabilityPolicy": false,
		"hasLegalHold": false
	},
	"blobNames": [],
	"appSettings": {
		"count": 24,
		"slotSetting": false,
		"names": [
			"NODE_ENV",
			"PORT",
			"DATABASE_URL",
			"REDIS_URL",
			"JWT_SECRET",
			"JWT_REFRESH_SECRET",
			"JWT_EXPIRES_IN",
			"JWT_REFRESH_EXPIRES_IN",
			"GOOGLE_CLIENT_ID",
			"GOOGLE_CLIENT_SECRET",
			"BREVO_SMTP_SERVER",
			"BREVO_SMTP_PORT",
			"BREVO_SMTP_LOGIN",
			"BREVO_SMTP_KEY",
			"BREVO_SMTP_FROM",
			"BREVO_API_KEY",
			"EMAIL_PROVIDER",
			"STORAGE_ADAPTER",
			"AZURE_STORAGE_CONNECTION_STRING",
			"AZURE_STORAGE_CONTAINER",
			"ALLOWED_ORIGINS",
			"TRUST_PROXY",
			"DB_POOL_MAX",
			"WEBSITES_PORT"
		]
	}
}
```

### E. Empty-result corroboration — [Graph verified], [CLI verified]

```json
{
	"graphAbsentResourceTypes": [],
	"graphBudgetResources": [],
	"graphContainerResources": [],
	"cli": {
		"locks": [],
		"storageDiagnostics": [],
		"planDiagnostics": [],
		"webAppDiagnostics": [],
		"deploymentSlots": [],
		"vnetIntegration": [],
		"budgets": []
	}
}
```

### F. Node runtime availability — [CLI verified]

```json
[
	{
		"config": "NODE|24-lts",
		"os": "Linux",
		"runtime": "Node",
		"version": "24.0 LTS",
		"support": "Active",
		"end_of_life": "2028-04-30"
	},
	{
		"config": "NODE|22-lts",
		"os": "Linux",
		"runtime": "Node",
		"version": "22.0 LTS",
		"support": "Near",
		"end_of_life": "2027-04-30"
	},
	{
		"config": "NODE|20-lts",
		"os": "Linux",
		"runtime": "Node",
		"version": "20.0 LTS",
		"support": "EOL",
		"end_of_life": "2026-04-30"
	},
	{
		"config": "NODE|18-lts",
		"os": "Linux",
		"runtime": "Node",
		"version": "18.0 LTS",
		"support": "EOL",
		"end_of_life": "2025-04-30"
	}
]
```

---

## 12. Old-to-new field checklist

Every field in the pre-rebuild reference, including the original 2026-07-28 snapshot and its 2026-08-14 expansion, is
classified below; **unclassified old fields: 0**.

| Old field group                                                                                                  | Classification in this reference                                           | Source                                                                     |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Subscription identity, tenant, user, grant type                                                                  | §1                                                                         | [CLI verified] or [Historical]                                             |
| Remaining credit, percent used, reset cycle                                                                      | §1 retained as dated values; not misrepresented as current                 | [Historical]                                                               |
| Budget status and CLI-create constraint                                                                          | §§1, 9, 10                                                                 | [Graph verified], [CLI verified], [Historical]                             |
| Owner and Blob Data Reader assignments and data-plane rationale                                                  | §3                                                                         | [Graph verified], [CLI verified], [Historical]                             |
| GitHub Actions OIDC federation (new in this session, not present in any prior reference)                         | §3 (new subsection), §12 (update history)                                  | [CLI verified]                                                            |
| Resource-group name, location, state, locks, policy, diagnostics                                                 | §4                                                                         | [Graph verified], [CLI verified], [Historical]                             |
| All three deployed resources and their count                                                                     | §2                                                                         | [Graph verified], [CLI verified]                                           |
| Storage ID, kind, SKU, tier, location, creation, access tier, network, TLS, status                               | §5                                                                         | [Graph verified], [CLI verified]                                           |
| Additional storage account, encryption, blob-service, and container response fields                              | §5                                                                         | [Graph verified], [CLI verified], or [Historical]                          |
| Six storage endpoints and all encryption fields                                                                  | §5                                                                         | [Graph verified], [CLI verified]                                           |
| Blob soft delete, container delete, versioning, change feed, CORS, static website, last access, lifecycle policy | §5                                                                         | [CLI verified] or [Historical]                                             |
| Upload-container public access, modification time, lease, immutability, legal hold, blob count                   | §5                                                                         | [CLI verified]                                                             |
| Plan ID, region, Linux, B1, state, workers, sites, zones, creation, free-offer field                             | §6                                                                         | [Graph verified], [CLI verified]                                           |
| Web App runtime, plan, hostname, state, availability, slot-setting note                                          | §7                                                                         | [Graph verified], [CLI verified], [Historical]                             |
| Web App addresses, diagnostic, configuration, hostname, certificate, and safe deployment-surface fields          | §7                                                                         | [Graph verified], [CLI verified], or [Unavailable]                         |
| All 24 App Setting names                                                                                         | §7                                                                         | [CLI verified]                                                             |
| All old App Setting value fields                                                                                 | §7 retained with required value placeholder; values intentionally not read | [CLI verified]                                                             |
| Central India rejection, Southeast Asia success, other-region uncertainty                                        | §8                                                                         | [Historical], [Graph verified], [CLI verified]                             |
| Provider registration and Node 22/24 runtime availability/EOL                                                    | §8                                                                         | [CLI verified], [Unavailable] external schedule conflict                   |
| No PostgreSQL, Redis, Key Vault, budget, domain, monitoring, credentials, GitHub configuration                   | §9                                                                         | [Graph verified], [CLI verified], [Historical], or [Unavailable] as stated |
| Original command log and update history                                                                          | §10 retains replacement commands and §12 preserves dated historical claims | [CLI verified], [Historical]                                               |
| Pre-rebuild activity-log and consumption-usage excerpts                                                          | §§1, 7                                                                     | [Historical]                                                               |

### Update history

| Date       | Change                                                                                                                                                                             | Source                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 2026-07-27 | Initial account snapshot; storage confirmed. Central India App Service creation was rejected and the plan was subsequently created in Southeast Asia.                              | [Historical]                     |
| 2026-07-28 | Web App was recorded Running with 24 App Settings.                                                                                                                                 | [Historical]                     |
| 2026-08-14 | Complete safe rebuild: Graph inventory/RBAC/policy counts, live policy allow-list, scoped CLI corroboration, identity correction, sanitized appendices, and field checklist added. | [Graph verified], [CLI verified] |
| 2026-08-15 | GitHub Actions OIDC federation established for automated Azure deploys (PRD Phase 1.9–1.10). Created App Registration, federated credential (subject scoped to `refs/heads/main` only — not `tier0`, not PRs), service principal, and `Contributor` role assignment at `roomies-rg` scope. Every step was independently re-queried and corroborated via CLI before the next step was taken. No client secret was created at any point — OIDC token exchange only. This is an identity/RBAC-only change; no new Azure resources (storage, compute, database) were created, so the §2 live inventory count (3 resources) is unaffected. | [CLI verified] |
| 2026-08-16 | First live deploy debugging update: `.github/workflows/deploy.yml` exists and is scoped to `main` pushes; GitHub repo secrets required by `azure/login@v2` were confirmed present; first `test` and `deploy` jobs passed. Post-deploy startup failed because `DATABASE_URL` in App Settings referenced a stale Neon host; the value was corrected to the verified `.env.azure` Neon target and all 24 App Settings were re-listed for parity. Secret values remain intentionally omitted here despite having been exposed in the debugging chat. | [CLI verified] |
