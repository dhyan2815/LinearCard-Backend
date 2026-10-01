export const DEFAULT_PASS_HEX = '#1A365D';

export interface User {
  id: string;
  email: string;
}

export interface SendOtpRequest {
  phone: string;
  tenantId?: string;
  programId?: string;
}

export interface VerifyOtpRequest {
  phone: string;
  otp: string;
  consentGiven: boolean;
  tenantId?: string;
  /** Program the pass is issued against (Phase 3.6). */
  programId?: string;
  memberName?: string;
  /**
   * Phase 6 — answers to the program's `enrollmentFields`, keyed by field
   * key. Validated server-side against what the program declared; anything
   * undeclared is dropped.
   */
  enrollmentFields?: Record<string, string>;
}

export interface GeneratePassRequest {
  phone: string;
  memberName?: string;
  tier?: string;
  balance?: string;
  tenantId?: string;
}

export interface Tenant {
  id: string;
  name: string;
  classSuffix: string;
  brandHexColor: string;
  logoUrl?: string;
  heroUrl?: string;
  apiKey?: string;
  webhookUrl?: string;
  /** Null = legacy tenant that has not picked one yet (unrestricted). */
  businessCategory?: BusinessCategory | null;
}

/**
 * Decides which program presets a tenant may create. `test` allows every
 * preset and is never offered in a picker.
 */
export type BusinessCategory =
  | 'retail'
  | 'food_beverage'
  | 'salon_spa_fitness'
  | 'events_entertainment'
  | 'travel'
  | 'education'
  | 'professional_services'
  | 'test';

export const BUSINESS_CATEGORIES: ReadonlyArray<{
  id: BusinessCategory;
  label: string;
  selectable: boolean;
}> = [
  { id: 'retail', label: 'Retail', selectable: true },
  { id: 'food_beverage', label: 'Food & Beverage', selectable: true },
  { id: 'salon_spa_fitness', label: 'Salon / Spa / Fitness & Gym', selectable: true },
  { id: 'events_entertainment', label: 'Events / Entertainment', selectable: true },
  { id: 'travel', label: 'Travel', selectable: true },
  { id: 'education', label: 'Education', selectable: true },
  { id: 'professional_services', label: 'Professional Services / Coworking', selectable: true },
  { id: 'test', label: 'Test (internal)', selectable: false },
];

/** True for a category a tenant may pick itself (signup, settings). */
export function isSelectableCategory(value: unknown): value is BusinessCategory {
  return BUSINESS_CATEGORIES.some((c) => c.selectable && c.id === value);
}

/** Google Wallet class/object resource a program's passes use. Fixed at creation. */
export type WalletType = 'generic' | 'loyalty' | 'giftCard' | 'offer' | 'eventTicket';

export interface Admin {
  id: string;
  phone: string;
  name: string;
  tenantId: string;
  role: string;
  createdAt?: string;
}

export interface Pass {
  id: string;
  fullPassId: string;
  tier: string;
  balance: string | number;
  /** Which program this pass belongs to (Phase 3.1). */
  programId?: string | null;
}

export interface Member {
  id: string;
  phone: string;
  name?: string;
  tenantId: string;
  createdAt?: string;
  passes?: Pass[];
  /** Demo-mode issuance gate: only test accounts get passes while the tenant is in demo. */
  isTestAccount?: boolean;
  /** Set when the member replies STOP. Every campaign send filters on it. */
  marketingOptOutAt?: string | null;
  /** DPDP erasure tombstone (7.6). Set when the member's data was anonymised. */
  erasedAt?: string | null;
}

/**
 * D9/D14. Ticket programs have no points and no tiers: the designer hides
 * the tier editor for them and the scan pipeline skips them entirely.
 * `studentid` behaves like `ticket`; `giftcard` is redeem-only (no tiers);
 * `coupon` is a single full redemption.
 */
export type ProgramKind = 'loyalty' | 'ticket' | 'giftcard' | 'coupon' | 'studentid';

/**
 * Phase 6 — a field the member fills in during enrollment, so a ticket or a
 * student ID carries that member's own seat / roll number instead of the
 * template's static placeholder.
 *
 * `key` matches a template field-row column key, so the captured value both
 * lands in `Pass.customAttributes` and resolves the `{{key}}` token the
 * preset's column body carries.
 */
export interface EnrollmentField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date';
  required: boolean;
}

export interface Program {
  id: string;
  tenantId: string;
  name: string;
  kind: ProgramKind;
  /** Existing programs are all 'generic' (D1). */
  walletType: WalletType;
  archetype: string;
  status: 'draft' | 'published' | 'archived';
  /** Second segment of /enroll/:tenantSlug/:programSlug. Unique per tenant. */
  enrollmentSlug?: string | null;
  /** Loyalty economics — moved here off PassTemplate in Phase 3.1. */
  earnRate?: number | null;
  redeemRate?: number | null;
  redeemCapPercent?: number | null;
  /** Ticket-only. */
  eventStartsAt?: string | null;
  eventEndsAt?: string | null;
  venueName?: string | null;
  /** Phase 8 — WhatsApp message sent on enrollment. Empty means none. */
  welcomeMessage?: string | null;
  /** Phase 8 - Customizable WhatsApp Templates */
  whatsappTemplates?: Record<string, string>;
  retentionDays?: number | null;
  storeLocations?: any[];
  /** Phase 6 — captured per member at enrollment. Empty/null means none. */
  enrollmentFields?: EnrollmentField[] | null;
  createdAt?: string;
  updatedAt?: string;
}

