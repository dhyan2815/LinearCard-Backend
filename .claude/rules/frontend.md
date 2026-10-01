# Frontend Rules

Next.js 16 (App Router, Turbopack) + React 19 + TypeScript. Hot-reload enabled.

## Commands

- `npm run dev:web` (repo root) — builds `packages/types`, then `next dev` on 3000. Own terminal; there is no combined `npm run dev`.
- `npm run build` / `npm run start` (in `apps/web/`) — production build / serve on 3000.

Check root `AGENTS.md` for Next.js 16 API differences before using unfamiliar Next APIs.

## Routes (`apps/web/app/`)

- `/` — landing page.
- `/login` — admin OTP login + self-serve signup.
- `/dashboard` — program gallery (account level). Other account pages: `/dashboard/members`, `/dashboard/members/[id]`, `/dashboard/developers` (API keys, outbound webhooks), `/dashboard/settings` (tenant settings).
- `/dashboard/programs/new` — create a program from a preset.
- `/dashboard/programs/[id]/<tab>` — **program-scoped views** (Phase 8), tabs from `ProgramNav.tsx`:
  - Operations: `overview`, `members` (+ `members/[memberId]`), `activity`, `campaigns`
  - Setup: `design` (template designer + on-device preview), `tiers`, `locations` (Google Maps store locations), `messages` (per-program WhatsApp templates)
  - Admin: `settings` (name, slug, welcome message, delete program)
  - `events` — paginated pass lifecycle events (not in the nav; reachable by URL).
- Legacy redirects: `/dashboard/template-designer` → `design`, `/dashboard/push-campaigns` → `campaigns`, `/dashboard/live-activity` → `activity`, via `LegacyProgramRedirect` to the selected (or first) program.
- `/scan` — staff scanner: validate pass, award/redeem via `process-order`, scan history.
- `/enroll/[slug]/[programSlug]` — consumer enrollment (mobile-first, OTP). `/enroll/[slug]` resolves to the tenant's default (oldest) program.

## Key Libraries

- **Styling:** Tailwind CSS v4 (PostCSS). Shared primitives in `components/ui/` (`PageShell`, `PageHeader`, `Button`, …).
- **Animation:** `framer-motion` / `motion`, `canvas-confetti`.
- **QR:** `qrcode.react` (generate), `@yudiel/react-qr-scanner` (scan).
- **Maps:** `@vis.gl/react-google-maps` (Locations tab; `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`).
- **API client:** `lib/api-client.ts` — one callable, not an object with `.get`/`.post`.

## API Client

```typescript
import { apiClient } from '@/lib/api-client';

const data = await apiClient('/programs');                       // → /api/programs (proxied)
const res = await apiClient(`/programs/${id}`, {                 // Idempotency-Key added automatically
  method: 'PATCH',
  body: JSON.stringify({ welcomeMessage }),
});
```

- Browser: always `/api/<path>` on the page's own origin; `next.config.mjs` `rewrites()` proxies to the backend. No CORS; the `admin_session` cookie is same-origin. `credentials: 'include'` is set.
- Server (SSR): absolute URL from `NEXT_PUBLIC_API_URL` (preview-derived fallback, then `http://localhost:3001`).
- Callers pass the bare backend path (`/programs`); never include `/api`.
- Every non-GET/HEAD call gets an `Idempotency-Key` (one per logical call, shared across retries).
- Retries (exponential backoff) only on network errors/timeouts, and only for GET/HEAD or requests carrying an idempotency key.
- 401 throws `UnauthorizedError`; other non-2xx throw `Error`.
- Most endpoints return `{ success, ... }` — check `success`.

## Dashboard Context

`app/dashboard/_components/DashboardContext.tsx`, provided by `app/dashboard/layout.tsx`:

```typescript
import { useDashboard } from '../_components/DashboardContext';

const { currentTenant, programs, currentProgram, selectedProgramId,
        handleProgramChange, refreshPrograms, tiers, designData } = useDashboard();
```

Holds tenant selection, the program list (`programsLoaded` guards the empty state), the active program's `Tier` rows (the only tier source of truth), template designer state, and stats.

## Adding a Page

- **Program-scoped view:** `app/dashboard/programs/[id]/<slug>/page.tsx`, then add `{ slug, label, icon }` to `TABS` in `_components/ProgramNav.tsx`.
- **Account-level view:** `app/dashboard/<slug>/page.tsx`, then add to the nav array in `_components/DashboardSidebar.tsx`.
- Read the program id with `useParams<{ id: string }>()`; wrap content in `PageShell` + `PageHeader`.

## Component Layout

```
apps/web/
├── app/
│   ├── dashboard/
│   │   ├── _components/     # DashboardContext, DashboardSidebar, ProgramNav, TemplateWorkspace,
│   │   │                    # LiveActivityView, PushCampaignsView, MemberDetailView, SettingsView,
│   │   │                    # StoreLocationMap/Entry, MapSearchBox, LegacyProgramRedirect
│   │   └── programs/[id]/…  # program tabs
│   ├── scan/  enroll/  login/
├── components/              # HeroPass, PassPreviewCard, WalletModal, ScanHistoryTable, Theme*, ui/, animata/
└── lib/api-client.ts
```

## Types

```typescript
import type { Program, Tier, ProgramMemberEvent } from '@linearcard/types';
```

Type-only edits in `packages/types/index.ts` resolve immediately (`types` points at `index.ts`). Runtime exports (consts) come from `dist/`, which `dev:web`/`dev:api` build once at start — restart after changing those.

## Business category & program kind

- `apps/web/app/login/page.tsx` (signup) and `_components/SettingsView.tsx` (settings) both render category options from `BUSINESS_CATEGORIES.filter(c => c.selectable)` in `@linearcard/types` — never hardcode the list.
- `dashboard/programs/new/page.tsx` renders whatever `GET /programs/presets` returns (already filtered server-side by the tenant's category); it does not re-derive category client-side.
- Any view gating on program type must check `Program.kind` (`loyalty | ticket | giftcard | coupon | studentid`), not assume loyalty. See the pattern in `docs/PATTERNS.md` and its use in `programs/[id]/tiers/page.tsx`, `_components/TemplateWorkspace.tsx`, and `scan/page.tsx`.

## Known Gotchas

- **Google Wallet save links expire.** Don't cache them; the public `/p/:id` backend route mints a fresh link on each visit.
- **`NEXT_PUBLIC_*` baked at build time** — rebuild after changes. `NEXT_PUBLIC_API_URL` is only read by the proxy and SSR.
- **Wallet updates are async and best-effort.** A saved balance can show before the pass on the phone updates.
- `params` in server pages is a Promise in Next.js 16 — `await params`.
