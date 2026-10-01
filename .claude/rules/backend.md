# Backend Rules

NestJS 10 + Supabase, TypeScript. Auto-reload via `nest start --watch`.

## Commands

From repo root:

- `npm run dev:api` — builds `packages/types`, then runs the API on 3001 with watch. Own terminal; there is no combined `npm run dev`.
- `npm run demo:reset` — wipes demo tenants (`scripts/demo-reset.ts`, scoped by `DEMO_TENANT_IDS`).

From `apps/api/`:

- `npm run test` — Jest, all `*.spec.ts` under `src/` (unit + `phase0…phase8.spec.ts` regression suites).
- `npm run test:watch` — watch mode.
- `npm run test -- wallet.service.spec.ts` — one file.
- `npm run test:cov` — coverage (`coverage/`).
- `npm run test:e2e` — `test/jest-e2e.json`. Currently a single smoke test (`GET /` → `LinearCard Backend Working!`); it does **not** test tenant isolation.
- `npm run lint` — ESLint `--fix`. `npm run format` — Prettier.
- `npm run waha` — WAHA CLI helper (`scripts/waha-cli.ts`).

## Modules (`apps/api/src/`)

| Dir | Routes | Purpose |
|---|---|---|
| `auth/` | `/auth/*` | Member OTP (`send-otp`, `verify-otp`), admin OTP login, self-serve `admin/signup` (demo mode), `me`, `admin/logout`. `TenantGuard` lives here. |
| `programs/` | `/programs/*` | Program CRUD from presets, tiers, publish, delete, `sync-locations`, per-program `overview`, `members`, `events`. |
| `templates/` | `/templates/*` | PassTemplate CRUD, publish (creates/patches Google Wallet class), `wallet-class`, `preview-pass`, `resync-passes`. |
| `passes/` | `/passes/*`, `/p/:id` | Issuance (`pass-issuance.service.ts`), `process-order`, `validate-pass`, `update-pass`, scan history, promo messages, external POS webhook, Google Wallet callback. `/p/:id` = public pass link that mints a fresh save URL. |
| `members/` | `/members/*` | CRM list/detail, test-account flag, DPDP export/erase, `adjust-balance`. |
| `campaigns/` | `/campaigns/*` | Send-now campaigns: `preview` (dry run), `POST /` (send), list, detail. |
| `payments/` | `/webhooks/payment/:tenantId`, `/payments/*` | PSP webhook (HMAC), webhook config, simulator. |
| `developers/` | `/developers/*` | Hashed API keys, outbound webhook endpoints (CRUD + test event). |
| `notifications/` | `/notifications/*` | Notification log, inbound WhatsApp STOP/START. |
| `notification/` | — | `WhatsappService` (templated sends + logging), `WhatsappProvider` (WAHA HTTP), `NotifyService`, `OtpService`. |
| `wallet/` | — | `WalletService` (Google Wallet REST + JWT save links), `google-jws.ts` (callback signature verification). |
| `tiers/` | — | `computeTier()` pure function. |
| `tenant/`, `settings/` | `/tenant/*`, `/settings`, `/admin/developer-settings` | Tenant lookup by slug, business details, production approval, tenant settings. |
| `dashboard/` | `/dashboard/stats` | Tenant stats. |
| `audit/`, `supabase/` | — | `AuditService`, `SupabaseService`. |

Root files: `env.ts` (env loading, boot checks, `encryptSecret`/`decryptSecret`), `idempotency.interceptor.ts`, `errors.ts` (`ServiceError`).

## Patterns

### Business category & wallet type

