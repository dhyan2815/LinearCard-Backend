# LinearCard Project Memory

## Overview
LinearCard is a multi-tenant loyalty & digital pass platform generating Google Wallet passes (Apple Wallet roadmap). It handles branded passes, loyalty points/tiers, redemption, POS webhooks, and WhatsApp notifications.
**Status:** Feature-complete through Phase 8 (Program-Scoped Features). Live in production.

## Architecture & Tech Stack
- **Language/Runtime:** Node.js (ESM), TypeScript, Next.js 16 (App Router), React 19, NestJS 10
- **Monorepo:** Turborepo (`apps/web`, `apps/api`, `packages/types`)
- **Database & Auth:** Supabase (PostgreSQL), service-role key on backend, RLS policies, phone OTP auth
- **Design System:** Dark mode, glassmorphism, Tailwind CSS v4, shadcn/ui, Framer Motion, Sonner
- **Pass Issuance:** Google Wallet REST API / RS256 JWT signing (`GenericClass`/`GenericObject`), links expire in 3h
- **Integrations:** WAHA (WhatsApp notifications/OTP), payment webhooks (HMAC-SHA256 signed)

## Critical Engineering Patterns

### 1. Multi-Tenant Isolation (Application-Level)
Backend queries use the Supabase service-role key which **bypasses RLS**. Every DB query must explicitly filter by tenant:
```typescript
// Always include tenant filter
await this.supabase.from('Member').select().eq('tenant_id', tenantId);
```

### 2. Google Wallet Pass Updates (Async & Resilient)
Pass updates to Google are asynchronous network calls. **Never rollback DB transactions on Wallet API failures.** Cashier flows must proceed even if Google Wallet synchronization fails or lags.

### 3. Tier Computation & Tier-less Programs
- Tier progression is computed via `apps/api/src/tiers/tier.util.ts` on each transaction.
- Programs without tiers (e.g. tickets, access passes) omit tier labels and balance counters dynamically.

### 4. Idempotency & Replay Protection
Global idempotency interceptor on mutating API requests using `Idempotency-Key` headers. Webhook endpoints require valid HMAC signatures with timestamp replay protection.

### 5. Audit & Compliance
- **AuditLog:** Records pass creation, adjustments, scans, and orders.
- **ConsentLog:** Tracks member marketing opt-ins/opt-outs. Promotional messages require verified consent.

## Known Gotchas & Constraints
- **Google Wallet links:** Expire after 3 hours. Frontend must request fresh JWT links on demand.
- **Geofencing limitation:** Native `merchantLocations` proximity notifications are blocked by Android background permissions. Store locations UI is retained for external/web check-in workflows.
- **Environment variables:**
  - `GOOGLE_PRIVATE_KEY` must retain literal `\n` characters.
  - Vercel dynamic URLs (`VERCEL_URL`, `VERCEL_BRANCH_URL`) are handled server-side in `api-client.ts`.
- **Line Endings:** Windows CRLF/LF issues are strictly managed via root `.gitattributes` (`eol=lf`).
- **Dev ports:** Zombie Node processes on ports 3000/3001 can be cleared via `npm run kill-ports`.

## Key Workspaces & Routes
- **Programs (`/dashboard/programs/[id]`):** Overview, Members, Activity, Campaigns, Design, Tiers, Locations, Messages, Webhooks, Settings.
- **Operations & Consumer:**
  - `/scan`: Cashier barcode validation and point balance adjustment.
  - `/dashboard/pos-simulator`: Webhook simulation for POS testing.
  - `/enroll/[slug]/[programSlug]`: Customer mobile enrollment with OTP.

## Documentation Index
- `docs/LinearCard_Architecture_Briefing.md` — Deep-dive system architecture
- `docs/LinearCard_E2E_Testing_Guide.md` — End-to-end testing scenarios
- `docs/LinearCard_User_Flows.md` — User journeys and sequence specs
- `.claude/rules/env-variables.md` — Exhaustive environment variables guide
- `docs/TROUBLESHOOTING.md` — Common runtime resolutions

---

