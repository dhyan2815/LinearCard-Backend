import type {
  BusinessCategory,
  EnrollmentField,
  ProgramKind,
  WalletType,
} from '../types';

/**
 * Phase 3.5 — the preset catalog (D9/D14).
 *
 * "Create Program" is always "pick a preset → rename": a preset carries the
 * program's kind, its loyalty economics (or its ticket fields), the pass
 * design, and — for loyalty — the tiers. Two of the four presets are *not*
 * loyalty programs: tickets have no points and no tiers, which is the whole
 * reason `kind` exists.
 *
 * Field keys are canonical (see POINTS_FIELD_KEYS / TIER_FIELD_KEYS in
 * wallet.service) so Google Wallet text-module updates bind correctly.
 */

export interface PresetColumn {
  key: string;
  header: string;
  body: string;
}

export interface PresetRow {
  id: string;
  columns: PresetColumn[];
}

export interface PresetTier {
  name: string;
  minPoints: number;
}

export interface ProgramPreset {
  id: string;
  name: string;
  kind: ProgramKind;
  /** Business categories allowed to create this preset (`test` allows all). */
  categories: BusinessCategory[];
  /** Stays 'generic' until the native builder is verified on a device (D11). */
  walletType: WalletType;
  archetype: string;
  description: string;
  hexBackgroundColor: string;
  fieldRows: PresetRow[];
  /** Loyalty only. Empty for ticket presets. */
  tiers: PresetTier[];
  /** Loyalty only. Undefined for ticket presets. */
  loyalty?: {
    earnRate: number;
    redeemRate: number;
    redeemCapPercent: number;
  };
  /**
   * Phase 6 — fields the member fills in at enrollment. Each `key` matches a
   * `fieldRows` column key whose body is the matching `{{token}}`, so the
   * captured value is what the pass actually shows. Presets without
   * per-member data (a coupon is the same offer for everyone) declare none.
   */
  enrollmentFields?: EnrollmentField[];
  /**
   * GAP-13 — a visit counter (one "point" per scan), not a bill-driven
   * program. The scanner locks the amount to 1 instead of trusting the
   * operator to type it.
   */
  visitMode?: boolean;
  /**
   * GAP-13 — fires a one-time "reward unlocked" notification/webhook the
   * first time balance reaches this value. Independent of tiers: a
   * tier-less visit program (stamp_card) still gets a milestone moment.
   * Never auto-redeems — redemption still goes through the normal flow.
   */
  rewardThreshold?: number;
  logoUrl?: string;
  heroUrl?: string;
}

