import {
  WALLET_TYPE_RESOURCES,
  walletResources,
  toMoney,
  buildGiftCardClassPayload,
  buildGiftCardObjectPayload,
  buildOfferClassPayload,
  buildOfferObjectPayload,
  buildEventTicketClassPayload,
  buildEventTicketObjectPayload,
  buildLoyaltyClassPayload,
  buildLoyaltyObjectPayload,
} from './wallet-types';

describe('wallet-types resource table', () => {
  it('maps every WalletType to its class/object resource and save-link JWT key', () => {
    expect(WALLET_TYPE_RESOURCES.generic).toEqual({
      classResource: 'genericClass',
      objectResource: 'genericObject',
      saveKey: 'genericObjects',
    });
    expect(WALLET_TYPE_RESOURCES.giftCard).toEqual({
      classResource: 'giftCardClass',
      objectResource: 'giftCardObject',
      saveKey: 'giftCardObjects',
    });
    expect(WALLET_TYPE_RESOURCES.loyalty.classResource).toBe('loyaltyClass');
    expect(WALLET_TYPE_RESOURCES.offer.classResource).toBe('offerClass');
    expect(WALLET_TYPE_RESOURCES.eventTicket.classResource).toBe(
      'eventTicketClass',
    );
  });

  it('walletResources falls back to generic for an unknown/undefined type', () => {
    expect(walletResources(undefined)).toEqual(WALLET_TYPE_RESOURCES.generic);
    expect(walletResources('nonsense' as any)).toEqual(
      WALLET_TYPE_RESOURCES.generic,
    );
  });
});

describe('toMoney', () => {
  it('converts rupees to integer micros with the given currency code', () => {
    expect(toMoney(150)).toEqual({ micros: 150_000_000, currencyCode: 'INR' });
    expect(toMoney(0)).toEqual({ micros: 0, currencyCode: 'INR' });
  });

  it('rounds fractional rupees rather than truncating with drift', () => {
    expect(toMoney(10.005).micros).toBe(10_005_000);
  });
});

describe('buildGiftCardClassPayload', () => {
  it('sets every giftCardClass-required field and none of generic’s', () => {
    const payload = buildGiftCardClassPayload({
      classId: 'issuer.class',
      merchantName: 'Bistro Cafe',
      programLogoUrl: 'https://logo',
      heroImageUrl: 'https://hero',
      hexBackgroundColor: '#14532D',
      merchantLocations: [{ latitude: '1.1', longitude: '2.2' }],
      callbackUrl: 'https://api.example.com/passes/webhooks/google-wallet',
    });

    expect(payload.id).toBe('issuer.class');
    expect(payload.issuerName).toBe('Bistro Cafe');
    expect(payload.reviewStatus).toBe('UNDER_REVIEW');
    expect(payload.merchantName).toBe('Bistro Cafe');
    expect(payload.programLogo).toEqual({
      sourceUri: { uri: 'https://logo' },
    });
    expect(payload.callbackOptions).toEqual({
      url: 'https://api.example.com/passes/webhooks/google-wallet',
    });
    expect(payload.merchantLocations).toEqual([
      { latitude: 1.1, longitude: 2.2 },
    ]);

    // Never the generic-only fields.
    expect(payload.logo).toBeUndefined();
    expect(payload.cardTitle).toBeUndefined();
  });

  it('caps merchantLocations at 10, mirroring the generic class builder', () => {
    const locations = Array.from({ length: 15 }, (_, i) => ({
      latitude: i,
      longitude: i,
    }));
    const payload = buildGiftCardClassPayload({
      classId: 'issuer.class',
      merchantName: 'Bistro Cafe',
      callbackUrl: 'https://api.example.com/cb',
      merchantLocations: locations,
    });
    expect(payload.merchantLocations).toHaveLength(10);
  });
});

