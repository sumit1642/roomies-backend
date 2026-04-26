# Tier 1 Deployment Guide — Roomies Backend

## When and How to Upgrade From Free Tier

> **You are reading this because** something about Tier 0 is no longer good enough. **What this guide covers:** The
> three upgrade paths at Tier 1, and how to execute each one without losing user data or causing prolonged downtime.
> **Backend URL stays the same:** `https://api.roomies.sumitly.app` — your users never see any of this.

---

## When Is It Time for Tier 1?

Tier 0 will serve your app well during early growth. Tier 1 becomes necessary when one or more of the following happens.
Each trigger has its own upgrade path.

**Trigger A — Upstash commands exceeding ~400K/month.** You see this in the Upstash Analytics tab. If daily command
usage is consistently above ~13,000 commands, you will hit 500K/month within the month. You need to upgrade before the
hard limit cuts off BullMQ.

**Trigger B — Users complaining about the 1-minute cold start.** When your user base grows and real users are hitting
sleeping servers, cold starts become a UX problem that drives abandonment. This is the most human trigger — you will
feel it before you measure it.

**Trigger C — Neon storage approaching 0.5 GB.** Go to your Neon Console → Project Settings → Storage. When this shows
0.4 GB or more, plan a migration. You have some buffer, but do not wait until you actually hit the limit.

**Trigger D — Multiple triggers happening at once.** At this point, consider jumping straight to Tier 2 (Azure App
Service + Azure PostgreSQL on student credits), which solves all problems simultaneously.

---

## Understanding the Tier 1 Options

There are three distinct problems you might be solving, and they require different (but sometimes combined) fixes. Think
of them as three independent dials you can turn:

**Dial 1 — Redis capacity:** Upstash Free → Upstash Fixed $10/month. No code changes. No server restart needed. Just a
billing plan change in the Upstash dashboard.

**Dial 2 — Server always-on:** Render Free (sleeps) → Render Starter ($7/month, always on). No code changes. Just a plan
upgrade in Render. But: if the server is now always awake, Dial 1 (Redis) almost certainly needs to be turned at the
same time.

**Dial 3 — Database capacity:** Neon Free (0.5 GB) → Neon Launch plan ($19/month). This requires a brief maintenance
period if you want to do it carefully, or can be done as a zero-impact upgrade directly in the Neon dashboard.

The most common Tier 1 progression is: first Trigger A fires (Redis), so you turn Dial 1. Then Trigger B fires (cold
starts are hurting growth), so you turn Dials 2 and 1 together. Trigger C is usually the last to fire unless you are
storing a lot of data early on.

---

## Option A — Fix Redis Capacity Only (Upstash Fixed Plan)

**When:** Upstash commands approaching 400K/month. Server sleeps are still acceptable.

**Cost added:** $10/month (~₹840) for Upstash Fixed 250MB. Student credits are not consumed — this is paid to Upstash.

**Zero downtime.** Your existing `REDIS_URL` does not change. Your app does not need to redeploy.

### Steps

