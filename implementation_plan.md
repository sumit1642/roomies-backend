# TanStack Query Caching Layer — Implementation Plan

## Overview

Add a full three-layer caching system to the Roomies frontend using **TanStack Query v5**. The app currently has zero caching: every route mount and every navigation triggers fresh network requests. This plan adds in-memory caching with stale-while-revalidate semantics, route-level preloading via loaders, and optional session-storage persistence — all without breaking any existing functionality.

---

## Key Findings

| Issue | Location | Impact |
|---|---|---|
| 6 parallel API calls on every dashboard mount | `dashboard.tsx` | High |
| `setInterval` polling every 60s in all tabs | `NotificationBell.tsx` | Medium |
| Saved listings re-fetched on every browse visit | `browse.tsx` | Medium |
| Notifications re-fetched on every mount | `notifications.tsx` | Medium |
| `getStudentProfile` + `getSessions` fetched in both `profile.tsx` and `sessions.tsx` | Both pages | Medium |
| `getMyConnections` called twice on connections page | `connections.tsx` | Low |
| `defaultPreloadStaleTime: 0` in router | `router.tsx` | High (disables router preload) |

---

## User Review Required

> [!IMPORTANT]
> This is a **full caching overhaul**. All pages will be converted from raw `useEffect` to `useQuery`/`useMutation`. The routing layer will be updated to use route loaders that prefetch data. The changes are backward compatible but touch almost every route file.

> [!WARNING]
> The `browse.tsx` listing search uses cursor-based infinite pagination (`Load More`). TanStack Query's `useInfiniteQuery` is ideal here, but it changes the data shape. The plan converts it to `useInfiniteQuery` — the UI stays identical, just backed by the cache.

---

## Proposed Changes

### Step 1 — Install Dependencies

```
pnpm add @tanstack/react-query @tanstack/react-query-persist-client @tanstack/query-sync-storage-persister
```

No new devDependencies needed (types are included).

---

### Step 2 — New Infrastructure Files

---

#### [NEW] `src/lib/queryKeys.ts`

Centralized, typed query key factory. All `queryKey` arrays live here — prevents typos and makes `invalidateQueries` calls predictable.

```ts
export const queryKeys = {
  // Auth / sessions
  sessions: () => ['sessions'] as const,

  // Notifications
  notifications: {
    all: (isRead?: boolean) => ['notifications', { isRead }] as const,
    unreadCount: () => ['notifications', 'unread-count'] as const,
  },

  // Profiles
  studentProfile: (userId: string) => ['profile', 'student', userId] as const,
  pgOwnerProfile: (userId: string) => ['profile', 'pg-owner', userId] as const,

  // Interests
  interests: (status?: string) => ['interests', { status }] as const,

  // Connections
  connections: (status?: string) => ['connections', { status }] as const,
  connection: (id: string) => ['connections', id] as const,

  // Listings
  listings: (filters: object) => ['listings', filters] as const,
  listing: (id: string) => ['listing', id] as const,
  savedListings: () => ['saved-listings'] as const,

  // Properties
  properties: () => ['properties'] as const,

  // Amenities (near-static)
  amenities: () => ['amenities'] as const,
};
```

---

#### [NEW] `src/lib/queryClient.ts`

Singleton `QueryClient` with data-classified `staleTime` values and optional `sessionStorage` persistence. The persister is only active in production (`IS_PROD`), and uses `shouldDehydrateQuery` to whitelist only safe-to-persist queries (no contact reveals, no session tokens).

```ts
import { QueryClient } from '@tanstack/react-query';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { persistQueryClient } from '@tanstack/react-query-persist-client';

// Classified stale times (ms)
export const STALE = {
  STATIC:       60 * 60 * 1000,   // 1 hour  — amenities, enums
  PROFILE:       5 * 60 * 1000,   // 5 min   — user profile
  SESSIONS:      2 * 60 * 1000,   // 2 min   — active sessions
  FEED:          2 * 60 * 1000,   // 2 min   — listings browse
  TRANSACTIONAL: 30 * 1000,       // 30 sec  — interests, connections
  NOTIFICATION:  30 * 1000,       // 30 sec  — unread count
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: STALE.FEED,     // sensible default
      gcTime: 10 * 60 * 1000,   // 10 min in-memory gc
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// Safe-to-persist query keys (no PII, no contact reveals)
const PERSIST_WHITELIST = ['amenities', 'profile'];

if (typeof window !== 'undefined' && import.meta.env.PROD) {
  const persister = createSyncStoragePersister({ storage: window.sessionStorage });
  persistQueryClient({
    queryClient,
    persister,
    maxAge: 30 * 60 * 1000, // 30 min persistence window
    dehydrateOptions: {
      shouldDehydrateQuery: (query) =>
        PERSIST_WHITELIST.some((key) => String(query.queryKey[0]).startsWith(key)),
    },
  });
}
```