## Changelog
- **2026-10-01:** Updated scanner profile header (`apps/web/app/scan/page.tsx` and `apps/api/src/passes/passes.controller.ts`) to display the scoped program name in place of the store pill under the member's contact info, and replaced the generic "Verified Pass" label in the top-right pill with the verified tenant/store name (`passData.tenantName`).
- **2026-10-01:** Added expandable dropdown functionality to the push campaign preview audience view (`PushCampaignsView.tsx`), allowing admins to expand beyond the 5-sample limit to view all matched recipients; updated `POST /campaigns/preview` to return the complete `recipients` array, and sorted the member query in `CampaignsService.resolveAudience` by `createdAt: desc` so newly enrolled members and passes are immediately surfaced.
- **2026-10-01:** Reviewed scanner ergonomics and scenario specification for `gym_membership` under `salon_spa_fitness`; documented amount input requirements (`amount = 1`), zero-cap redemption constraints, and UI alignment with [GAP-13](file:///c:/Users/dhyan/Desktop/LinearCard/docs/specs/BUSINESS_CATEGORY_PROGRAM_SCENARIOS.md#L537) (visit-mode check-in vs retail checkout).
- **2026-09-30:** Diagnosed and resolved Vercel production 500 FUNCTION_INVOCATION_FAILED error on `POST /auth/admin/send-otp` (and all backend endpoints) caused by `wallet.service.ts`, `auth.controller.ts`, and `settings.controller.ts` importing values from `@linearcard/types`, which failed at runtime in Serverless lambda (`Cannot find module '@linearcard/types'`); localized `DEFAULT_PASS_HEX`, `SELECTABLE_BUSINESS_CATEGORIES`, and `isSelectableCategory` validator within `apps/api/src/programs/presets.ts` and converted all `@linearcard/types` imports in `apps/api` to `import type`, eliminating all runtime module dependencies on `@linearcard/types` in compiled JavaScript.
- **2026-09-30:** Refactored `scripts/verify-class-locations.ts` into a fast, pipeable CLI utility that outputs raw class and pass object JSON from Google Wallet, and added active object geofence patching via `--sync-object-locations`.
- **2026-09-30:** Implemented `patchClassLocations` in `WalletService` to patch `merchantLocations` directly to Google Wallet REST API without re-evaluating full class templates or requiring public callback URLs on local dev; updated `syncSiblingClassLocations` in `TemplatesService` to use `patchClassLocations`; surfaced location sync warnings to API response and UI toast in `locations/page.tsx`.
- **2026-09-30:** Merged PR #27 (`feat/wallet-programs` → `dev`) delivering native multi-type wallet pass support, business category gating, dynamic enrollment fields, and gift card pipelines. Merged PR #28 (`dev` → `master`) promoting all phase updates to production, and synchronized local `master` and `dev` branches.
- **2026-09-30:** Conducted end-to-end investigation and testing of Google Wallet proximity notifications (`merchantLocations`), verified live class payload directly via OAuth2 REST API and verification script, confirmed `reviewStatus` is read-only (Google returns 400 on patch), and compiled technical report documenting Android OS/Play Services geofence constraints.
- **2026-09-30:** Created `scripts/verify-locations.ts` alias to support direct invocation; prevented duplicate `dev_` prefixing; upgraded `scripts/verify-class-locations.ts` to support querying all native Google Wallet resource types (`loyaltyClass`, `genericClass`, `giftCardClass`, `offerClass`, `eventTicketClass`) directly from Google's REST API with auto-detection of resource type; corrected business category plan reference paths in migration and test spec.
- **2026-09-29:** Removed proximity notification warning toast on publish in `TemplateWorkspace.tsx`; automated synchronization of `merchantLocations` to live Google Wallet classes whenever program store locations are updated via `PATCH /programs/:id`.
- **2026-09-28:** Aligned pass preview card with Google Wallet layout and dynamic contrast; added Playwright wallet preview verification test script (`scripts/verify-wallet-preview.mjs`).
- **2026-09-28:** Updated `scripts/verify-class-locations.ts` to list all issued pass objects, display the latest enrolled member's payload, provide automated class-object link diagnostics, and support `--sync-object-locations` to patch `merchantLocations` directly to the pass object.
- **2026-09-28:** Added cross-platform clean-cache utility script and npm clean:cache scripts; registered archify skill.
- **2026-09-26:** Purged 24+ GB of obsolete build caches (`.turbo/cache`, `.next/cache`, `dist`).
- **2026-09-25:** Added root `.gitattributes` to lock LF line endings and resolve Windows CRLF stat cache; renamed test suites to domain-specific names (`security-and-env.spec.ts`, `pass-balance-economics.spec.ts`, etc.); added Vercel preview deployment URL support; refreshed architecture diagrams and README; cleaned and condensed `GEMINI.md`; synchronized `dev` and `master` branch heads to `a36b88a`; pruned remote branches and deleted `feat/passkit-parity`.
- **2026-09-24:** Safely handled null balance adjustments across member and pass controllers; trimmed legacy webhook endpoints.
- **2026-09-23:** Enabled dynamic WhatsApp templates per program; added member phone duplication support; program-scoped pass design resync; restored program locations tab; added program preset imagery.
