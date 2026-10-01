# Environment Variables Reference

**Frontend:** `apps/web/.env`
**Backend:** repo root `.env` and/or `apps/api/.env`

`apps/api/src/env.ts` loads every `.env` it finds (root first, then `apps/api/.env`, then cwd-relative candidates). dotenv never overwrites a var that is already set, so **the first file that defines a var wins** — root beats `apps/api/.env`.

## Frontend (`apps/web/.env`)

### API proxy target

The browser never calls the backend directly. It calls `/api/*` on its own origin; `rewrites()` in `apps/web/next.config.mjs` proxies to the backend. The proxy target resolves as:

1. `API_ORIGIN` — explicit backend origin. Preferred going forward.
2. `NEXT_PUBLIC_API_URL` — legacy fallback; what production uses today.
3. Preview (`VERCEL_ENV=preview`) with neither set — derived from `VERCEL_BRANCH_URL` / `VERCEL_URL` (`linearcard-git-*` → `linearcard-api-git-*`).
4. `http://localhost:3001`.

**When read:** server start for `next dev` (restart to pick up a change), and **build time on Vercel** — `rewrites()` compiles into the routes manifest, so changing `API_ORIGIN` there needs a redeploy.

`NEXT_PUBLIC_API_URL` is **not read by browser code.** It feeds the proxy target above and the server-side (SSR) branch of `lib/api-client.ts` (which has its own preview fallback via `NEXT_PUBLIC_VERCEL_ENV` / `NEXT_PUBLIC_VERCEL_BRANCH_URL` / `NEXT_PUBLIC_VERCEL_URL`).

### Optional

- `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` — Google Maps key for the program **Locations** tab (`StoreLocationMap.tsx`, `@vis.gl/react-google-maps`). Unset → map renders without a key (search/map degraded). Baked at build time.

## Backend (root `.env` or `apps/api/.env`)

### Required (boot fails without them)

- `JWT_SECRET` — Signs admin session JWTs (`admin_session` cookie, 1 day) and short-lived signup tokens. Generate: `openssl rand -base64 32`. Missing/empty → `env.ts` throws at boot.
- `WALLET_CREDENTIALS_KEY` — Encrypts per-tenant Google Wallet private keys at rest (AES-256-GCM; any length, SHA-256-derived to 32 bytes). Generate: `openssl rand -hex 32`. Missing/empty → throws at boot.

### Supabase (Required)

- `NEXT_PUBLIC_SUPABASE_URL` (or `SUPABASE_URL`) — Project URL.
- `SUPABASE_SERVICE_ROLE_KEY` — Service-role key. Bypasses RLS; used by every query today.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` (or `SUPABASE_ANON_KEY`) — Only needed for the RLS read path below.

### Google Wallet platform credentials (Required unless every tenant has its own)

Resolved per tenant by `WalletService.forTenant()`: `Tenant.issuerId` / `googleClientEmail` / `googlePrivateKeyEncrypted` if set, else these env fallbacks. Missing both → `WALLET_CREDENTIALS_MISSING` at pass/class time (not at boot).

- `ISSUER_ID` — Google Wallet issuer id (Pay & Wallet Console). **This is the name the code reads.** `GOOGLE_ISSUER_ID` / `GOOGLE_WALLET_ISSUER_ID` are only secondary fallbacks in a couple of places (callback verification, `check-class`).
- `GOOGLE_CLIENT_EMAIL` — Service account `client_email`.
- `GOOGLE_PRIVATE_KEY` — Service account `private_key`.

```bash
ISSUER_ID="3388000000012345678"
GOOGLE_CLIENT_EMAIL="service-account-xyz@project.iam.gserviceaccount.com"
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg...\n-----END PRIVATE KEY-----\n"
```

`formatPrivateKey()` turns literal `\n` sequences into newlines and adds PEM headers if missing, so a single-line key with `\n` escapes (as copied from the JSON) works.

### Wallet environment isolation (Optional)

- `WALLET_ENV_PREFIX` — Class-id namespace: `${issuerId}.${prefix}_${classSuffix}`.
  - Unset → `dev` locally, `preview` when `VERCEL_ENV=preview`, none when `VERCEL_ENV=production`.
  - `none` → forces no prefix.
- `PUBLIC_CALLBACK_URL` — Public HTTPS base for Google Wallet callbacks. Only honoured when **not** deployed (`VERCEL_ENV` unset). `callbackOptions.url` is written into the class on **every** publish.
  - Resolution order: `PUBLIC_CALLBACK_URL` (local only) → `NEXT_PUBLIC_API_URL` → `NEXT_PUBLIC_VERCEL_BRANCH_URL` → `VERCEL_URL`. A localhost result, or nothing, throws `WALLET_CALLBACK_UNSAFE`.
  - **Needs ngrok for:** any local template/program **Publish**, and local runs of repair scripts that republish classes.
  - **Workflow:** start ngrok → set `PUBLIC_CALLBACK_URL` to the `https://…ngrok-free.dev` URL → restart `npm run dev:api`.
  - Fine to stop ngrok after publishing. Google calls back later on a save/delete; a dead tunnel then fails silently.
  - **Not needed for:** CRUD, dashboard, issuing passes, non-wallet features.