- `Tenant.businessCategory` (nullable, `null`/`'test'` = unrestricted) gates which presets `presetsForCategory()` returns and which a tenant may `POST /programs` with — enforced server-side (403 on mismatch), never trusted from the request body.
- `Program.walletType` (`generic | loyalty | giftCard | offer | eventTicket`) is copied from the preset at creation and never changes afterwards (Google requires an object's `classId` to match its class's type). Every preset currently resolves to `'generic'` regardless of the "final" type documented in `plans/BUSINESS_CATEGORY_WALLET_TYPES_PLAN.md` — native builders exist (`apps/api/src/wallet/wallet-types.ts`) but are gated behind a live-device verification step per type before their preset switches over.
- `ProgramKind` is `loyalty | ticket | giftcard | coupon | studentid`. `studentid` behaves like `ticket` everywhere in the transaction pipeline (validate-only); `giftcard` is money, not points: `load` credits face value (`award` is rewritten to `load`, `earnRate` ignored) and `redeem` spends it; `load` on any other kind is a 400. `coupon` runs through the loyalty award/redeem path and is born at balance 0, so it cannot be redeemed yet (`docs/PRESET_CATEGORY_MATRIX.md`).

### Tenant scoping (critical)

Columns are **camelCase** (`tenantId`, `programId`, `memberId`). Every query uses the service-role client and must filter explicitly:

```typescript
// ✓ Correct
const { data } = await this.supabaseService.client
  .from('Member')
  .select('*')
  .eq('tenantId', req.tenantId);

// ✗ Wrong — service role bypasses RLS, returns every tenant's rows
const { data } = await this.supabaseService.client.from('Member').select('*');
```

Guarded routes get `req.tenantId` from `TenantGuard` (`@UseGuards(TenantGuard)`), typed as `TenantRequest`. Never trust a `tenantId` in the body/query — see `docs/MULTI_TENANT.md`.

### Google Wallet

```typescript
const wallet = await this.walletService.forTenant(tenantId); // per-tenant creds, env fallback
await wallet.updateGenericObject(passId, { balance, tier /* … */ });
```

- Balance changes go through `walletService.processOrderTransaction()` → `syncPassAfterTransaction()` (tier recompute, Wallet push, WhatsApp, webhooks).
- Wallet/WhatsApp/webhook failures are logged and **never roll back the DB**.
- Class ids are built only by `resolveClassId()`: `${issuerId}.${envPrefix}_${classSuffix}`.

### Pass issuance

`PassIssuanceService.issueForMember()` is the single issuance path (enroll, payments, generate-pass). It reuses an existing pass for the member+program, picks the entry tier, and only writes tier/points fields when the program has `Tier` rows ("tier concept"). Tier-less programs (tickets, business card, coupon, modern membership) get no `subheader` and a plain barcode caption.

### Outbound webhooks

```typescript
this.webhookService.dispatch(tenantId, 'points.awarded', payload, programId).catch(() => {});
```

Fire-and-forget. Events: `pass.installed`, `pass.deleted`, `points.awarded`, `points.redeemed`, `tier.changed`, `member.enrolled`.

### RLS client (available, unused)

`SupabaseService.forTenant(tenantId)` returns an anon-key client with a 1h `authenticated` JWT so RLS applies. No service uses it yet. Keep explicit `tenantId` filters either way.

## Audit Trail

- `AuditLog` — via `AuditService.record()`: pass installs/deletes, balance changes, admin actions.
- `ConsentLog` — consent grants and WhatsApp STOP withdrawals.
- `NotificationLog` — every WhatsApp/wallet message, with `campaignId` for campaign sends.
- `WebhookDelivery` — every outbound webhook attempt.

## Security

- OTP: 4-digit, 5-minute expiry, stored SHA-256 hashed, timing-safe compare. 5 wrong guesses lock the session. Burst limit → wait 5 minutes. **No dev bypass.**
- Admin sessions: JWT in httpOnly `admin_session` cookie (1 day) or `Authorization: Bearer`.
- API keys: SHA-256 hashed in `ApiKey`; legacy plaintext `Tenant.apiKey` still accepted as fallback.
- No notification quota. Marketing sends gated by consent + `Member.marketingOptOutAt`.
