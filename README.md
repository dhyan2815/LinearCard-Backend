# LinearCard Backend

NestJS API for LinearCard — a multi-tenant digital loyalty, ticket, gift card and membership platform built on Google Wallet passes, with WhatsApp notifications and a Supabase (Postgres) data store.

Frontend lives in [LinearCard-Frontend](https://github.com/dhyan2815/LinearCard-Frontend).

## Tech Stack

- **Runtime:** Node.js 20+, TypeScript
- **Framework:** NestJS 10 (Express)
- **Database:** Supabase (Postgres), service-role client
- **Wallet:** Google Wallet REST API + JWT save links (`google-auth-library`, `googleapis`)
- **Messaging:** WhatsApp via [WAHA](https://waha.devlike.pro/)
- **Testing:** Jest, Supertest

## Features

- **Programs** — create loyalty, ticket, gift card, coupon and student ID programs from presets, gated by the tenant's business category
- **Pass templates** — design, publish and resync Google Wallet classes and objects
- **Pass issuance** — single issuance path for enrollment, payments and generated passes, with tier assignment
- **Transactions** — award, redeem, load and validate via `process-order`, with automatic tier recompute and Wallet push
- **Members CRM** — member list and detail, balance adjustment, DPDP export and erase
- **Campaigns** — preview and send WhatsApp campaigns, gated by consent and opt-out
- **Payments** — HMAC-verified PSP webhooks that enroll members and issue passes
- **Developer surface** — hashed API keys and signed outbound webhooks (`pass.installed`, `points.awarded`, `tier.changed`, …)
- **Auth** — 4-digit OTP for members and admins, admin session JWT in an httpOnly cookie
- **Audit** — `AuditLog`, `ConsentLog`, `NotificationLog` and `WebhookDelivery` trails

## Getting Started

### Prerequisites

- Node.js 20+
- A Supabase project
- A Google Wallet issuer account and service account
- (Optional) A WAHA server for WhatsApp
- (Optional) [ngrok](https://ngrok.com/) for publishing Wallet classes locally

### Install

```bash
git clone https://github.com/dhyan2815/LinearCard-Backend.git
cd LinearCard-Backend
npm install
cp .env.example .env
```

### Configure

Fill in `.env`. Only `JWT_SECRET` and `WALLET_CREDENTIALS_KEY` are boot-fatal; everything else fails lazily on first use.

| Variable | Required | Purpose |
|---|---|---|
| `JWT_SECRET` | Yes | Signs admin session JWTs. `openssl rand -base64 32` |
| `WALLET_CREDENTIALS_KEY` | Yes | Encrypts per-tenant Wallet private keys at rest. `openssl rand -hex 32` |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL (`SUPABASE_URL` also accepted) |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service-role key |
| `ISSUER_ID` | Yes* | Google Wallet issuer id |
| `GOOGLE_CLIENT_EMAIL` | Yes* | Service account email |
| `GOOGLE_PRIVATE_KEY` | Yes* | Service account private key (single line with `\n` escapes is fine) |
| `WAHA_BASE_URL`, `WAHA_API_KEY`, `WAHA_SESSION` | No | WhatsApp sends. Unset → sends are skipped with a warning |
| `FRONTEND_URL` | No | Extra allowed CORS origin |
| `NEXT_PUBLIC_BASE_URL` | No | Public frontend URL used in enrollment and pass links |
| `WALLET_ENV_PREFIX` | No | Wallet class-id namespace. Defaults to `dev` locally; `none` disables it |
| `PUBLIC_CALLBACK_URL` | No | ngrok HTTPS URL for Wallet callbacks — local Wallet publishing only |
| `PORT` | No | API port, default `3001` |

\* Required unless every tenant has its own Wallet credentials stored on the `Tenant` row.

### Database

Migrations live in `supabase/migrations/`. Apply them with the Supabase CLI:

```bash
npx supabase link --project-ref <project-ref>
npx supabase db push
```

### Run

```bash
npm run dev          # watch mode on http://localhost:3001
npm run build        # compile to dist/
npm run start:prod   # run the compiled build
```

Health check: `GET /health`.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start with file watching |
| `npm run start:debug` | Start with debugger and watching |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start:prod` | Run the compiled build |
| `npm run lint` | ESLint with `--fix` |
| `npm run format` | Prettier |
| `npm run test` | Unit and regression suites (`src/**/*.spec.ts`) |
| `npm run test:watch` | Jest in watch mode |
| `npm run test:cov` | Coverage report in `coverage/` |
| `npm run test:e2e` | E2E smoke test (`test/`) |
| `npm run waha` | WAHA CLI helper |
| `npm run demo:reset` | Wipe demo tenants listed in `DEMO_TENANT_IDS` |

Run a single test file:

```bash
npm run test -- wallet.service.spec.ts
```

## Project Structure

```
src/
├── auth/           # Member + admin OTP, signup, TenantGuard
├── programs/       # Program CRUD, presets, tiers, analytics
├── templates/      # Pass templates, Wallet class publish
├── passes/         # Issuance, process-order, validate, /p/:id public link
├── members/        # CRM, balance adjustment, DPDP export/erase
├── campaigns/      # WhatsApp campaigns
├── payments/       # PSP webhooks
├── developers/     # API keys, outbound webhooks
├── notification/   # WhatsApp provider, OTP, notify service
├── notifications/  # Notification log, inbound STOP/START
├── wallet/         # Google Wallet client, JWS callback verification
├── tiers/          # computeTier()
├── tenant/ settings/ dashboard/ audit/ supabase/
├── env.ts          # Env loading and boot checks
└── main.ts         # Entry point
supabase/migrations/  # SQL migrations
scripts/              # Maintenance and repair scripts
tests/                # Ad-hoc API check scripts (.mjs)
```

## Multi-Tenancy

All queries use the Supabase service-role client, which bypasses RLS. Every query **must** filter by `tenantId` explicitly. Guarded routes get `req.tenantId` from `TenantGuard`; never trust a `tenantId` from the request body or query.

## Deployment

Deployed on [Render](https://render.com/) via `render.yaml`:

| Service | Branch | `WALLET_ENV_PREFIX` |
|---|---|---|
| `linearcard-api` | `master` | `none` |
| `linearcard-api-dev` | `DEV` | `dev` |

Set secret env vars in the Render dashboard. Build: `npm install && npm run build`. Start: `npm run start:prod`.

## License

Private — all rights reserved.