---

### Step 3 — Plumbing: Router & Root

---

#### [MODIFY] [router.tsx](file:///home/sumit/Desktop/Roomies/roomies_frontend/src/router.tsx)

- Pass `queryClient` into the router context so route `loader` functions can call `queryClient.ensureQueryData(...)`.
- Set `defaultPreloadStaleTime` to something sensible (e.g., `30_000` ms) so the router's intent-preload is actually useful.

```ts
import { queryClient } from '#/lib/queryClient';

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 30_000,
  });
  return router;
}

declare module '@tanstack/react-router' {
  interface Register { router: ReturnType<typeof getRouter>; }
  interface RouterContext { queryClient: typeof queryClient; }
}
```

---

#### [MODIFY] [__root.tsx](file:///home/sumit/Desktop/Roomies/roomies_frontend/src/routes/__root.tsx)

Wrap the entire app with `QueryClientProvider`. Add `ReactQueryDevtools` (dev only) — this integrates with the existing `TanStackDevtools` panel or can be added separately.

```tsx
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { queryClient } from '#/lib/queryClient';

function RootComponent() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RootDocument>
          <Outlet />
        </RootDocument>
      </AuthProvider>
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  );
}
```

---

### Step 4 — Component Conversions

---

#### [MODIFY] [NotificationBell.tsx](file:///home/sumit/Desktop/Roomies/roomies_frontend/src/components/NotificationBell.tsx)

Replace the manual `setInterval` with `useQuery` + `refetchInterval`. Key improvement: `refetchIntervalInBackground: false` stops server polling when the browser tab is not focused.

**Before:** `setInterval(fetchUnreadCount, 60000)` — always running  
**After:** `useQuery({ refetchInterval: 60_000, refetchIntervalInBackground: false })` — stops in background tabs

---

#### [MODIFY] [dashboard.tsx](file:///home/sumit/Desktop/Roomies/roomies_frontend/src/routes/_auth/dashboard.tsx)

Replace the large `Promise.all` inside `useEffect` with individual `useQuery` calls. Add a route `loader` that prefetches everything before the route renders.

**Queries to convert:**
- `getStudentProfile(userId)` → `useQuery({ queryKey: queryKeys.studentProfile(userId), staleTime: STALE.PROFILE })`
- `getMyInterests('pending')` → `useQuery({ queryKey: queryKeys.interests('pending'), staleTime: STALE.TRANSACTIONAL })`
- `getMyInterests('accepted')` → same pattern
- `getMyConnections('confirmed')` → `useQuery({ queryKey: queryKeys.connections('confirmed'), staleTime: STALE.TRANSACTIONAL })`
- `getSavedListings()` → `useQuery({ queryKey: queryKeys.savedListings(), staleTime: STALE.FEED })`
- `getNotifications(false)` → `useQuery({ queryKey: queryKeys.notifications.all(false), staleTime: STALE.NOTIFICATION })`

Same pattern for `PgOwnerDashboard`.

**Route loader:**
```ts
loader: ({ context: { queryClient }, params }) => {
  // fire-and-forget prefetch; route will still render if slow
  queryClient.ensureQueryData({ queryKey: queryKeys.studentProfile(userId), queryFn: ... });
  // ...other queries
}
```

> [!NOTE]
> Since `userId` comes from `AuthContext` (not route params), the loader will prefetch what it can (amenities, notifications) and the rest will be prefetched optimistically.

---

#### [MODIFY] [notifications.tsx](file:///home/sumit/Desktop/Roomies/roomies_frontend/src/routes/_auth/notifications.tsx)

- `getNotifications()` → `useInfiniteQuery` (for Load More cursor support)
- `markAsRead([id])` → `useMutation` with `onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.notifications.unreadCount() })`
- `markAsRead()` (all) → same pattern

**This means when a notification is marked read on the Notifications page, the bell count in the header updates immediately without an extra network call.**

---

#### [MODIFY] [browse.tsx](file:///home/sumit/Desktop/Roomies/roomies_frontend/src/routes/_auth/browse.tsx)

