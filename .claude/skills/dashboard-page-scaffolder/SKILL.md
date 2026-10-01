---
name: dashboard-page-scaffolder
description: Add a new page to the LinearCard Next.js dashboard, either program-scoped (a tab under a program) or account-level. Use this whenever the user asks to add a new dashboard tab, page, section, or view under apps/web/app/dashboard — including requests phrased as "add a tab for X" or "I need a page where I can see Y" that don't explicitly say "dashboard page".
license: Apache-2.0
metadata:
  author: dhyan2815
  version: "1.0.0"
allowed-tools: Read Edit Write Grep Glob Bash
---

# Dashboard Page Scaffolder

## Overview
Adds a new page to the LinearCard Next.js dashboard, in the right layout (program-scoped tab vs. account-level page), wired into the correct nav file and `DashboardContext`.

## Instructions

1. **Pick the layout first** — two exist, and they're wired differently:
   - **Program-scoped** (a tab under `/dashboard/programs/[id]/*`):
     1. Create `apps/web/app/dashboard/programs/[id]/<slug>/page.tsx`.
     2. Add `{ slug, label, icon }` to `TABS` in `_components/ProgramNav.tsx`.
     3. Read the program id via `useParams<{ id: string }>()`.
   - **Account-level** (e.g. `/dashboard/members`, `/dashboard/settings`):
     1. Create `apps/web/app/dashboard/<slug>/page.tsx`.
     2. Add an entry to the nav array in `_components/DashboardSidebar.tsx`.

2. **Both layouts** need the same wiring:
   - Wrap content in `PageShell` + `PageHeader` (shared primitives in `components/ui/`).
   - Pull shared state via `useDashboard()` from `app/dashboard/_components/DashboardContext.tsx` — tenant, `programs`/`programsLoaded`, `currentProgram`, `tiers`, `designData`.
   - Fetch data through `apiClient('/route')` — bare backend path, no `/api` prefix.
   - `params` in a server page is a **Promise** in Next.js 16 — `await params`. Check `AGENTS.md` for other Next 16 API differences before using an unfamiliar Next API.

3. **Verify** — `npm run dev:web`, navigate to the new route, confirm it renders with real data and handles the empty-tenant state if `programsLoaded` gates anything. Run `npm run lint` before calling it done.

## Output Format
Report which layout was used and which files were added/changed (page path, nav file entry), followed by the lint result. No need to restate the code inline unless the user asks to see it.
