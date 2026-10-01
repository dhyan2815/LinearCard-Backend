# CLAUDE.md — LinearCard Backend

Standalone NestJS 10 + Supabase API (split out of the former LinearCard monorepo).

## Git Commit Messages

Do **not** add co-authorship / attribution lines (e.g. `Co-Authored-By: Claude ...`, `🤖 Generated with Claude Code`) to commit messages or PR descriptions. Commit messages contain only the summary and body describing the change. (Enforced by `.claude/hooks/no-attribution.js`.) See `.claude/rules/git.md`.

## Branching

`master` (prod, default) · `DEV` (development) · `STAG` (staging) · `feat/*` branched from `DEV`, merged back via reviewed PR.

## Commands

- `npm run dev` — API on 3001 with watch (`nest start --watch`).
- `npm run build` — `nest build` → `dist/` (entry: `dist/src/main.js`).
- `npm run start:prod` — `node dist/src/main`.
- `npm run test` / `test:watch` / `test:cov` — Jest unit + phase regression specs.
- `npm run lint` — ESLint `--fix`. `npm run demo:reset` — wipe demo tenants.

## Shared types

`@linearcard/types` was inlined as `src/types.ts` when this repo was split from the monorepo. Import it with relative paths (`../types`, `./types`), not the old package name.

## Architecture

NestJS modules under `src/` (Auth, Programs, Templates, Passes, Members, Campaigns, Payments, Developers, Notifications/Notification, Wallet, Tenant, Settings, Dashboard, Audit, Supabase; Tiers is a pure util). `supabase/migrations` owns the schema. Google Wallet maintenance scripts live in `scripts/`.

## Critical patterns

1. **Multi-tenant (application-level):** service-role client bypasses RLS → **every query must filter `.eq('tenantId', req.tenantId)`**. Guarded routes use `@UseGuards(TenantGuard)`; never trust a `tenantId` from body/query.
2. **Columns are camelCase** (`tenantId`, `programId`, `memberId`).
3. **Pass issuance** always via `PassIssuanceService.issueForMember()`.
4. **Google Wallet** via `walletService.forTenant(tenantId)`; balance changes go through `processOrderTransaction()`. Wallet/WhatsApp/webhook side effects are best-effort — logged on failure, never roll back the DB.
5. **Idempotency** interceptor on mutating requests carrying `Idempotency-Key`.

For the full module map, tenant-scoping examples, env reference and security notes see `.claude/rules/backend.md`, `.claude/rules/env-variables.md`, and `GEMINI.md`.

## Env

Boot-fatal: `JWT_SECRET`, `WALLET_CREDENTIALS_KEY`. Google Wallet vars fail lazily. `src/env.ts` loads the repo-root `.env`. Full reference: `.claude/rules/env-variables.md`.