- `searchListings(filters)` → `useInfiniteQuery` keyed on `queryKeys.listings(filters)`. Each unique filter combination gets its own cache entry with 2-minute stale time.
- `getSavedListings()` → `useQuery({ queryKey: queryKeys.savedListings() })` — shared with dashboard, cached once
- `saveListing(id)` → `useMutation` with `onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.savedListings() })`
- `unsaveListing(id)` → same

---

#### [MODIFY] [connections.tsx](file:///home/sumit/Desktop/Roomies/roomies_frontend/src/routes/_auth/connections.tsx)

- `getMyConnections()` → `useQuery({ queryKey: queryKeys.connections(), staleTime: STALE.TRANSACTIONAL })`
- `confirmConnection(id)` → `useMutation` → `onSuccess: invalidateQueries(connections)`
- `getConnection(id)` (detail fetch) → `useQuery({ queryKey: queryKeys.connection(id) })`

---

#### [MODIFY] [profile.tsx](file:///home/sumit/Desktop/Roomies/roomies_frontend/src/routes/_auth/profile.tsx)

- `getStudentProfile(userId)` → `useQuery({ queryKey: queryKeys.studentProfile(userId), staleTime: STALE.PROFILE })`
- `getSessions()` → `useQuery({ queryKey: queryKeys.sessions(), staleTime: STALE.SESSIONS })`
- `updateStudentProfile(...)` → `useMutation` → `onSuccess: invalidateQueries(studentProfile)`
- `submitVerificationDocument(...)` → `useMutation` → `onSuccess: invalidateQueries(pgOwnerProfile)`

---

#### [MODIFY] [sessions.tsx](file:///home/sumit/Desktop/Roomies/roomies_frontend/src/routes/_auth/sessions.tsx)

- `getSessions()` → `useQuery({ queryKey: queryKeys.sessions(), staleTime: STALE.SESSIONS })`
- `revokeSession(sid)` → `useMutation` → `onSuccess: () => queryClient.setQueryData(queryKeys.sessions(), filter out sid)` (optimistic update, no refetch needed)

---

### Step 5 — Listing Detail Page

#### [MODIFY] [listing.$id.tsx](file:///home/sumit/Desktop/Roomies/roomies_frontend/src/routes/_auth/listing.$id.tsx)

Add a route `loader` that prefetches the listing detail. This is the highest-value place for a loader since users hover listing cards before clicking them (intent preload fires here).

```ts
loader: ({ context: { queryClient }, params }) =>
  queryClient.ensureQueryData({
    queryKey: queryKeys.listing(params.id),
    queryFn: () => getListing(params.id),
    staleTime: STALE.FEED,
  })
```

---

## Verification Plan

### Automated Tests
- Existing vitest suite: `pnpm test` — ensure no regressions
- No new test files in scope for this PR

### Manual Verification

1. **Cache hit test**: Navigate to Dashboard → Notifications → back to Dashboard. Open browser DevTools Network tab. The second Dashboard visit should show zero new API calls (within `staleTime` window).
2. **NotificationBell**: Open two tabs. Switch away from tab. Confirm no network activity for 60 seconds on the background tab (previously it would still poll).
3. **Mark-read cascade**: Mark a notification as read on `/notifications`. Without navigating away, verify the bell count in the header decrements (proves `invalidateQueries` cross-component sync works).
4. **Save listing cascade**: Save a listing in Browse. Navigate to Dashboard. The "Saved Listings" count should immediately reflect the new save without a spinner.
5. **DevTools**: Open TanStack Query devtools (bottom-right panel) and verify queries are appearing with correct `staleTime` and `status`.
6. **Build check**: `pnpm build` — TypeScript must compile clean.

---

## Execution Order (Safest Path)

1. Install packages + create `queryKeys.ts` + `queryClient.ts`
2. Wire `QueryClientProvider` into `__root.tsx`
3. Wire `queryClient` context into `router.tsx`
4. Convert `NotificationBell.tsx` (smallest, highest impact)
5. Convert `dashboard.tsx` (most queries, highest traffic)
6. Convert `notifications.tsx` + `sessions.tsx` (straightforward)
7. Convert `browse.tsx` (infinite query, needs care)
8. Convert `connections.tsx` + `profile.tsx`
9. Add route loaders (`listing.$id.tsx`, `dashboard`)
10. Run `pnpm build` to verify TypeScript
