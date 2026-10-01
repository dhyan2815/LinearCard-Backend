import type { WalletType } from '../types';

/**
 * Phase 2 — per-`WalletType` REST resource names (plan Section 4.3).
 *
 * `generic` is the only type every existing call site already builds a
 * correct payload for; the others are looked up here so a caller can
 * request the right class/object endpoint and save-link JWT key without
 * hardcoding `genericClass` / `genericObject` / `genericObjects`.
 */
export interface WalletTypeResources {
  classResource: string;
  objectResource: string;
  saveKey: string;
}

export const WALLET_TYPE_RESOURCES: Record<WalletType, WalletTypeResources> = {
  generic: {
    classResource: 'genericClass',
    objectResource: 'genericObject',
    saveKey: 'genericObjects',
  },
  loyalty: {
    classResource: 'loyaltyClass',
    objectResource: 'loyaltyObject',
    saveKey: 'loyaltyObjects',
  },
  giftCard: {
    classResource: 'giftCardClass',
    objectResource: 'giftCardObject',
    saveKey: 'giftCardObjects',
  },
  offer: {
    classResource: 'offerClass',
    objectResource: 'offerObject',
    saveKey: 'offerObjects',
  },
  eventTicket: {
    classResource: 'eventTicketClass',
    objectResource: 'eventTicketObject',
    saveKey: 'eventTicketObjects',
  },
};

export function walletResources(
  walletType: WalletType = 'generic',
): WalletTypeResources {
  return WALLET_TYPE_RESOURCES[walletType] || WALLET_TYPE_RESOURCES.generic;
}

/** Google Wallet `Money`: integer micros, never a float rupee amount. */
export function toMoney(amountRupees: number, currencyCode = 'INR') {
  return { micros: Math.round(amountRupees * 1_000_000), currencyCode };
}

export interface GiftCardClassInput {
  classId: string;
  merchantName: string;
  programLogoUrl?: string;
  heroImageUrl?: string;
  hexBackgroundColor?: string;
  merchantLocations?: {
    latitude: number | string;
    longitude: number | string;
  }[];
  callbackUrl: string;
}

/** giftCardClass payload (plan 4.5 / Phase 2 gift-card builders). */
export function buildGiftCardClassPayload(input: GiftCardClassInput): any {
  const payload: any = {
    id: input.classId,
    issuerName: input.merchantName,
    reviewStatus: 'UNDER_REVIEW',
    merchantName: input.merchantName,
    hexBackgroundColor: input.hexBackgroundColor,
    callbackOptions: { url: input.callbackUrl },
  };
  if (input.programLogoUrl) {
    payload.programLogo = { sourceUri: { uri: input.programLogoUrl } };
  }
  if (input.heroImageUrl) {
    payload.heroImage = { sourceUri: { uri: input.heroImageUrl } };
  }
  if (input.merchantLocations?.length) {
    payload.merchantLocations = input.merchantLocations
      .slice(0, 10)
      .map((l) => ({
        latitude: Number(l.latitude),
        longitude: Number(l.longitude),
      }));
  }
  return payload;
}

export interface GiftCardObjectInput {
  objectId: string;
  classId: string;
  /** Card number shown/scanned — derived from the passId, never the phone. */
  cardNumber: string;
  balanceRupees: number;
  barcodeValue: string;
  barcodeAltText?: string;
  textModulesData?: { id: string; header: string; body: string }[];
}

/** giftCardObject payload. `balance` is `Money`, never a "X Pts" string. */
export function buildGiftCardObjectPayload(input: GiftCardObjectInput): any {
  return {
    id: input.objectId,
    classId: input.classId,
    state: 'ACTIVE',
    cardNumber: input.cardNumber,
    balance: toMoney(input.balanceRupees),
    balanceUpdateTime: new Date().toISOString(),
    barcode: {
      type: 'QR_CODE',
      value: input.barcodeValue,
      alternateText: input.barcodeAltText || ' ',
    },
    textModulesData: input.textModulesData || [],
  };
}

/** Phase 3.1 — offerClass (`single_use_coupon`). */
export interface OfferClassInput {
  classId: string;
  title: string;
  provider: string;
  redemptionChannel?:
    'INSTORE' | 'ONLINE' | 'BOTH' | 'TEMPORARY_PRICE_REDUCTION';
  details?: string;
  finePrint?: string;
  titleImageUrl?: string;
  hexBackgroundColor?: string;
  callbackUrl: string;
}

export function buildOfferClassPayload(input: OfferClassInput): any {
  const payload: any = {
    id: input.classId,
    issuerName: input.provider,
    reviewStatus: 'UNDER_REVIEW',
    title: input.title,
    provider: input.provider,
    redemptionChannel: input.redemptionChannel || 'INSTORE',
    hexBackgroundColor: input.hexBackgroundColor,
    callbackOptions: { url: input.callbackUrl },
  };
  if (input.details) payload.details = input.details;
  if (input.finePrint) payload.finePrint = input.finePrint;
  if (input.titleImageUrl) {
    payload.titleImage = { sourceUri: { uri: input.titleImageUrl } };
  }
  return payload;
}

/** offerObject — `state` flips to `COMPLETED` on full redemption; never re-activated. */
export interface OfferObjectInput {
  objectId: string;
  classId: string;
  state?: 'ACTIVE' | 'COMPLETED';
  barcodeValue: string;
  barcodeAltText?: string;
  textModulesData?: { id: string; header: string; body: string }[];
}