/** Phase 8 — program Overview tab (Upgraded to Business Metrics). */
export interface ProgramOverview {
  totalRevenue: number;
  totalOrders: number;
  pointsAwarded: number;
  pointsRedeemed: number;
  series: Array<{
    bucket: string;
    revenue: number;
    orders: number;
    pointsAwarded: number;
    pointsRedeemed: number;
  }>;
  /** Event recording began here; the chart labels this rather than implying zero. */
  historyStartsAt: string | null;
}

/** Phase 8 — program Member Events feed. */
export interface ProgramMemberEvent {
  id: string;
  memberId: string;
  memberName?: string | null;
  phone?: string | null;
  action: string;
  actor: string;
  occurredAt: string;
}

/**
 * Tier input as the designer sends it — no row identity yet. `PATCH
 * /programs/:id/tiers` replaces the program's tiers with these.
 */
export interface TierInput {
  name: string;
  minPoints: number;
  templateId?: string | null;
}

export interface Tier {
  id: string;
  programId: string;
  name: string;
  minPoints: number;
  templateId: string;
  sortOrder: number;
  createdAt?: string;
}

/**
 * Phase 2.2 — campaign audience segmentation. Every field is optional and
 * every set field narrows; an empty filter means "all members" (minus
 * marketing opt-outs, which are never a choice).
 */
export interface AudienceFilter {
  /** Program scope (D8). Inert until Phase 3 puts `programId` on `Pass`. */
  programId?: string;
  /** Exact tier names, e.g. ['Gold', 'Platinum']. */
  tiers?: string[];
  balanceMin?: number;
  balanceMax?: number;
  /** No AuditLog activity in this many days. */
  inactiveForDays?: number;
  /** Restrict to members flagged `isTestAccount` (demo-mode dry runs). */
  testAccountsOnly?: boolean;
}

export interface Campaign {
  id: string;
  tenantId: string;
  programId?: string | null;
  name: string;
  channel: 'whatsapp' | 'wallet_push';
  /** Required for wallet_push — Google Wallet's addMessage needs a header. */
  header?: string | null;
  body: string;
  audienceFilter: AudienceFilter;
  status: 'draft' | 'sending' | 'sent' | 'failed';
  sentAt?: string | null;
  recipientCount: number;
  sentCount: number;
  failedCount: number;
  createdAt?: string;
}

export interface CampaignRecipientPreview {
  id: string;
  name?: string;
  phone: string;
  tier?: string;
  balance?: string | number;
}

export interface CampaignPreviewResponse {
  success: boolean;
  recipientCount: number;
  /** First 5 recipients, so a send is never fired blind. */
  sample: CampaignRecipientPreview[];
  renderedHeader?: string;
  renderedBody: string;
  /** Members excluded purely because they opted out of marketing. */
  optedOutCount: number;
}

export interface PassTemplate {
  id: string;
  tenantId: string;
  /** Owning program (Phase 3.1, DB-5). */
  programId?: string | null;
  title: string;
  name?: string;
  subtitle?: string;
  archetype: string;
  status: 'draft' | 'published' | 'unsaved';
  classSuffix: string;
  googleClassId?: string;
  /** Live Google Wallet class id per environment prefix, e.g. { prod, preview, dev }. */
  googleClassIds?: Record<string, string>;
  fieldRows?: Array<{ id: string; columns: Array<{ key: string; header: string; body: string }> }>;
  hexBackgroundColor?: string;
  logoUrl?: string;
  heroImageUrl?: string;
  /**
   * Loyalty economics. `Program` owns these post Phase 3.1; the template
   * columns remain as the fallback for templates with no program.
   */
  earnRate?: number;
  redeemRate?: number;
  redeemCapPercent?: number;
  createdAt?: string;
  updatedAt?: string;
}


/**
 * Phase 5.1 — a payment event after PSP-specific shape is normalized away.
 * Deliberately narrow: no PAN, no VPA, no card token ever enters LinearCard.
 */
export interface NormalizedPayment {
  /** E.164-ish: digits with an optional leading '+'. */
  phone: string;
  /** Minor unit (paise), so money never rides on a float. */
  amountMinor: number;
  currency: string;
  merchantRef: string | null;
  occurredAt: string;
  /** Replay protection — unique per tenant. */
  nonce: string;
  /** Epoch ms; must be within the signing tolerance. */
  timestamp: number;
}

export interface PaymentWebhookResult {
  success: boolean;
  /** True when this payment created the member's pass. */
  enrolled: boolean;
  memberId: string;
  passId: string;
  programId: string | null;
  pointsAwarded: number;
  newBalance: number;
  tier: string;
  tierChanged: boolean;
}