describe('buildGiftCardObjectPayload', () => {
  it('carries cardNumber and a Money balance, never a "X Pts" string', () => {
    const payload = buildGiftCardObjectPayload({
      objectId: 'issuer.pass-1',
      classId: 'issuer.class',
      cardNumber: 'pass-1',
      balanceRupees: 250,
      barcodeValue: 'https://linearcard.vercel.app/m/pass-1',
      barcodeAltText: 'pass-1',
    });

    expect(payload.id).toBe('issuer.pass-1');
    expect(payload.classId).toBe('issuer.class');
    expect(payload.state).toBe('ACTIVE');
    expect(payload.cardNumber).toBe('pass-1');
    expect(payload.balance).toEqual({
      micros: 250_000_000,
      currencyCode: 'INR',
    });
    expect(typeof payload.balanceUpdateTime).toBe('string');
    expect(payload.barcode).toEqual({
      type: 'QR_CODE',
      value: 'https://linearcard.vercel.app/m/pass-1',
      alternateText: 'pass-1',
    });

    // Never the generic-only fields.
    expect(payload.cardTitle).toBeUndefined();
    expect(payload.header).toBeUndefined();
  });
});

describe('buildOfferClassPayload', () => {
  it('sets title/provider/redemptionChannel, defaulting channel to INSTORE', () => {
    const payload = buildOfferClassPayload({
      classId: 'issuer.class',
      title: 'One free coffee',
      provider: 'Bistro Cafe',
      callbackUrl: 'https://api.example.com/cb',
    });
    expect(payload.title).toBe('One free coffee');
    expect(payload.provider).toBe('Bistro Cafe');
    expect(payload.issuerName).toBe('Bistro Cafe');
    expect(payload.redemptionChannel).toBe('INSTORE');
    expect(payload.reviewStatus).toBe('UNDER_REVIEW');
    expect(payload.callbackOptions).toEqual({
      url: 'https://api.example.com/cb',
    });
  });

  it('honours an explicit redemptionChannel and optional details/finePrint', () => {
    const payload = buildOfferClassPayload({
      classId: 'issuer.class',
      title: 'Online-only 10% off',
      provider: 'Bistro Cafe',
      redemptionChannel: 'ONLINE',
      details: 'One per customer',
      finePrint: 'Cannot combine with other offers',
      callbackUrl: 'https://api.example.com/cb',
    });
    expect(payload.redemptionChannel).toBe('ONLINE');
    expect(payload.details).toBe('One per customer');
    expect(payload.finePrint).toBe('Cannot combine with other offers');
  });
});

describe('buildOfferObjectPayload', () => {
  it('starts ACTIVE and never carries loyalty/gift-card-only fields', () => {
    const payload = buildOfferObjectPayload({
      objectId: 'issuer.pass-1',
      classId: 'issuer.class',
      barcodeValue: 'https://linearcard.vercel.app/m/pass-1',
      barcodeAltText: 'pass-1',
    });
    expect(payload.state).toBe('ACTIVE');
    expect(payload.balance).toBeUndefined();
    expect(payload.loyaltyPoints).toBeUndefined();
  });

  it('flips to COMPLETED once redeemed and stays there', () => {
    const payload = buildOfferObjectPayload({
      objectId: 'issuer.pass-1',
      classId: 'issuer.class',
      state: 'COMPLETED',
      barcodeValue: 'https://linearcard.vercel.app/m/pass-1',
    });
    expect(payload.state).toBe('COMPLETED');
  });
});