export function buildOfferObjectPayload(input: OfferObjectInput): any {
  return {
    id: input.objectId,
    classId: input.classId,
    state: input.state || 'ACTIVE',
    barcode: {
      type: 'QR_CODE',
      value: input.barcodeValue,
      alternateText: input.barcodeAltText || ' ',
    },
    textModulesData: input.textModulesData || [],
  };
}

/** Phase 3.2 — eventTicketClass (`event_ticket`, `access_pass`). */
export interface EventTicketClassInput {
  classId: string;
  eventName: string;
  issuerName: string;
  venueName?: string;
  /** ISO 8601. Required before publish — enforced by the caller. */
  startDateTime?: string;
  endDateTime?: string;
  logoUrl?: string;
  heroImageUrl?: string;
  hexBackgroundColor?: string;
  callbackUrl: string;
}

const localized = (value?: string) =>
  value ? { defaultValue: { language: 'en-US', value } } : undefined;

export function buildEventTicketClassPayload(
  input: EventTicketClassInput,
): any {
  const payload: any = {
    id: input.classId,
    issuerName: input.issuerName,
    reviewStatus: 'UNDER_REVIEW',
    eventName: localized(input.eventName),
    hexBackgroundColor: input.hexBackgroundColor,
    callbackOptions: { url: input.callbackUrl },
  };
  if (input.venueName) {
    payload.venue = { name: localized(input.venueName) };
  }
  if (input.startDateTime || input.endDateTime) {
    payload.dateTime = {
      ...(input.startDateTime ? { start: input.startDateTime } : {}),
      ...(input.endDateTime ? { end: input.endDateTime } : {}),
    };
  }
  if (input.logoUrl) payload.logo = { sourceUri: { uri: input.logoUrl } };
  if (input.heroImageUrl) {
    payload.heroImage = { sourceUri: { uri: input.heroImageUrl } };
  }
  return payload;
}

/** eventTicketObject. `seatInfo` fields are omitted (not `''`) when unset. */
export interface EventTicketObjectInput {
  objectId: string;
  classId: string;
  ticketHolderName?: string;
  seat?: string;
  row?: string;
  section?: string;
  gate?: string;
  barcodeValue: string;
  barcodeAltText?: string;
  textModulesData?: { id: string; header: string; body: string }[];
}

export function buildEventTicketObjectPayload(
  input: EventTicketObjectInput,
): any {
  const payload: any = {
    id: input.objectId,
    classId: input.classId,
    state: 'ACTIVE',
    barcode: {
      type: 'QR_CODE',
      value: input.barcodeValue,
      alternateText: input.barcodeAltText || ' ',
    },
    textModulesData: input.textModulesData || [],
  };
  if (input.ticketHolderName) payload.ticketHolderName = input.ticketHolderName;
  const seatInfo: any = {};
  if (input.seat) seatInfo.seat = localized(input.seat);
  if (input.row) seatInfo.row = localized(input.row);
  if (input.section) seatInfo.section = localized(input.section);
  if (input.gate) seatInfo.gate = localized(input.gate);
  if (Object.keys(seatInfo).length) payload.seatInfo = seatInfo;
  return payload;
}

/**
 * Phase 3.3 — loyaltyClass (loyalty & membership presets).
 *
 * `rewardsTierLabel`/`accountIdLabel` are the labels Wallet prints next to
 * the tier and account-id values on the card — not the values themselves.
 */
export interface LoyaltyClassInput {
  classId: string;
  programName: string;
  issuerName: string;
  programLogoUrl?: string;
  heroImageUrl?: string;
  hexBackgroundColor?: string;
  rewardsTierLabel?: string;
  accountIdLabel?: string;
  callbackUrl: string;
}

export function buildLoyaltyClassPayload(input: LoyaltyClassInput): any {
  const payload: any = {
    id: input.classId,
    issuerName: input.issuerName,
    reviewStatus: 'UNDER_REVIEW',
    programName: input.programName,
    hexBackgroundColor: input.hexBackgroundColor,
    callbackOptions: { url: input.callbackUrl },
  };
  if (input.programLogoUrl) {
    payload.programLogo = { sourceUri: { uri: input.programLogoUrl } };
  }
  if (input.heroImageUrl) {
    payload.heroImage = { sourceUri: { uri: input.heroImageUrl } };
  }
  if (input.rewardsTierLabel) payload.rewardsTierLabel = input.rewardsTierLabel;
  if (input.accountIdLabel) payload.accountIdLabel = input.accountIdLabel;
  return payload;
}

/**
 * loyaltyObject. Tier is written as a text module (`id: 'tier'`), not
 * `secondaryLoyaltyPoints` — that field is for a second points currency
 * (e.g. miles alongside points), not a tier label, and repurposing it would
 * show a spurious second points row on the card.
 */
export interface LoyaltyObjectInput {
  objectId: string;
  classId: string;
  accountName: string;
  accountId: string;
  pointsBalance: number;
  tier?: string;
  barcodeValue: string;
  barcodeAltText?: string;
  textModulesData?: { id: string; header: string; body: string }[];
}

export function buildLoyaltyObjectPayload(input: LoyaltyObjectInput): any {
  const textModulesData = [...(input.textModulesData || [])];
  if (input.tier) {
    textModulesData.push({ id: 'tier', header: 'Tier', body: input.tier });
  }
  return {
    id: input.objectId,
    classId: input.classId,
    state: 'ACTIVE',
    accountName: input.accountName,
    accountId: input.accountId,
    loyaltyPoints: {
      label: 'Points',
      balance: { int: Math.round(input.pointsBalance) },
    },
    barcode: {
      type: 'QR_CODE',
      value: input.barcodeValue,
      alternateText: input.barcodeAltText || ' ',
    },
    textModulesData,
  };
}