**Step 1:** Log in to [console.upstash.com](https://console.upstash.com) → click on your `roomies-redis` database →
click the **Plan** tab or find the **Upgrade** button on the overview page.

**Step 2:** Select **Fixed 250MB** plan ($10/month). This plan has unlimited commands within its memory and bandwidth
limits, which is exactly what you need for BullMQ.

**Step 3:** Confirm the upgrade. Upstash upgrades your plan instantaneously — no data loss, no connection interruption.
Your existing `REDIS_URL` (host, port, password) stays the same.

**Step 4:** Update your local `.env.render` file to add a note that you are on the Fixed plan now. No actual value needs
to change.

**Verify:** Check Upstash Analytics the next day. Command counts should be the same as before — the difference is that
you are no longer at risk of hitting a hard cap.

---

## Option B — Fix Cold Starts (Always-On Server)

**When:** User cold start complaints are affecting retention or conversions.

**Cost added:** Render Starter at $7/month (~₹580) + Upstash Fixed at $10/month (~₹840) = **$17/month total (~₹1,420)**.
This is less than Azure App Service B1 alone (~₹1,092/month from student credits), and doesn't touch your student credit
balance.

**Why both at once:** If the server never sleeps, BullMQ workers poll Redis continuously. A
sleeping-BullMQ-plus-Upstash-Free uses ~150K commands/month. An always-on-BullMQ-plus-Upstash-Free will blow through
500K in about 10–12 days. So upgrading to always-on requires the Redis upgrade simultaneously.

**There will be a brief restart** (~30 seconds) when you change the Render plan, during which requests may get 502
errors. Pick a low-traffic time (midnight India time, for example).

### Steps

**Step 1 — Upgrade Upstash first** (follow Option A steps above).

**Step 2 — Upgrade Render plan:**

Go to [dashboard.render.com](https://dashboard.render.com) → your `roomies-api` service → **Settings** (left sidebar) →
scroll down to **Instance Type**.

Click **Change**. Select **Starter ($7/month)**. The Starter plan has:

- Always-on (no sleeping)
- 512 MB RAM (same as free)
- 0.5 CPU
- No limits on outbound ports (though you don't need SMTP since you're using Brevo API)

Click **Save**. Render will restart your service. Watch the logs tab — you should see the full startup sequence within
30 seconds.

**Step 3 — Verify always-on behaviour:**

Wait 20 minutes without making any requests. Then make a request and check the response time. It should respond in under
2 seconds (fast, no cold start). If it still cold-starts, check the Render dashboard — the Starter plan indicator should
show "Always On".

**Step 4 — Update your ALLOWED_ORIGINS if your frontend is now live:**

If your frontend is deployed at `roomies.sumitly.app`, update the `ALLOWED_ORIGINS` environment variable in Render from
`*` to `https://roomies.sumitly.app`. This improves security.

---

## Option C — Fix Database Capacity (Neon Storage Upgrade)

**When:** Neon storage showing 0.4 GB or higher.

**Cost added:** Neon Launch plan at $19/month (~₹1,590). This is paid to Neon. Student credits not consumed.

**Zero downtime.** This is a billing plan change in the Neon dashboard — the connection string stays the same, the data
stays in place.

### Steps

**Step 1:** Go to [console.neon.tech](https://console.neon.tech) → your `roomies` project → click **Settings** or the
plan indicator in the top area → find the **Billing** or **Upgrade** section.

**Step 2:** Select **Launch plan** ($19/month). This gives you:

- 10 GB storage (20x more than the free tier)
- More compute hours per month
- Point-in-time recovery for up to 7 days (important for production)

**Step 3:** Confirm the upgrade. Neon upgrades instantly. Your `DATABASE_URL` connection string is unchanged. Your app
on Render is unaffected — it is already connected and will continue running without interruption.

**Step 4:** Go back to Render → your service → **Environment** tab. No changes needed here. The app is already using the
same connection.

**Verify:** Check Neon Console → Project Settings → Storage the next day. You should now see the storage used out of 10
GB rather than 0.5 GB.

---

## Option D — Migrating to a Different Neon Region (If Needed)

This is an edge case, but worth documenting. If your Neon database is in Singapore and your users are accessing it via
Render Singapore, the latency is ~1ms. If for some reason Neon had availability issues in Singapore (rare but possible),
you might want to switch regions.

**This requires actual data migration and causes downtime.** Only do this if there is a compelling reason.

For a low-traffic app, the safest approach is:

1. Set a maintenance page on Render by temporarily returning 503 from your health endpoint (or by suspending the service
   in the Render dashboard)
2. Export your Neon data: `pg_dump "$NEON_URL" > roomies_backup_$(date +%Y%m%d).sql`
3. Create a new Neon project in the target region
4. Enable PostGIS and pgcrypto in the new project
5. Import: `psql "$NEW_NEON_URL" < roomies_backup_YYYYMMDD.sql`
6. Update `DATABASE_URL` in Render environment variables
7. Trigger a Render redeploy
8. Restore the health endpoint
9. Test everything

Downtime window: approximately 5–15 minutes depending on database size.

---

## Summary: Tier 1 Monthly Costs

| Scenario                   | What Changed                   | Monthly Cost     |
| -------------------------- | ------------------------------ | ---------------- |
| Redis upgrade only         | Upstash Free → Fixed           | $10/mo (~₹840)   |
| Always-on (no cold starts) | Render Starter + Upstash Fixed | $17/mo (~₹1,420) |
| Database upgrade only      | Neon Free → Launch             | $19/mo (~₹1,590) |
| Full Tier 1 (all three)    | All of the above               | $36/mo (~₹3,020) |

At $36/month full Tier 1, consider whether jumping to Tier 2 (Azure on student credits, ~₹3,255/month but with zero
ongoing external vendor cost beyond student credits) makes more sense for your runway. The decision depends on how
quickly your student credits are running down and how much time you want to spend managing billing across multiple
external vendors.

---

## When Tier 1 Is Not Enough — Time to Go to Tier 2

Move to tier2.md when:

- Your monthly external vendor spend (Upstash + Neon + Render) approaches the cost of Azure App Service B1 + Azure
  PostgreSQL (~₹3,255/month from student credits)
- You need features only Azure provides: SLA guarantees, VNet integration, Azure Monitor, Always On with zero restarts
- Your student credits are abundant and you want to consolidate everything onto one bill
- You anticipate needing to scale quickly and want the headroom of Azure's autoscale

The user-facing URL stays the same across all tiers. The only visible migration is updating DNS CNAME records to point
from `roomies-api.onrender.com` to `roomies-api.azurewebsites.net`.