export const PROGRAM_PRESETS: ProgramPreset[] = [
  {
    id: 'coffee_loyalty',
    name: 'Coffee Loyalty',
    kind: 'loyalty',
    categories: ['retail', 'food_beverage'],
    walletType: 'generic',
    archetype: 'loyalty',
    description: 'Points per rupee spent, three tiers, 50% redemption cap.',
    hexBackgroundColor: '#4B2E2B',
    fieldRows: [
      {
        id: 'row1',
        columns: [
          { key: 'points', header: 'Points', body: '0' },
          { key: 'tier', header: 'Tier', body: 'Bronze' },
        ],
      },
      {
        id: 'row2',
        columns: [{ key: 'memberId', header: 'Member', body: '—' }],
      },
    ],
    tiers: [
      { name: 'Bronze', minPoints: 0 },
      { name: 'Silver', minPoints: 100 },
      { name: 'Gold', minPoints: 500 },
    ],
    loyalty: { earnRate: 0.1, redeemRate: 1, redeemCapPercent: 50 },
    logoUrl:
      'https://images.unsplash.com/photo-1497935586351-b67a49e012bf?w=1000&auto=format&fit=crop&q=80',
    heroUrl:
      'https://images.unsplash.com/photo-1554118811-1e0d58224f24?w=1000&auto=format&fit=crop&q=80',
  },
  {
    id: 'gym_membership',
    name: 'Gym Membership',
    kind: 'loyalty',
    categories: ['salon_spa_fitness'],
    walletType: 'generic',
    archetype: 'membership',
    description:
      'Visit-based points, three tiers, membership expiry on the pass.',
    hexBackgroundColor: '#12303F',
    fieldRows: [
      {
        id: 'row1',
        columns: [
          { key: 'points', header: 'Visits', body: '0' },
          { key: 'tier', header: 'Tier', body: 'Starter' },
        ],
      },
      {
        id: 'row2',
        columns: [
          { key: 'memberId', header: 'Member', body: '—' },
          { key: 'membership_expires', header: 'Expires', body: '—' },
        ],
      },
    ],
    tiers: [
      { name: 'Starter', minPoints: 0 },
      { name: 'Regular', minPoints: 25 },
      { name: 'Elite', minPoints: 100 },
    ],
    // One "point" per visit: earnRate 1, and the scanner now locks amount=1
    // itself (GAP-13) instead of trusting the operator to type it.
    loyalty: { earnRate: 1, redeemRate: 1, redeemCapPercent: 0 },
    visitMode: true,
    logoUrl:
      'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=1000&auto=format&fit=crop&q=80',
    heroUrl:
      'https://images.unsplash.com/photo-1571019614242-c5c5dee9f50b?w=1000&auto=format&fit=crop&q=80',
  },
  {
    id: 'event_ticket',
    name: 'Event Tickets',
    kind: 'ticket',
    categories: ['events_entertainment'],
    walletType: 'generic',
    archetype: 'event_ticket',
    description:
      'Single-use ticket: seat, section and gate. The event date drives lock-screen relevance.',
    hexBackgroundColor: '#3B1E6E',
    fieldRows: [
      {
        id: 'row1',
        columns: [
          { key: 'seat', header: 'Seat', body: '{{seat}}' },
          { key: 'section', header: 'Section', body: '{{section}}' },
        ],
      },
      {
        id: 'row2',
        columns: [
          { key: 'gate', header: 'Gate', body: '{{gate}}' },
          { key: 'event_starts', header: 'Starts', body: '—' },
        ],
      },
    ],
    enrollmentFields: [
      { key: 'seat', label: 'Seat', type: 'text', required: true },
      { key: 'section', label: 'Section', type: 'text', required: true },
      { key: 'gate', label: 'Gate', type: 'text', required: false },
    ],
    tiers: [],
    logoUrl:
      'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=1000&auto=format&fit=crop&q=80',
    heroUrl:
      'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=1000&auto=format&fit=crop&q=80',
  },
  {
    id: 'travel_ticket',
    name: 'Travel Tickets',
    kind: 'ticket',
    categories: ['travel'],
    walletType: 'generic',
    archetype: 'transit_ticket',
    description:
      'Origin, destination and departure — a transit pass, not a loyalty card.',
    hexBackgroundColor: '#0B3D2E',
    fieldRows: [
      {
        id: 'row1',
        columns: [
          { key: 'origin', header: 'From', body: '{{origin}}' },
          { key: 'destination', header: 'To', body: '{{destination}}' },
        ],
      },
      {
        id: 'row2',
        columns: [
          { key: 'event_starts', header: 'Departs', body: '—' },
          { key: 'seat', header: 'Seat', body: '{{seat}}' },
        ],
      },
    ],
    enrollmentFields: [
      { key: 'origin', label: 'From', type: 'text', required: true },
      { key: 'destination', label: 'To', type: 'text', required: true },
      { key: 'seat', label: 'Seat', type: 'text', required: false },
    ],
    tiers: [],
    logoUrl:
      'https://images.unsplash.com/photo-1436491865332-7a61a109cc05?w=1000&auto=format&fit=crop&q=80',
    heroUrl:
      'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTzN-jFx_6Gr2VzxPYFkXT-BS-Lnvkz5BoFk9dDA51Dj2HDTUMK0lHdx7Y&s=10',
  },
  {
    id: 'modern_membership',
    name: 'Modern membership',
    kind: 'loyalty',
    categories: ['salon_spa_fitness', 'professional_services'],
    walletType: 'generic',
    archetype: 'membership',
    description:
      'A plain membership card: member id and renewal date, no points maths.',
    hexBackgroundColor: '#1F2933',
    fieldRows: [
      {
        id: 'row1',
        columns: [
          { key: 'memberId', header: 'Member', body: '—' },
          { key: 'membership_expires', header: 'Renews', body: '—' },
        ],
      },
    ],
    tiers: [],
    loyalty: { earnRate: 0, redeemRate: 1, redeemCapPercent: 0 },
    logoUrl:
      'https://images.unsplash.com/photo-1491336477066-31156b5e4f35?w=1000&auto=format&fit=crop&q=80',
    heroUrl:
      'https://images.unsplash.com/photo-1511632765486-a01980e01a18?w=1000&auto=format&fit=crop&q=80',
  },
  {
    id: 'tiered_membership',
    name: 'Tiered membership',
    kind: 'loyalty',
    categories: ['salon_spa_fitness', 'professional_services'],
    walletType: 'generic',
    archetype: 'membership',
    description:
      'Four tiers earned on spend, with the current tier shown on the pass.',
    hexBackgroundColor: '#2D1B4E',
    fieldRows: [
      {
        id: 'row1',
        columns: [
          { key: 'points', header: 'Points', body: '0' },
          { key: 'tier', header: 'Tier', body: 'Member' },
        ],
      },
      {
        id: 'row2',
        columns: [{ key: 'memberId', header: 'Member', body: '—' }],
      },
    ],
    tiers: [
      { name: 'Member', minPoints: 0 },
      { name: 'Silver', minPoints: 250 },
      { name: 'Gold', minPoints: 1000 },
      { name: 'Platinum', minPoints: 5000 },
    ],
    loyalty: { earnRate: 0.1, redeemRate: 1, redeemCapPercent: 50 },
    logoUrl:
      'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=1000&auto=format&fit=crop&q=80',
    heroUrl:
      'https://images.unsplash.com/photo-1589829085413-56de8ae18c73?w=1000&auto=format&fit=crop&q=80',
  },
  {
    id: 'loyalty_offer',
    name: 'Loyalty offer',
    kind: 'loyalty',
    categories: ['retail', 'food_beverage'],
    walletType: 'generic',
    archetype: 'loyalty',
    description:
      'A running offer on a loyalty card — points plus the current reward.',
    hexBackgroundColor: '#7A2E1D',
    fieldRows: [
      {
        id: 'row1',
        columns: [
          { key: 'points', header: 'Points', body: '0' },
          { key: 'reward', header: 'Reward', body: '—' },
        ],
      },
    ],
    tiers: [{ name: 'Member', minPoints: 0 }],
    loyalty: { earnRate: 0.1, redeemRate: 1, redeemCapPercent: 100 },
    logoUrl:
      'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=1000&auto=format&fit=crop&q=80',
    heroUrl:
      'https://images.unsplash.com/photo-1472851294608-062f824d29cc?w=1000&auto=format&fit=crop&q=80',
  },
  {
    id: 'business_card',
    name: 'Business card',
    kind: 'loyalty',
    categories: ['professional_services'],
    walletType: 'generic',
    archetype: 'id_card',
    description:
      'Name, role and contact — an identity card with nothing to earn.',
    hexBackgroundColor: '#111827',
    fieldRows: [
      {
        id: 'row1',
        columns: [
          { key: 'role', header: 'Role', body: '—' },
          { key: 'memberId', header: 'ID', body: '—' },
        ],
      },
    ],
    tiers: [],
    loyalty: { earnRate: 0, redeemRate: 1, redeemCapPercent: 0 },
    logoUrl:
      'https://images.unsplash.com/photo-1521737604893-d14cc237f11d?w=1000&auto=format&fit=crop&q=80',
    heroUrl:
      'https://images.unsplash.com/photo-1554774853-719586f82d77?w=1000&auto=format&fit=crop&q=80',
  },
  {
    id: 'gift_card',
    name: 'Gift card',
    kind: 'giftcard',
    categories: ['retail', 'food_beverage'],
    walletType: 'generic',
    archetype: 'loyalty',
    description: 'A stored balance spent down to zero: one point is one rupee.',
    hexBackgroundColor: '#14532D',
    fieldRows: [
      {
        id: 'row1',
        columns: [
          { key: 'points', header: 'Balance', body: '0' },
          { key: 'memberId', header: 'Card', body: '—' },
        ],
      },
    ],
    tiers: [{ name: 'Member', minPoints: 0 }],
    // Nothing is earned on a gift card; the whole balance is spendable.
    loyalty: { earnRate: 0, redeemRate: 1, redeemCapPercent: 100 },
    logoUrl:
      'https://images.unsplash.com/photo-1549465220-1a8b9238cd48?w=1000&auto=format&fit=crop&q=80',
    heroUrl:
      'https://images.unsplash.com/photo-1513201099705-a9746e1e201f?w=1000&auto=format&fit=crop&q=80',
  },
  {
    id: 'single_use_coupon',
    name: 'Single-use coupon',
    kind: 'coupon',
    categories: ['retail', 'food_beverage', 'professional_services'],
    walletType: 'generic',
    archetype: 'loyalty',
    description: 'One redemption, then the coupon is spent. No tiers.',
    hexBackgroundColor: '#9A3412',
    fieldRows: [
      {
        id: 'row1',
        columns: [
          { key: 'reward', header: 'Offer', body: '—' },
          { key: 'expires', header: 'Expires', body: '—' },
        ],
      },
    ],
    tiers: [],
    loyalty: { earnRate: 0, redeemRate: 1, redeemCapPercent: 100 },
    logoUrl:
      'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=1000&auto=format&fit=crop&q=80',
    heroUrl:
      'https://images.unsplash.com/photo-1607083206968-13611e3d76db?w=1000&auto=format&fit=crop&q=80',
  },
  {
    id: 'stamp_card',
    name: 'Stamp card',
    kind: 'loyalty',
    categories: ['food_beverage', 'salon_spa_fitness'],
    walletType: 'generic',
    archetype: 'loyalty',
    description: 'Ten stamps, one free — a stamp is a point, the tenth resets.',
    hexBackgroundColor: '#5B3A1E',
    fieldRows: [
      {
        id: 'row1',
        columns: [
          { key: 'points', header: 'Stamps', body: '0' },
          { key: 'reward', header: 'Next reward', body: '10 stamps' },
        ],
      },
    ],
    tiers: [{ name: 'Member', minPoints: 0 }],
    // One stamp per visit: the scanner locks amount=1 (GAP-13).
    loyalty: { earnRate: 1, redeemRate: 1, redeemCapPercent: 100 },
    visitMode: true,
    // No tier ladder exists to fire a milestone message, so the reward
    // threshold fires it directly (GAP-13) — still no auto-redeem.
    rewardThreshold: 10,
    logoUrl:
      'https://images.unsplash.com/photo-1559525839-b184a4d698c7?w=1000&auto=format&fit=crop&q=80',
    heroUrl:
      'https://images.unsplash.com/photo-1472851294608-062f824d29cc?w=1000&auto=format&fit=crop&q=80',
  },
  {
    id: 'access_pass',
    name: 'Access pass',
    kind: 'ticket',
    categories: ['events_entertainment', 'professional_services'],
    walletType: 'generic',
    archetype: 'event_ticket',
    description:
      'Venue or site access for a dated window — zone and gate, no points.',
    hexBackgroundColor: '#1E3A5F',
    fieldRows: [
      {
        id: 'row1',
        columns: [
          { key: 'section', header: 'Zone', body: '—' },
          { key: 'gate', header: 'Gate', body: '—' },
        ],
      },
      {
        id: 'row2',
        columns: [{ key: 'event_starts', header: 'Valid from', body: '—' }],
      },
    ],
    tiers: [],
    logoUrl:
      'https://images.unsplash.com/photo-1436491865332-7a61a109cc05?w=1000&auto=format&fit=crop&q=80',
    heroUrl:
      'https://images.unsplash.com/photo-1531058020387-3be344556be6?w=1000&auto=format&fit=crop&q=80',
  },
  {
    id: 'student_id',
    name: 'Student ID',
    kind: 'studentid',
    categories: ['education'],
    walletType: 'generic',
    archetype: 'id_card',
    description:
      'Student ID, institution and validity — scanned to verify, nothing to earn.',
    hexBackgroundColor: '#1E3A8A',
    fieldRows: [
      {
        id: 'row1',
        columns: [
          { key: 'student_id', header: 'Student ID', body: '{{student_id}}' },
          {
            key: 'institution',
            header: 'Institution',
            body: '{{institution}}',
          },
        ],
      },
      {
        id: 'row2',
        columns: [
          {
            key: 'valid_until',
            header: 'Valid until',
            body: '{{valid_until}}',
          },
        ],
      },
    ],
    enrollmentFields: [
      { key: 'student_id', label: 'Student ID', type: 'text', required: true },
      {
        key: 'institution',
        label: 'Department / Institution',
        type: 'text',
        required: true,
      },
      {
        key: 'valid_until',
        label: 'Valid until',
        type: 'date',
        required: false,
      },
    ],
    tiers: [],
    logoUrl:
      'https://images.unsplash.com/photo-1523050854058-8df90110c9f1?w=1000&auto=format&fit=crop&q=80',
    heroUrl:
      'https://images.unsplash.com/photo-1541339907198-e08756dedf3f?w=1000&auto=format&fit=crop&q=80',
  },
];