describe('buildEventTicketClassPayload', () => {
  it('sets eventName/venue/dateTime as localized/structured fields', () => {
    const payload = buildEventTicketClassPayload({
      classId: 'issuer.class',
      eventName: 'Summer Music Fest',
      issuerName: 'City Events Co',
      venueName: 'Central Park',
      startDateTime: '2026-06-01T18:00:00Z',
      endDateTime: '2026-06-01T23:00:00Z',
      callbackUrl: 'https://api.example.com/cb',
    });
    expect(payload.eventName).toEqual({
      defaultValue: { language: 'en-US', value: 'Summer Music Fest' },
    });
    expect(payload.venue).toEqual({
      name: { defaultValue: { language: 'en-US', value: 'Central Park' } },
    });
    expect(payload.dateTime).toEqual({
      start: '2026-06-01T18:00:00Z',
      end: '2026-06-01T23:00:00Z',
    });
    expect(payload.reviewStatus).toBe('UNDER_REVIEW');
  });

  it('omits venue/dateTime entirely when the Program row has none', () => {
    const payload = buildEventTicketClassPayload({
      classId: 'issuer.class',
      eventName: 'TBD Event',
      issuerName: 'City Events Co',
      callbackUrl: 'https://api.example.com/cb',
    });
    expect(payload.venue).toBeUndefined();
    expect(payload.dateTime).toBeUndefined();
  });
});

describe('buildEventTicketObjectPayload', () => {
  it('builds seatInfo only from the fields that were provided', () => {
    const payload = buildEventTicketObjectPayload({
      objectId: 'issuer.pass-1',
      classId: 'issuer.class',
      seat: '12',
      row: 'A',
      barcodeValue: 'https://linearcard.vercel.app/m/pass-1',
    });
    expect(payload.seatInfo).toEqual({
      seat: { defaultValue: { language: 'en-US', value: '12' } },
      row: { defaultValue: { language: 'en-US', value: 'A' } },
    });
    expect(payload.seatInfo.section).toBeUndefined();
    expect(payload.seatInfo.gate).toBeUndefined();
  });

  it('omits seatInfo entirely when no seat fields are given', () => {
    const payload = buildEventTicketObjectPayload({
      objectId: 'issuer.pass-1',
      classId: 'issuer.class',
      barcodeValue: 'https://linearcard.vercel.app/m/pass-1',
    });
    expect(payload.seatInfo).toBeUndefined();
  });
});

describe('buildLoyaltyClassPayload', () => {
  it('sets programName and the tier/account-id labels', () => {
    const payload = buildLoyaltyClassPayload({
      classId: 'issuer.class',
      programName: 'Bistro Rewards',
      issuerName: 'Bistro Cafe',
      rewardsTierLabel: 'Tier',
      accountIdLabel: 'Member ID',
      callbackUrl: 'https://api.example.com/cb',
    });
    expect(payload.programName).toBe('Bistro Rewards');
    expect(payload.rewardsTierLabel).toBe('Tier');
    expect(payload.accountIdLabel).toBe('Member ID');
    expect(payload.reviewStatus).toBe('UNDER_REVIEW');
  });
});

describe('buildLoyaltyObjectPayload', () => {
  it('sets loyaltyPoints.balance as an int, never a "X Pts" string', () => {
    const payload = buildLoyaltyObjectPayload({
      objectId: 'issuer.pass-1',
      classId: 'issuer.class',
      accountName: 'Dhyan Patel',
      accountId: 'pass-1',
      pointsBalance: 120,
      barcodeValue: 'https://linearcard.vercel.app/m/pass-1',
    });
    expect(payload.loyaltyPoints).toEqual({
      label: 'Points',
      balance: { int: 120 },
    });
    expect(payload.accountName).toBe('Dhyan Patel');
    expect(payload.accountId).toBe('pass-1');
    expect(payload.balance).toBeUndefined();
  });

  it('writes tier as a text module, never secondaryLoyaltyPoints', () => {
    const payload = buildLoyaltyObjectPayload({
      objectId: 'issuer.pass-1',
      classId: 'issuer.class',
      accountName: 'Dhyan Patel',
      accountId: 'pass-1',
      pointsBalance: 0,
      tier: 'Gold',
      barcodeValue: 'https://linearcard.vercel.app/m/pass-1',
    });
    expect(payload.textModulesData).toContainEqual({
      id: 'tier',
      header: 'Tier',
      body: 'Gold',
    });
    expect(payload.secondaryLoyaltyPoints).toBeUndefined();
  });
});
