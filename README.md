# LinearCard

![Next.js](https://img.shields.io/badge/Next.js-16%20(App%20Router)-black?style=flat-square&logo=next.js)
![NestJS](https://img.shields.io/badge/NestJS-10-E0234E?style=flat-square&logo=nestjs)
![React](https://img.shields.io/badge/React-19-blue?style=flat-square&logo=react)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-v4-06B6D4?style=flat-square&logo=tailwind-css)
![Supabase](https://img.shields.io/badge/Supabase-Database-3ECF8E?style=flat-square&logo=supabase)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript)
![Google Wallet](https://img.shields.io/badge/Google%20Wallet-API%20REST%20%2B%20JWT-4285F4?style=flat-square&logo=google)

**LinearCard** is a multi-tenant digital pass & loyalty platform for **Google Wallet**. It pairs a Linear-inspired admin dashboard with a program-scoped loyalty engine, a staff POS scanner, a developer platform, and customer engagement via WhatsApp (WAHA) and Google Wallet messages.

A tenant runs multiple **programs** — loyalty clubs, gym memberships, event and travel tickets, business cards, gift cards, coupons, stamp cards, access passes and student IDs — each created from a preset. Every program owns its pass template, tiers, store locations, WhatsApp templates and enrollment link, and gets its own workspace in the dashboard.

> This README is shared by both repositories:
> - **[LinearCard-Frontend](https://github.com/dhyan2815/LinearCard-Frontend)** — Next.js 16 dashboard, scanner and enrollment app (Vercel)
> - **[LinearCard-Backend](https://github.com/dhyan2815/LinearCard-Backend)** — NestJS 10 API, Supabase migrations and scripts (Render)

---

## Architecture

```
 Browser (admin / staff / customer)
        │
        ▼
 LinearCard-Frontend  (Next.js 16, Vercel, :3000)
   └── /api/*  ──rewrite proxy──►  LinearCard-Backend  (NestJS 10, Render, :3001)
                                        ├── Supabase Postgres (service-role client, explicit tenantId filters)
                                        ├── Google Wallet REST API (classes, objects, messages, save-link JWTs)
                                        ├── WAHA (WhatsApp OTP, pass links, receipts, campaigns)
                                        └── Outbound webhooks to tenant endpoints
 Google Wallet ──signed callback──► /passes/webhooks/google-wallet
 PSP / POS     ──HMAC webhook────► /webhooks/payment/:tenantId, /passes/webhooks/external-order
```

- The browser only ever calls its own origin (`/api/*`). `next.config.mjs` proxies those calls to the backend, so there is no CORS and the `admin_session` cookie stays same-origin.
- All business logic, database access and third-party calls live in the backend. Side effects (Wallet push, WhatsApp, webhooks) run after the database write and never roll it back.
- Everything runs in-request — there is no job queue. Campaigns send in chunks of 25.

---

## Features & Capabilities

### Google Wallet Integration
- **Signed Save Links:** RS256-signed JWTs minted on demand. The public `/p/:id` link mints a fresh save link on every visit, so links are never cached.
- **Per-Tenant Credentials:** Each tenant can bring its own issuer and service account (`WalletService.forTenant()`), stored AES-256-GCM encrypted, with fallback to platform env credentials.
- **Real-Time Pass Updates:** Balance, points and tier changes patch the Wallet object right after each transaction.
- **Verified Callbacks:** Save/delete callbacks are verified with Google's ECv2SigningOnly (ECDSA-P256) signatures.
- **Wallet Messages:** Promotional messages pushed straight to the pass.
- **Dynamic Pass Fields:** Configurable field rows (labels, values, subheaders, barcode text) bound to each program's template.

### Program-Scoped Dashboard
- **Account level:** program gallery (`/dashboard`), create from preset (`/dashboard/programs/new`), all members (`/dashboard/members`), developer platform (`/dashboard/developers`), tenant settings (`/dashboard/settings`).
- **Program workspace** (`/dashboard/programs/[id]/…`):
  - **Overview** — revenue, orders, points awarded and redeemed over time.
  - **Members** — program CRM, member detail, balance adjustments, test-account flag, DPDP actions.
  - **Activity** — live stream of transactions and pass events.
  - **Campaigns** — WhatsApp campaigns with audience filters (tier, inactivity, test accounts), dry-run preview, chunked send and delivery tracking.
  - **Design** — pass template designer with colors, logo, hero image, field rows and an on-device preview.
  - **Tiers** — tier thresholds, perks and earn/redeem economics (earn rate, redeem rate, redemption cap).
  - **Locations** — store locations on Google Maps, synced to the Wallet class.
  - **Messages** — per-program WhatsApp templates with `{{variables}}`.
  - **Settings** — name, slug, welcome message, and program deletion.
  - **Enrollment link** — QR code and copyable link to `/enroll/[slug]/[programSlug]` in the program nav.
- `/dashboard/programs/[id]/events` lists pass lifecycle events (reachable by URL).

### 13 Program Presets
Presets are filtered by the tenant's **business category** (Retail, Food & Beverage, Salon/Spa/Fitness, Events, Travel, Education, Professional Services), enforced server-side.

| Preset | Kind | Notes |
|---|---|---|
| Coffee Loyalty | `loyalty` | Points per spend, tiers, redemption cap |
| Gym Membership | `loyalty` | Visit mode — each scan counts as one check-in |
| Event Tickets | `ticket` | Seat/row/gate captured at enrollment, check-in marks the pass used, expires after the event |
| Travel Tickets | `ticket` | Transport number, seat and gate |
| Modern Membership | `loyalty` | Member ID and expiry |
| Tiered Membership | `loyalty` | Multi-tier membership with perks |
| Loyalty Offer | `loyalty` | Promotional reward pass |
| Business Card | `loyalty` | Contact card, no points or tiers |
| Gift Card | `giftcard` | Stored value — `load` credits money, `redeem` spends it |
| Single-Use Coupon | `coupon` | Scannable discount coupon |
| Stamp Card | `loyalty` | Visit mode with a reward threshold notification |
| Access Pass | `ticket` | Zone/validity badge |
| Student ID | `studentid` | Institution and roll number, validate-only |

Tier-less programs (tickets, coupons, business cards, access passes, student IDs) omit tier badges, points and loyalty subheaders on the Wallet pass.

### Consumer Enrollment
- **Mobile-first flow** at `/enroll/[slug]/[programSlug]` (`/enroll/[slug]` resolves to the tenant's default program).
- **4-digit OTP over WhatsApp** — SHA-256 hashed, timing-safe compare, 5-minute expiry, locked after 5 wrong attempts. No dev bypass.
- **Per-program enrollment fields** — e.g. seat for an event ticket, roll number for a student ID — stored on the pass.
- **Consent tracking** in `ConsentLog`; WhatsApp `STOP`/`START` handled inbound.
- **Shared phone numbers** — family members can share a number within a tenant.

### Loyalty Engine & Staff Scanner
- **Order-linked points** — award on order totals with configurable earn rate, redeem rate and redemption cap.
- **Pure tier computation** — `computeTier()` evaluates the program's tier rows on every transaction.
- **Staff scanner (`/scan`)** — camera QR/barcode scan, pass validation, award/redeem via `process-order`, ticket check-in and scan history.
- **Payments** — HMAC-SHA256 PSP webhooks with 5-minute timestamp replay protection, plus a built-in simulator.

### Developer Platform
- **API keys** — SHA-256 hashed, created and revoked from `/dashboard/developers`.
- **Outbound webhooks** — `pass.installed`, `pass.deleted`, `points.awarded`, `points.redeemed`, `tier.changed`, `member.enrolled`, with test events and a delivery log.
- **Idempotency** — `POST`/`PUT`/`PATCH`/`DELETE` requests carrying an `Idempotency-Key` header replay the stored response instead of running twice. The frontend API client adds the key automatically.

### Security & DPDP Compliance
- **Data export:** `GET /members/:id/export`.
- **Erasure:** `DELETE /members/:id?mode=erase` (default) anonymises in place and keeps the audit trail; `?mode=purge` hard-deletes.
- **Audit trail:** `AuditLog`, `ConsentLog`, `NotificationLog`, `WebhookDelivery`.
- **Admin auth:** OTP login, JWT in an httpOnly `admin_session` cookie (1 day) or `Authorization: Bearer`.
- **Tenant isolation:** every query filters on `tenantId`, taken from `TenantGuard` — never from the request body or query.

---

## Tech Stack

### Frontend — [LinearCard-Frontend](https://github.com/dhyan2815/LinearCard-Frontend)
- **Framework:** Next.js 16 (App Router, Turbopack), React 19, TypeScript
- **Styling:** Tailwind CSS v4, Lucide icons, Geist font
- **Motion & 3D:** `motion` / Framer Motion, Three.js + `@react-three/fiber` (landing hero), `canvas-confetti`
- **Maps & Scanning:** `@vis.gl/react-google-maps`, `@yudiel/react-qr-scanner`, `qrcode.react`
- **UX:** `recharts`, `sonner` toasts, `nextjs-toploader`
- **API client:** `lib/api-client.ts` — `/api/*` proxy, retries, automatic `Idempotency-Key`
- **Route protection:** `proxy.ts` redirects unauthenticated `/dashboard` and `/scan` visits to `/login`

### Backend — [LinearCard-Backend](https://github.com/dhyan2815/LinearCard-Backend)
- **Framework:** NestJS 10 (Express), TypeScript
- **Database:** Supabase Postgres (camelCase columns), migrations in `supabase/migrations/`
- **Google Wallet:** Wallet Objects REST API via `google-auth-library`, `jsonwebtoken` (RS256)
- **WhatsApp:** WAHA HTTP provider (60s timeout, 2 retries)
- **Testing:** Jest unit and regression suites, Supertest e2e smoke test

| Module | Routes | Purpose |
|---|---|---|
| `auth/` | `/auth/*` | Member OTP, admin OTP login, self-serve signup, `me`, logout, `TenantGuard` |
| `programs/` | `/programs/*` | Presets, program CRUD, tiers, publish, location sync, overview, members, events |
| `templates/` | `/templates/*` | Pass templates, Wallet class publish, preview pass, resync passes |
| `passes/` | `/passes/*`, `/p/:id` | Issuance, `process-order`, `validate-pass`, scan history, promo messages, POS + Wallet webhooks |
| `members/` | `/members/*` | CRM, test-account flag, balance adjustment, DPDP export/erase |
| `campaigns/` | `/campaigns/*` | Preview, send, list, detail |
| `payments/` | `/webhooks/payment/:tenantId`, `/payments/*` | PSP webhook, webhook config, simulator |
| `developers/` | `/developers/*` | API keys, outbound webhook endpoints |
| `notifications/` | `/notifications/*` | Notification log, inbound WhatsApp STOP/START |
| `tenant/`, `settings/` | `/tenant/*`, `/settings`, `/admin/*` | Tenant lookup, business details, production approval, settings |
| `dashboard/` | `/dashboard/stats` | Tenant stats |
| `wallet/`, `notification/`, `tiers/`, `audit/`, `supabase/` | — | Wallet client, WhatsApp/OTP, `computeTier()`, audit, Supabase client |

`GET /health` is the Render health check.

---

## Project Structure

```
LinearCard-Frontend/
├── app/
│   ├── page.tsx                      # Landing page
│   ├── login/                        # Admin OTP login + signup
│   ├── dashboard/
│   │   ├── _components/              # DashboardContext, DashboardSidebar, ProgramNav, shared views
│   │   ├── programs/                 # Gallery, /new, and [id]/ program tabs:
│   │   │   └── [id]/                 #   overview, members, activity, campaigns, design,
│   │   │                             #   tiers, locations, messages, settings, events
│   │   ├── members/                  # Account-wide members + [id] detail
│   │   ├── developers/               # API keys & webhooks
│   │   └── settings/                 # Tenant settings
│   ├── enroll/[slug]/[programSlug]/  # Consumer enrollment + OTP
│   └── scan/                         # Staff scanner
├── components/                       # Pass previews, wallet modal, scan history, ui/ primitives
├── lib/
│   ├── api-client.ts                 # Fetch wrapper
│   └── types.ts                      # Shared domain types
├── diagrams/                         # Architecture diagrams
├── proxy.ts                          # Route protection
└── next.config.mjs                   # /api/* → backend rewrite

LinearCard-Backend/
├── src/
│   ├── auth/ programs/ templates/ passes/ members/ campaigns/ payments/
│   ├── developers/ notifications/ notification/ wallet/ tiers/
│   ├── tenant/ settings/ dashboard/ audit/ supabase/
│   ├── *.spec.ts                     # Regression suites
│   ├── types.ts                      # Shared domain types (kept in sync with frontend lib/types.ts)
│   ├── env.ts                        # Env loading, boot checks, secret encryption
│   ├── idempotency.interceptor.ts    # Global Idempotency-Key handler
│   └── main.ts                       # Bootstrap, CORS, port 3001
├── supabase/migrations/              # SQL migrations
├── scripts/                          # Wallet repair, backfills, WAHA CLI, demo reset
├── test/                             # Jest e2e
├── tests/                            # Ad-hoc API check scripts
└── render.yaml                       # Render services (master → prod, DEV → dev)
```

---

## Diagrams

Regenerated 2 October 2026 from the current code: the Supabase table set, the
`/passes/process-order` pipeline, and the live route map. Sources are authored
as Excalidraw scenes and exported to PNG.

### Business Flow

Tenant onboarding through to a wallet pass living in a member's phone, as four
swimlanes (Business Admin, LinearCard API, Google Wallet, Member). Ends with the
post-save fan-out every transaction triggers.

![Business Flow Diagram](diagrams/Business%20Flow%20Diagram.png)

### Process Flow

A counter scan to a settled pass: `POST /passes/process-order` →
`processOrderTransaction()` → `syncPassAfterTransaction()`, including the
`award` / `redeem` / `load` branch, the per-`kind` guards, and the single
fan-out point (tier recompute, Wallet push, WhatsApp receipt, webhook dispatch,
audit write). Wallet, WhatsApp and webhook failures never roll back the DB write.

![Process Flow Diagram](diagrams/Process%20Flow%20Diagram.png)

### Entity-Relationship Diagram

All 17 Supabase tables with their primary and foreign keys. Every table is
tenant-scoped; queries use the service-role client, so each one filters on
`tenantId` explicitly. Deletes cascade from `Tenant`, while `Program` / `Pass`
FKs use `ON DELETE SET NULL` where history has to survive.

![ER Diagram](diagrams/ER%20Diagram.png)

### Use Case (Restaurant)

A restaurant running a points loyalty program: Owner, Cashier and Diner against
the system boundary, with Google Wallet, WhatsApp/WAHA and the POS/PSP as
external actors.

![Use Case Diagram](diagrams/Use%20Case%20(Restuarant)%20Diagram.png)

---

## Getting Started

### Prerequisites
- **Node.js** 20.9 or higher, npm
- **Supabase** project (URL + service-role key)
- **Google Cloud** service account with Google Wallet API access, and a Wallet issuer ID
- **WAHA** server (optional — without it WhatsApp sends are skipped)
- **ngrok** (optional — only to publish Wallet classes locally)

### 1. Backend

```bash
git clone https://github.com/dhyan2815/LinearCard-Backend.git
cd LinearCard-Backend
npm install
cp .env.example .env
```

Fill in `.env`:

```env
# Required at boot
JWT_SECRET=                 # openssl rand -base64 32
WALLET_CREDENTIALS_KEY=     # openssl rand -hex 32

# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Google Wallet platform defaults
ISSUER_ID=your-google-wallet-issuer-id
GOOGLE_CLIENT_EMAIL=wallet-service-account@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# WhatsApp (optional)
WAHA_BASE_URL=http://localhost:3002
WAHA_API_KEY=
WAHA_SESSION=default

# URLs
FRONTEND_URL=http://localhost:3000
NEXT_PUBLIC_BASE_URL=http://localhost:3000

# Only while publishing a Wallet class locally
PUBLIC_CALLBACK_URL=https://your-ngrok-domain.ngrok-free.app
```

Apply the database migrations and start the API:

```bash
npx supabase link --project-ref <project-ref>
npx supabase db push
npm run dev                 # http://localhost:3001
```

### 2. Frontend

```bash
git clone https://github.com/dhyan2815/LinearCard-Frontend.git
cd LinearCard-Frontend
npm install
cp .env.example .env
```

```env
API_ORIGIN=http://localhost:3001          # backend the /api/* proxy forwards to
NEXT_PUBLIC_API_URL=http://localhost:3001 # backend URL for server-side rendering
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=          # optional, Locations tab
```

```bash
npm run dev                 # http://localhost:3000
```

Run the backend and frontend in two separate terminals.

---

## NPM Scripts

### Frontend
| Command | Description |
|---|---|
| `npm run dev` | Next.js dev server on port 3000 |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |

### Backend
| Command | Description |
|---|---|
| `npm run dev` | NestJS with watch mode on port 3001 |
| `npm run build` | Compile to `dist/` |
| `npm run start:prod` | Run the compiled build |
| `npm run lint` | ESLint with `--fix` |
| `npm run format` | Prettier |
| `npm run test` | Jest unit + regression suites |
| `npm run test:cov` | Coverage report |
| `npm run test:e2e` | E2E smoke test |
| `npm run waha` | WAHA CLI helper |
| `npm run demo:reset` | Wipe demo tenants listed in `DEMO_TENANT_IDS` |

---

## Deployment

| App | Host | Production | Development |
|---|---|---|---|
| Frontend | Vercel | `master` | `DEV` and other branches as previews |
| Backend | Render (`render.yaml`) | `linearcard-api` from `master` | `linearcard-api-dev` from `DEV` |

- Point the frontend's `API_ORIGIN` / `NEXT_PUBLIC_API_URL` at the matching backend, then redeploy — the proxy target is baked in at build time.
- `WALLET_ENV_PREFIX` keeps Wallet classes apart per environment (`none` on prod, `dev` on dev). Both environments share one Supabase project and one Wallet issuer.
- Set the backend's `FRONTEND_URL` to the frontend origin for CORS. `*.vercel.app` and localhost are always allowed.

---

## Key Guidelines & Gotchas

1. **Tenant isolation:** the backend uses Supabase's service-role key, which bypasses RLS. Every query must include `.eq('tenantId', tenantId)`, with `tenantId` taken from `TenantGuard`.
2. **Programs own their resources:** template, tiers, locations, WhatsApp templates and enrollment slug all belong to one program.
3. **One issuance path:** passes are created only through `PassIssuanceService.issueForMember()`.
4. **Check `Program.kind`, not loyalty:** `loyalty | ticket | giftcard | coupon | studentid` behave differently in the transaction pipeline.
5. **Never cache save links:** always share `/p/:id`, which mints a fresh one.
6. **Side effects are best-effort:** Wallet, WhatsApp and webhook failures are logged and never roll back the database. A pass on a phone can update a moment after the balance is saved.
7. **Shared types:** `lib/types.ts` (frontend) and `src/types.ts` (backend) are copies — change both together.
8. **`NEXT_PUBLIC_*` is baked at build time:** rebuild the frontend after changing it.

---

## License

MIT License.