export function findPreset(id?: string): ProgramPreset | undefined {
  return PROGRAM_PRESETS.find((p) => p.id === id);
}

/**
 * Presets a tenant may create. `null` is a legacy tenant that has not picked
 * a category yet, and `test` is internal — both see everything.
 */
export function presetsForCategory(
  category: BusinessCategory | null | undefined,
): ProgramPreset[] {
  if (!category || category === 'test') return PROGRAM_PRESETS;
  return PROGRAM_PRESETS.filter((p) => p.categories.includes(category));
}

/**
 * Slug used in enrollment URLs and Google Wallet class ids. Mirrors the
 * `linearcard_slugify` SQL function used by the Phase 3 backfill so a slug
 * generated here and one generated there are the same string.
 */
export function slugify(text: string): string {
  const slug = (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'program';
}

export const DEFAULT_PASS_HEX = '#1A365D';

export const SELECTABLE_BUSINESS_CATEGORIES: ReadonlyArray<BusinessCategory> = [
  'retail',
  'food_beverage',
  'salon_spa_fitness',
  'events_entertainment',
  'travel',
  'education',
  'professional_services',
];

/** True for a category a tenant may pick itself (signup, settings). */
export function isSelectableCategory(
  value: unknown,
): value is BusinessCategory {
  return (
    typeof value === 'string' &&
    (SELECTABLE_BUSINESS_CATEGORIES as readonly string[]).includes(value)
  );
}