- `WALLET_WEBHOOK_SECRET` — **Obsolete since Phase 7.2 for authorisation.** If set, it is still appended as a path segment to the callback URL (`/passes/webhooks/google-wallet/<secret>`) so existing class URLs stay stable; the route ignores it. Signature verification is the only gate.
- `WALLET_SAVE_ORIGINS` — Comma-separated origins put in the save-link JWT `origins` claim. Unset → derived from `FRONTEND_URL`, `NEXT_PUBLIC_BASE_URL`, `VERCEL_URL`.

### RLS read path (Phase 7.3, Optional)

- `SUPABASE_JWT_SECRET` — Supabase project's JWT secret. Lets `SupabaseService.forTenant()` mint a 1-hour `authenticated` token with a `tenant_id` claim.
  - Needs the anon key as well. Either missing → one warning on first use, service-role client returned instead.
  - No service calls `SupabaseService.forTenant()` yet — it is available, not in use.

### URLs / CORS (Optional)

- `FRONTEND_URL` — Extra CORS origin allowed by `main.ts` (localhost / 127.0.0.1 always allowed) and a save-origin candidate.
- `NEXT_PUBLIC_BASE_URL` — Public frontend base used to build enrollment / pass links (`/p/:id`) sent over WhatsApp. Falls back to Vercel URLs.
- `PORT` — API port. Default `3001`.

### WhatsApp via WAHA (Optional)

Read by `apps/api/src/notification/whatsapp.provider.ts`:

- `WAHA_BASE_URL` — WAHA server base URL.
- `WAHA_API_KEY` — WAHA API key.
- `WAHA_SESSION` — WAHA session name.

`WAHA_BASE_URL` unset → each send logs a warning and is skipped; business operations continue. Sends time out after 60s and retry up to 2 times.

### Scripts (Optional)

- `DEMO_TENANT_IDS` — Comma-separated tenant ids that `npm run demo:reset` may wipe.

## Critical Gotchas

1. **`GOOGLE_PRIVATE_KEY` newlines:** keep the key on one line with literal `\n` escapes (as in the JSON export), or as a real multi-line quoted value. Both are normalised. A key whose `\n` got double-escaped to `\\n` breaks signing.
2. **Env load order:** root `.env` wins over `apps/api/.env` for any var defined in both.
3. **Supabase failures are silent** if keys are wrong — queries return errors per request, not at boot. Check `npm run dev:api` output.
4. **Boot-fatal vars:** only `JWT_SECRET` and `WALLET_CREDENTIALS_KEY`. Google Wallet vars fail lazily on first wallet call.
5. **`NEXT_PUBLIC_*` baking:** frontend `NEXT_PUBLIC_*` values are baked at build time — rebuild after changing them. `NEXT_PUBLIC_API_URL` only matters to the proxy + SSR (restart dev / redeploy).
6. **Vercel preview:** proxy derives the sibling `linearcard-api` branch deployment. Set `API_ORIGIN` only if the backend lives elsewhere.
7. **Shared data:** local, preview and production share one Supabase project and one Wallet issuer. `WALLET_ENV_PREFIX` separates classes; nothing separates DB rows.
8. **Vercel env var scope — set at environment type, never at a specific git branch.** Feature branches (`feat/*`, `chore`, `refactor`, …) are deleted after merge, so a var scoped to `Preview (some-branch-name)` silently stops applying the moment that branch is gone or a new one is opened — the next preview build just doesn't have it. This has already caused a real outage: `JWT_SECRET` and `WALLET_CREDENTIALS_KEY` (both boot-fatal, see #4) were once scoped to `Preview (chore)` only, so every preview deploy on any other branch failed to boot. Always run `vercel env add <NAME> preview` with an **empty git-branch arg** (applies to all Preview branches) — never `vercel env add <NAME> preview <branch>` — unless a var must genuinely differ per branch, which none currently do.
9. **Turborepo strict env mode:** any var read at build time (by either app) must be listed in root `turbo.json`'s `globalEnv`, or Vercel prints a `[warn] ... missing from "turbo.json"` build warning for it (cosmetic today, but Turborepo can be configured to make this fatal — keep the list current so that's safe to flip). Add new var names there when you add them to Vercel.

## Local Development Example

```bash
# root .env (or apps/api/.env)
NEXT_PUBLIC_SUPABASE_URL=https://project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

ISSUER_ID=3388000000012345678
GOOGLE_CLIENT_EMAIL=service@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANB...\n-----END PRIVATE KEY-----\n"

JWT_SECRET=<openssl rand -base64 32>
WALLET_CREDENTIALS_KEY=<openssl rand -hex 32>

# only when publishing classes locally
PUBLIC_CALLBACK_URL=https://abc123.ngrok-free.dev

WAHA_BASE_URL=http://localhost:3002
WAHA_API_KEY=...
WAHA_SESSION=default
```

```bash
# apps/web/.env
API_ORIGIN=http://localhost:3001
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=...
```

## Removed (No Longer Read)

- `JOBS_DISABLED`, `JOB_POLL_INTERVAL_MS` — job queue removed in Phase 7.4.
- `WAHA_API_URL` — never read; the provider uses `WAHA_BASE_URL`.
