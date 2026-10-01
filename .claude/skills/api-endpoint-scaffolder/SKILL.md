---
name: api-endpoint-scaffolder
description: Add a new NestJS API endpoint end-to-end in LinearCard — controller, shared types, frontend call — correctly tenant-scoped from the start. Use this whenever the user asks to add, create, or wire up a backend route, endpoint, or API in apps/api, even if they only describe the feature (e.g. "add a way to export members as CSV") without saying "endpoint" or "route" explicitly.
license: Apache-2.0
metadata:
  author: dhyan2815
  version: "1.0.0"
allowed-tools: Read Edit Write Grep Glob Bash
---

# API Endpoint Scaffolder

## Overview
Wires a new NestJS route in `apps/api` through to the frontend: controller method, shared request/response types, and the `apiClient` call that consumes it. Bakes in this repo's tenant-scoping rules so the endpoint isn't a candidate for the isolation bugs that have shipped here before.

## Instructions

1. **Controller** — add the method in `apps/api/src/<module>/<module>.controller.ts`.
   - `@UseGuards(TenantGuard)`, request typed as `TenantRequest`.
   - Every Supabase query on this route: `.eq('tenantId', req.tenantId)`. Never trust a `tenantId` from body/query — see `.claude/rules/backend.md`.
   - Non-GET/HEAD mutating routes get idempotency for free (global interceptor honors `Idempotency-Key` header) — no extra server-side code needed.
   - Wallet/WhatsApp/webhook side effects, if any: fire-and-forget, `.catch(() => {})`, logged on failure, never roll back the DB write.

2. **Shared types** — add request/response interfaces to `packages/types/index.ts`.
   - Type-only edits resolve immediately for both apps. If a runtime const/enum is added (not just a type), restart `dev:api`/`dev:web` to pick up the rebuilt `dist/`.

3. **Frontend call** — consume it via `apiClient('/route', { method, body: JSON.stringify(...) })` from `lib/api-client.ts`.
   - Pass the bare backend path — no `/api` prefix; the client and `next.config.mjs` rewrite handle that.
   - Check `res.success` — most endpoints return `{ success, ... }`.

4. **Verify** — run `npm run lint` and `npm run build` from repo root before considering the endpoint done (per `CLAUDE.md` Development Workflow).
   - If the route touches a table queried elsewhere too, grep for other call sites missing the same `tenantId` filter — tenant-isolation bugs are this repo's most common regression (see commits `fix: enforce tenant isolation on GET /members/:id`, `fix: return proper HTTP error codes for balance adjustment failures`).

## Output Format
Report which files were added/changed as a short list (controller path, types file, frontend call site), followed by the lint/build result. No need to restate the code inline unless the user asks to see it.
