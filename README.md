# LinearCard

![Turborepo](https://img.shields.io/badge/Turborepo-Monorepo-EF4444?style=flat-square&logo=turborepo)
![Next.js](https://img.shields.io/badge/Next.js-16%20(App%20Router)-black?style=flat-square&logo=next.js)
![NestJS](https://img.shields.io/badge/NestJS-10-E0234E?style=flat-square&logo=nestjs)
![React](https://img.shields.io/badge/React-19-blue?style=flat-square&logo=react)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-v4-06B6D4?style=flat-square&logo=tailwind-css)
![Supabase](https://img.shields.io/badge/Supabase-Database-3ECF8E?style=flat-square&logo=supabase)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square&logo=typescript)
![Google Wallet](https://img.shields.io/badge/Google%20Wallet-API%20REST%20%2B%20JWT-4285F4?style=flat-square&logo=google)

**LinearCard** is an enterprise-grade, multi-tenant digital pass & loyalty platform for **Google Wallet** (with Apple and Samsung Wallet planned). It pairs a Linear-inspired dark-mode admin dashboard and real-time 3D pass rendering with an advanced program-scoped loyalty engine, POS scanner, developer platform, and multi-channel engagement via WhatsApp (WAHA) and Google Wallet push notifications.

In LinearCard, a tenant runs multiple **programs** (loyalty clubs, gym memberships, event tickets, travel passes, digital business cards, coupons, gift cards, and stamp cards) instantiated from presets. Each program owns its pass templates, tier thresholds, store locations, WhatsApp messaging templates, and consumer enrollment slug - organizing the entire brand dashboard into program-scoped operational workspaces.

---

## Features & Capabilities

### Google Wallet Integration
- **Cryptographic JWT Signing:** RS256-signed JWTs generated on-demand for instant, one-click pass saving via `/p/:id`.
- **Per-Tenant Credentials:** Isolated Google Cloud service accounts per tenant (`WalletService.forTenant()`) with seamless fallback to environment defaults.
- **Real-Time REST Updates:** Asynchronous pass updates (`GenericObject` patching) upon balance adjustments, point changes, and tier upgrades.
- **Discoverable Save Callbacks:** Automatic webhook callback registration verified via JWS (ECv2SigningOnly ECDSA-P256) signature verification.
- **Promotional Push Notifications:** Direct-to-lockscreen message broadcasting through Google Wallet API.
- **Dynamic Pass Fields:** Customizable field rows (labels, values, subheaders, barcode alt text) dynamically bound to the pass design.

### Program-Scoped Architecture & Two-Level Nav
- **Account-Level Destinations:** Global program switcher & catalog (`/dashboard`), developer platform (`/dashboard/developers`), and account settings (`/dashboard/settings`).
- **Program-Scoped Workspaces:** Dedicated secondary sidebar navigation containing 9 functional zones:
  - **Overview (`/overview`):** Program-level revenue, order volume, active member count, and points distribution charts.
  - **Members (`/members`):** Program CRM, member search, manual balance adjustments, test-account flags, and DPDP actions.
  - **Activity (`/activity`):** Real-time stream of program transactions, points earned/redeemed, and pass events.
  - **Campaigns (`/campaigns`):** Push campaign broadcasts with audience segmentation (tier, balance, inactivity, test accounts), dry-run previews, chunked dispatch, and delivery tracking.
  - **Design (`/design`):** Visual pass template designer with color pickers, hero banner upload, logo placement, custom field rows, and an **on-device live pass preview modal**.
  - **Tiers (`/tiers`):** Tier progression editor with minimum points thresholds, perk descriptions, and automatic upgrade triggers.
  - **Locations (`/locations`):** Program-specific store locations with interactive Google Maps integration.
  - **Messages (`/messages`):** Brand-customizable WhatsApp templates with dynamic `{{variables}}` for OTP, pass links, redemption receipts, and tier upgrades.
  - **Settings (`/settings`):** Program metadata, publish status, loyalty economics (earn rate, redeem rate, redeem cap %), and safe program deletion with confirmation modal.
  - **Enrollment Link Widget:** Persistent in-sidebar QR code and copyable enrollment link (`/enroll/[slug]/[programSlug]`).

### 12 Ready-to-Use Program Presets
Launch loyalty and membership programs in seconds with rich, contextual imagery and tailored schemas:
- **Coffee Loyalty:** Points per currency spent, 3 tiers, 50% redemption cap.
- **Gym Membership:** Check-in tracking, membership tiers, trainer notes.
- **Event Ticket:** Tier-less pass with seat/row, gate, and event date/time.
- **Travel Ticket:** Tier-less boarding pass with transport number, seat, and gate.
- **Modern Membership:** Community and club membership with member ID and expiry.
- **Tiered Membership:** Luxury multi-tier membership with exclusive VIP perks.
- **Loyalty Offer:** Limited-time reward and promotional pass.
- **Digital Business Card:** Professional contact card with titles and social links.
- **Gift Card:** Stored-value card with real-time balance tracking.
- **Single-Use Coupon:** Discount coupon with scannable barcode and expiration.
- **Stamp Card:** Punch card for repeat visits and milestone rewards.
- **Access Pass:** Security badge with building/zone permissions and validity windows.

### Dynamic Pass Issuance (Tier-less Programs)
- Tier-less presets (tickets, coupons, business cards, access badges) omit tier badges, point balances, and loyalty subheaders on the Google Wallet pass, maintaining a clean aesthetic without awkward empty labels.

### Consumer Onboarding & Mobile Enrollment
- **Mobile-First Web App:** Responsive enrollment flow at `/enroll/[slug]/[programSlug]`.
- **Secure 4-Digit OTP:** SHA-256 hashed, timing-safe verification, 5-minute expiry, locked after 5 incorrect attempts.
- **Consent Tracking:** Granular marketing consent tracking recorded in `ConsentLog` for DPDP/GDPR compliance.
- **Phone Duplication Support:** Allows multiple family members to share a phone number within a tenant while strictly preventing collision with `Admin` login accounts.

### Loyalty Engine, Redemption & Staff POS Scanner
- **Order-Linked Points Engine:** Points awarded and redeemed based on order totals, with configurable earn and redemption discount caps.
- **Pure Tier Computation:** Transaction-level pure `computeTier()` evaluation against the active program's tier definitions.
- **Staff Scanner (`/scan`):** Camera-based barcode/QR scanner for cashiers, member profile lookup, order amount entry, and transaction history.
- **PSP Simulator:** Payment webhook simulator with HMAC-SHA256 signing and replay protection.

### Developer Platform & Webhooks
- **API Keys:** Secure, SHA-256 hashed API keys for external service integration.
- **Outbound Webhooks:** Event notifications for `pass.installed`, `pass.deleted`, `points.awarded`, `points.redeemed`, `tier.changed`, and `member.enrolled` with retry history and delivery logs.
- **Global Idempotency:** Interceptor guarantees at-most-once execution on mutating requests (`POST`/`PUT`/`PATCH`/`DELETE`) carrying an `Idempotency-Key` header.

### Enterprise Security & DPDP Compliance
- **Data Protection (DPDP):** Dedicated endpoints for member data export (`GET /members/:id/export`), soft erasure with pass anonymization (`DELETE /members/:id?mode=erase`), and hard purge (`DELETE /members/:id?mode=purge`).
- **Comprehensive Audit Trail:** `AuditLog`, `ConsentLog`, `NotificationLog`, and `WebhookDelivery` log every administrative and customer action.
- **Authentication:** HTTP-only JWT `admin_session` cookies (1-day validity) and bearer token authentication.
- **Tenant Isolation:** Explicit application-level `tenantId` filtering on every database query, backed by Supabase Row-Level Security policies.

---

## Tech Stack

### Monorepo & Tooling
- **Build System:** [Turborepo](https://turbo.build/) task pipeline orchestration
- **Package Manager:** npm workspaces (`apps/*`, `packages/*`)
- **Shared Types:** `@linearcard/types` (`packages/types`)  -  types compile from `index.ts`, runtime constants from `dist/`

### Frontend (`apps/web`)
- **Framework:** Next.js 16 (App Router, Turbopack, Port `3000`), React 19, TypeScript
- **Styling:** Tailwind CSS v4, PostCSS, Lucide Icons, Geist Font
- **Pass Visualization:** Three.js, `@react-three/fiber`, `@react-three/drei` (3D live pass preview)
- **Maps & Scanning:** `@vis.gl/react-google-maps` (store locations), `@yudiel/react-qr-scanner` (staff scanner), `qrcode.react`
- **Animation & UX:** Framer Motion (`motion`), `canvas-confetti`, `sonner` toasts, `nextjs-toploader`, `recharts`
- **API Client:** Type-safe HTTP client (`lib/api-client.ts`) utilizing Next.js rewrite proxying (`/api/*` -> backend) and automatic idempotency key attachment

### Backend (`apps/api`  -  NestJS 10)
- **Framework:** NestJS 10 (Port `3001`), Express, TypeScript
- **Database:** Supabase (PostgreSQL) with camelCase column conventions
- **Google Wallet:** `@googleapis/walletobjects`, `google-auth-library`, `jsonwebtoken` (RS256)
- **WhatsApp Integration:** WAHA (WhatsApp HTTP API) provider for transaction & campaign messaging
- **Architecture Modules:**
  - `auth/`  -  Member OTP, admin login, self-serve signup, `TenantGuard`
  - `programs/`  -  Program CRUD from presets, tier management, publish actions, location sync
  - `templates/`  -  PassTemplate CRUD, Google Wallet class publishing, preview, pass resyncing
  - `passes/`  -  Issuance (`PassIssuanceService`), order processing, validation, `/p/:id` save links, wallet callbacks
  - `members/`  -  CRM, balance adjustments, test-account flags, DPDP data export & deletion
  - `campaigns/`  -  Send-now campaigns: dry-run preview, batch dispatch, delivery reporting
  - `payments/`  -  PSP webhook receiver (HMAC verification), webhook simulator
  - `developers/`  -  API keys and outbound webhook subscriptions
  - `notifications/` & `notification/`  -  WhatsApp client, OTP delivery, inbound STOP/START handling
  - `wallet/`  -  Google Wallet REST client, JWT save links, JWS callback verification
  - `tiers/`  -  Pure `computeTier()` evaluation engine
  - `tenant/` & `settings/`  -  Tenant profiles, custom branding, domain settings
  - `dashboard/`, `audit/`, `supabase/`  -  Business analytics, audit logging, Supabase service client
- **Execution Model:** In-request synchronous processing (no complex background queues needed)

---

## Project Structure

```
linearcard/
├── apps/
│   ├── api/                           # NestJS Backend (Port 3001)
│   │   ├── src/
│   │   │   ├── audit/                 # Audit logging service
│   │   │   ├── auth/                  # Admin auth, member OTP, TenantGuard
│   │   │   ├── campaigns/             # Push campaign segmentation & dispatch
│   │   │   ├── dashboard/             # Business metrics & analytics queries
│   │   │   ├── developers/            # API keys & outbound webhooks
│   │   │   ├── members/               # Member CRM & DPDP endpoints
│   │   │   ├── notification/          # WhatsApp provider & templates
│   │   │   ├── notifications/         # Notification logs & inbound opt-outs
│   │   │   ├── passes/                # Pass issuance, order processing, /p/:id
│   │   │   ├── payments/              # PSP webhook simulator & handler
│   │   │   ├── programs/              # Program CRUD, presets, tiers, locations
│   │   │   ├── settings/              # Tenant & system settings
│   │   │   ├── supabase/              # Supabase client wrapper
│   │   │   ├── templates/             # Pass template designer & class publishing
│   │   │   ├── tenant/                # Tenant lookup & profile
│   │   │   ├── tiers/                 # Pure computeTier() utility
│   │   │   ├── wallet/                # Google Wallet REST, JWT signing, JWS callback
│   │   │   ├── app.module.ts          # Root NestJS module
│   │   │   ├── idempotency.interceptor.ts # Global Idempotency-Key handler
│   │   │   └── main.ts                # Application bootstrap
│   │   └── test/                      # E2E test suites
│   └── web/                           # Next.js 16 Frontend (Port 3000)
│       ├── app/
│       │   ├── dashboard/             # Admin Dashboard
│       │   │   ├── _components/       # DashboardSidebar, ProgramSidebar, Context
│       │   │   ├── developers/        # Developer API keys & webhooks page
│       │   │   ├── members/           # Global members view & [id] profile
│       │   │   ├── programs/          # Program gallery, creation (/new), and
│       │   │   │   └── [id]/          # Program-scoped tabs: overview, members,
│       │   │   │                      # activity, campaigns, design, tiers,
│       │   │   │                      # locations, messages, settings
│       │   │   └── settings/          # Tenant account settings
│       │   ├── enroll/[slug]/[programSlug] # Consumer onboarding & OTP flow
│       │   ├── login/                 # Admin OTP login
│       │   └── scan/                  # Staff POS barcode scanner
│       ├── components/                # Reusable UI & 3D pass cards
│       └── lib/api-client.ts          # Type-safe API client wrapper
├── packages/
│   └── types/                         # @linearcard/types (Monorepo data models)
│       ├── src/                       # TypeScript interfaces
│       └── index.ts
├── architecture/                      # Visual system architecture diagrams
│   ├── activity_diagram.jpg           # Core system activity flow
│   ├── data_flow_diagram.jpg          # System data flow diagram
│   ├── entity_relationship_diagram.jpg # Database ERD
│   └── sequence_diagram.jpg           # End-to-end issuance & order sequence
├── supabase/
│   └── migrations/                    # SQL schema migrations
├── docs/                              # Architecture specs, patterns, and PRDs
│   ├── EDGE_CASES.md                  # Edge cases and handling
│   ├── MULTI_TENANT.md                # Multi-tenancy isolation rules
│   ├── PATTERNS.md                    # Core engineering patterns
│   ├── TROUBLESHOOTING.md             # Common bugs and debugging steps
│   ├── WEBHOOKS.md                    # Inbound and outbound webhook reference
│   └── product/                       # PRD and competitor analysis
├── .claude/rules/                     # Workspace-specific developer guidelines
├── turbo.json                         # Turborepo task pipeline configuration
├── CLAUDE.md                          # Claude Code developer guide
├── GEMINI.md                          # Persistent project memory & changelog
├── AGENTS.md                          # Next.js 16 breaking change guidelines
└── README.md
```

---

## Visual System Architecture

The LinearCard architecture spans a Next.js App Router frontend, a NestJS API backend, Supabase PostgreSQL with application-level tenant isolation, and integrations with Google Wallet, WhatsApp, and external POS/PSP systems.

### System Data Flow Diagram
The complete lifecycle from consumer onboarding and QR scanning to transaction processing, tier evaluation, Google Wallet updates, and WhatsApp delivery:

![LinearCard Architecture Data Flow](architecture/data_flow_diagram.jpg)

### End-to-End Sequence Diagram
Detailed sequence of pass issuance, POS order verification, tier computation, Google Wallet class/object synchronization, and customer messaging:

![LinearCard Sequence Diagram](architecture/sequence_diagram.jpg)

### Core Activity Diagram
Step-by-step decision flow for member enrollment, order processing, tier progression, push campaigns, and data protection:

![LinearCard Activity Diagram](architecture/activity_diagram.jpg)

### Entity-Relationship Diagram (ERD)
Database schema showing relationships between Tenants, Programs, PassTemplates, Tiers, Passes, Members, Campaigns, Store Locations, and Audit Logs:

![LinearCard Entity-Relationship Diagram](architecture/entity_relationship_diagram.jpg)

---

## Getting Started

### Prerequisites
- **Node.js:** v18.0.0 or higher
- **npm:** v10.0.0 or higher (workspaces enabled)
- **Supabase:** Active Supabase project (URL and keys)
- **Google Cloud:** Service account with Google Wallet API access
- **ngrok:** Optional for local Google Wallet callback testing

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/dhyan2815/linearcard.git
   cd linearcard
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   - **Backend (`apps/api/.env` or root `.env`):**
     ```env
     # Supabase
     NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
     SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
     NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key

     # Auth & Cryptography
     JWT_SECRET=your-random-jwt-secret
     WALLET_CREDENTIALS_KEY=your-aes-key-for-tenant-wallet-creds

     # Google Wallet Defaults
     ISSUER_ID=your-google-wallet-issuer-id
     GOOGLE_CLIENT_EMAIL=wallet-service-account@project.iam.gserviceaccount.com
     GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

     # Local Development Public Tunnel (Required for local Wallet publish)
     PUBLIC_CALLBACK_URL=https://your-ngrok-domain.ngrok-free.app
     ```
   - **Frontend (`apps/web/.env`):**
     ```env
     API_ORIGIN=http://localhost:3001
     ```
   *(For preview deployments, Vercel system environment variables `VERCEL_ENV`, `VERCEL_URL`, and `VERCEL_BRANCH_URL` are automatically resolved for dynamic callback and API routing.)*

### Running the Development Environment

Run the backend and frontend in **two separate terminal windows** to keep log streams distinct and clear:

**Terminal 1 (Backend API):**
```bash
npm run dev:api
```
*Backend runs at `http://localhost:3001`.*

**Terminal 2 (Frontend Web App):**
```bash
npm run dev:web
```
*Frontend runs at `http://localhost:3000`.*

---

## Available NPM Scripts

- `npm run dev:api`  -  Builds `@linearcard/types`, then starts NestJS backend with watch mode on `localhost:3001`.
- `npm run dev:web`  -  Builds `@linearcard/types`, then starts Next.js App Router on `localhost:3000`.
- `npm run build`  -  Compiles all workspaces via Turborepo caching.
- `npm run lint`  -  Runs ESLint auto-fix across all workspaces.
- `npm run demo:reset`  -  Wipes demo tenant records specified in `DEMO_TENANT_IDS`.
- `npm run kill-ports`  -  Force-terminates orphaned processes on ports 3000 and 3001.

---

## Key Architectural Guidelines & Gotchas

1. **Application-Level Tenant Isolation:** The backend connects to Supabase using the service-role key which bypasses RLS. Every query must explicitly include `.eq('tenantId', tenantId)`. Never trust a `tenantId` passed in a request body or query parameter.
2. **Programs Own Resources:** Each program owns its templates, tier rows, store locations, custom WhatsApp templates, and enrollment slug.
3. **Pass Issuance Lifecycle:** Passes must always be created via `PassIssuanceService.issueForMember()`. Non-loyalty programs dynamically omit points and tier attributes.
4. **Google Wallet Save Links:** Save links expire in 3 hours. `GET /p/:id` dynamically mints a fresh token upon access - never cache save links.
5. **Resilient Side Effects:** Wallet pushes, WhatsApp dispatches, and outbound webhooks fire after the database write. Failures are logged in audit tables and do not rollback transactions.
6. **No Job Queue:** Campaign dispatches and pass resynchronizations run synchronously in-request for maximum serverless compatibility.

---

## Documentation & References

- **Project Guides:**
  - [CLAUDE.md](CLAUDE.md)  -  Claude Code developer reference and workflow rules
  - [GEMINI.md](GEMINI.md)  -  Persistent AI project memory and changelog
  - [AGENTS.md](AGENTS.md)  -  Next.js 16 breaking change guide and conventions
- **Deep-Dive Engineering Docs:**
  - [Common Patterns (`docs/PATTERNS.md`)](docs/PATTERNS.md)
  - [Multi-Tenant Isolation (`docs/MULTI_TENANT.md`)](docs/MULTI_TENANT.md)
  - [Edge Cases & Gotchas (`docs/EDGE_CASES.md`)](docs/EDGE_CASES.md)
  - [Webhooks & Callbacks (`docs/WEBHOOKS.md`)](docs/WEBHOOKS.md)
  - [Troubleshooting Guide (`docs/TROUBLESHOOTING.md`)](docs/TROUBLESHOOTING.md)
- **Product & Specifications:**
  - [LinearCard PRD (`docs/product/LinearCard_PRD_v1.md`)](docs/product/LinearCard_PRD_v1.md)
  - [Competitor Research (`docs/product/Competitor_Research_Report.md`)](docs/product/Competitor_Research_Report.md)

---

## License

MIT License.
