import { WalletService, resolveCardTitle } from './wallet.service';

// Phase 0.2: publishing a class refuses a localhost callback URL, and the
// repo .env points at localhost. Give these tests a public one.
process.env.PUBLIC_CALLBACK_URL = 'https://api.test.linearcard.example';
import { encryptSecret, decryptSecret } from '../env';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

describe('resolveCardTitle', () => {
  it('combines tenant name and template title with a middle dot', () => {
    expect(resolveCardTitle('Bistro Cafe', 'Gift Card')).toBe(
      'Bistro Cafe · Gift Card',
    );
  });

  it('falls back to the tenant name alone when there is no template title', () => {
    expect(resolveCardTitle('Bistro Cafe', undefined)).toBe('Bistro Cafe');
  });

  it('falls back to the template title alone when there is no tenant name', () => {
    expect(resolveCardTitle(undefined, 'Gift Card')).toBe('Gift Card');
  });

  it('returns undefined when neither is present', () => {
    expect(resolveCardTitle(undefined, undefined)).toBeUndefined();
  });
});

describe('WalletService.sendPromoMessageWithAudit', () => {
  let service: WalletService;
  let mockSupabaseService: any;
  let mockNotifyService: any;
  let mockWhatsappService: any;
  let mockAuditService: any;

  beforeEach(() => {
    mockSupabaseService = {
      client: {
        from: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        not: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        single: jest.fn(),
        gte: jest.fn(),
      },
    };
    mockNotifyService = {
      logNotification: jest.fn(),
    };
    mockWhatsappService = {
      sendRedemptionReceiptWithLog: jest.fn(),
      sendTierUpgradeMessage: jest.fn(),
    };
    mockAuditService = {
      record: jest.fn().mockResolvedValue(undefined),
    };
    service = new WalletService(
      mockSupabaseService,
      mockNotifyService,
      mockWhatsappService,
      mockAuditService,
      { dispatch: jest.fn().mockResolvedValue(undefined) } as any,
    );
  });

  it('should reject member without consent', async () => {
    mockSupabaseService.client.single.mockResolvedValue({ data: null }); // No consent

    await expect(
      service.sendPromoMessageWithAudit(
        'pass-1',
        'mem-1',
        'tenant-1',
        'Header',
        'Body',
      ),
    ).rejects.toThrow('Member has not consented');
  });

  // Phase 2.4 (DB-8): a grant on file is not enough — a later STOP overrides it.
  it('should reject a member who opted out after consenting', async () => {
    mockSupabaseService.client.single
      .mockResolvedValueOnce({ data: { consentedAt: '2023-01-01' } })
      .mockResolvedValueOnce({
        data: { marketingOptOutAt: '2026-09-01T00:00:00Z' },
      });

    await expect(
      service.sendPromoMessageWithAudit(
        'pass-1',
        'mem-1',
        'tenant-1',
        'Header',
        'Body',
      ),
    ).rejects.toThrow('opted out');
  });

  it('should log success after Google API succeeds', async () => {
    mockSupabaseService.client.single
      .mockResolvedValueOnce({ data: { consentedAt: '2023-01-01' } })
      // Phase 2.4: consent is re-checked against Member.marketingOptOutAt.
      .mockResolvedValueOnce({ data: { marketingOptOutAt: null } });

    const fakeClient = {
      request: jest.fn().mockResolvedValue({ data: { success: true } }),
    };
    jest
      .spyOn(service, 'getGoogleAuthClient')
      .mockResolvedValue(fakeClient as any);

    const result = await service.sendPromoMessageWithAudit(
      'pass-1',
      'mem-1',
      'tenant-1',
      'Header',
      'Body',
    );

    expect(result.success).toBe(true);
    expect(mockNotifyService.logNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'sent',
        type: 'promo_message',
      }),
    );
  });

  it('should log failure if Google API fails', async () => {
    mockSupabaseService.client.single
      .mockResolvedValueOnce({ data: { consentedAt: '2023-01-01' } })
      .mockResolvedValueOnce({ data: { marketingOptOutAt: null } });

    const fakeClient = {
      request: jest.fn().mockRejectedValue(new Error('Google API Error')),
    };
    jest
      .spyOn(service, 'getGoogleAuthClient')
      .mockResolvedValue(fakeClient as any);

    await expect(
      service.sendPromoMessageWithAudit(
        'pass-1',
        'mem-1',
        'tenant-1',
        'Header',
        'Body',
      ),
    ).rejects.toThrow();

    expect(mockNotifyService.logNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        // Phase 6.2: a stable code plus a cause, not a bare HTTP message.
        errorReason: expect.stringContaining('WALLET_UNAVAILABLE:'),
      }),
    );
  });
});

describe('AES-256-GCM private key encryption (env.ts)', () => {
  it('round-trips a private key through encrypt then decrypt', () => {
    const original =
      '-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----\n';
    const encrypted = encryptSecret(original);
    expect(encrypted).not.toContain('BEGIN PRIVATE KEY');
    expect(decryptSecret(encrypted)).toBe(original);
  });

  it('produces a different ciphertext each time (random IV) but always decrypts correctly', () => {
    const original = 'same-plaintext';
    const a = encryptSecret(original);
    const b = encryptSecret(original);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(original);
    expect(decryptSecret(b)).toBe(original);
  });
});

describe('wallet.service.ts no longer hardcodes the issuer literal', () => {
  it('does not contain the old hardcoded issuer string anywhere in the file', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'wallet.service.ts'),
      'utf8',
    );
    expect(source).not.toContain('3388000000023177673');
  });
});

describe('WalletService.forTenant credential resolution', () => {
  let service: WalletService;
  let mockSupabaseService: any;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockSupabaseService = { client: { from: jest.fn() } };
    service = new WalletService(
      mockSupabaseService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    process.env.ISSUER_ID = 'env-issuer';
    process.env.GOOGLE_CLIENT_EMAIL = 'env@example.com';
    process.env.GOOGLE_PRIVATE_KEY = 'env-raw-key';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('prefers tenant-level credentials over the env fallback when all three are set', async () => {
    const encryptedKey = encryptSecret('tenant-raw-key');
    mockSupabaseService.client.from.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: {
              issuerId: 'tenant-issuer',
              googleClientEmail: 'tenant@example.com',
              googlePrivateKeyEncrypted: encryptedKey,
            },
          }),
        }),
      }),
    });

    const scoped = await service.forTenant('tenant-1');
    const creds = (scoped as any).getCredentialsOrThrow();

    expect(creds.issuerId).toBe('tenant-issuer');
    expect(creds.clientEmail).toBe('tenant@example.com');
    expect(creds.privateKey).toContain('tenant-raw-key');
  });

  it('falls back to env vars field-by-field when tenant columns are null', async () => {
    mockSupabaseService.client.from.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: {
              issuerId: null,
              googleClientEmail: null,
              googlePrivateKeyEncrypted: null,
            },
          }),
        }),
      }),
    });

    const scoped = await service.forTenant('tenant-2');
    const creds = (scoped as any).getCredentialsOrThrow();

    expect(creds.issuerId).toBe('env-issuer');
    expect(creds.clientEmail).toBe('env@example.com');
    expect(creds.privateKey).toContain('env-raw-key');
  });

  it('throws when neither tenant nor env has credentials', async () => {
    delete process.env.ISSUER_ID;
    mockSupabaseService.client.from.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: null }),
        }),
      }),
    });

    await expect(service.forTenant('tenant-3')).rejects.toThrow(
      /Missing Google Wallet credentials/,
    );
  });

  it('a plain (non-forTenant) instance still resolves credentials from env, unchanged', () => {
    const creds = (service as any).getCredentialsOrThrow();
    expect(creds.issuerId).toBe('env-issuer');
  });
});

describe('resolveTenantPassDesign', () => {
  let service: WalletService;
  let mockSupabaseService: any;

  function mockFrom(tenantData: any, templateData: any) {
    mockSupabaseService.client.from.mockImplementation((table: string) => {
      if (table === 'Tenant') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: tenantData }),
            }),
          }),
        };
      }
      if (table === 'PassTemplate') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({ data: templateData }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });
  }

  beforeEach(() => {
    mockSupabaseService = { client: { from: jest.fn() } };
    service = new WalletService(
      mockSupabaseService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  it('combines tenant name and template title into cardTitle', async () => {
    mockFrom(
      { name: 'Bistro Cafe', brandHexColor: '#8B4513' },
      {
        hexBackgroundColor: '#7C3AED',
        classSuffix: 'tpl_suffix',
        title: 'Gift Card',
      },
    );

    const design = await service.resolveTenantPassDesign('tenant-1');
    expect(design.cardTitle).toBe('Bistro Cafe · Gift Card');
  });

  it('prefers the published template colour over the tenant colour', async () => {
    mockFrom(
      { brandHexColor: '#8B4513', logoUrl: 'tenant-logo.png' },
      { hexBackgroundColor: '#7C3AED', classSuffix: 'tpl_suffix' },
    );

    const design = await service.resolveTenantPassDesign('tenant-1');
    expect(design.hexBackgroundColor).toBe('#7C3AED');
  });

  it('falls back to Tenant.brandHexColor when no published template exists', async () => {
    mockFrom({ brandHexColor: '#8B4513' }, null);

    const design = await service.resolveTenantPassDesign('tenant-1');
    expect(design.hexBackgroundColor).toBe('#8B4513');
  });

  it('falls back to DEFAULT_PASS_HEX when neither template nor tenant has a colour', async () => {
    mockFrom({}, null);

    const design = await service.resolveTenantPassDesign('tenant-1');
    expect(design.hexBackgroundColor).toBe('#1A365D');
  });
});

describe('updateGenericObject — hexBackgroundColor patching', () => {
  let service: WalletService;
  let mockGoogleAuthClient: { request: jest.Mock };

  beforeEach(() => {
    service = new WalletService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    mockGoogleAuthClient = { request: jest.fn() };
    jest
      .spyOn(service, 'getGoogleAuthClient')
      .mockResolvedValue(mockGoogleAuthClient as any);
  });

  it('includes cardTitle in the PATCH payload when supplied', async () => {
    mockGoogleAuthClient.request
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: {} });

    await service.updateGenericObject('issuer.pass-1', {
      cardTitle: 'Bistro Cafe · Gift Card',
    });

    const patchCall = mockGoogleAuthClient.request.mock.calls[1][0];
    expect(patchCall.data.cardTitle).toEqual({
      defaultValue: { language: 'en-US', value: 'Bistro Cafe · Gift Card' },
    });
  });

  it('omits cardTitle from the PATCH payload when not supplied', async () => {
    mockGoogleAuthClient.request
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: {} });

    await service.updateGenericObject('issuer.pass-1', { tier: 'Gold' });

    const patchCall = mockGoogleAuthClient.request.mock.calls[1][0];
    expect(patchCall.data.cardTitle).toBeUndefined();
  });

  it('includes hexBackgroundColor in the PATCH payload when supplied', async () => {
    mockGoogleAuthClient.request
      .mockResolvedValueOnce({ data: {} }) // GET genericObject
      .mockResolvedValueOnce({ data: {} }); // PATCH

    await service.updateGenericObject('issuer.pass-1', {
      hexBackgroundColor: '#7C3AED',
    });

    const patchCall = mockGoogleAuthClient.request.mock.calls[1][0];
    expect(patchCall.method).toBe('PATCH');
    expect(patchCall.data.hexBackgroundColor).toBe('#7C3AED');
  });

  it('omits hexBackgroundColor from the PATCH payload when not supplied', async () => {
    mockGoogleAuthClient.request
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: {} });

    await service.updateGenericObject('issuer.pass-1', { tier: 'Gold' });

    const patchCall = mockGoogleAuthClient.request.mock.calls[1][0];
    expect(patchCall.data.hexBackgroundColor).toBeUndefined();
  });
});

describe('createGenericClass — stable field keys', () => {
  let service: WalletService;
  let mockGoogleAuthClient: { request: jest.Mock };

  beforeEach(() => {
    service = new WalletService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    mockGoogleAuthClient = { request: jest.fn() };
    jest
      .spyOn(service, 'getGoogleAuthClient')
      .mockResolvedValue(mockGoogleAuthClient as any);
  });

  it('uses column.key as the textModulesData fieldPath id when present', async () => {
    mockGoogleAuthClient.request.mockResolvedValueOnce({
      data: { id: 'issuer.class_1' },
    });

    await service.createGenericClass({
      classSuffix: 'class_1',
      rows: [
        {
          id: 'row1',
          columns: [{ key: 'points_balance', header: 'Points', body: '500' }],
        },
      ],
    });

    const payload = mockGoogleAuthClient.request.mock.calls[0][0].data;
    const fieldPath =
      payload.classTemplateInfo.cardTemplateOverride.cardRowTemplateInfos[0]
        .oneItem.item.fieldSelector.fields[0].fieldPath;
    expect(fieldPath).toBe("object.textModulesData['points_balance']");
  });

  it('falls back to rowId_index when column.key is missing', async () => {
    mockGoogleAuthClient.request.mockResolvedValueOnce({
      data: { id: 'issuer.class_1' },
    });

    await service.createGenericClass({
      classSuffix: 'class_1',
      rows: [{ id: 'row1', columns: [{ header: 'Points', body: '500' }] }],
    });

    const payload = mockGoogleAuthClient.request.mock.calls[0][0].data;
    const fieldPath =
      payload.classTemplateInfo.cardTemplateOverride.cardRowTemplateInfos[0]
        .oneItem.item.fieldSelector.fields[0].fieldPath;
    expect(fieldPath).toBe("object.textModulesData['row1_0']");
  });

  it('class fieldPath ids and object textModulesData ids always agree (mixed keyed/unkeyed columns)', async () => {
    const rows = [
      {
        id: 'row1',
        columns: [
          { key: 'points_balance', header: 'Points', body: '500' },
          { header: 'Tier', body: 'Gold' }, // no key -> falls back to row1_1
        ],
      },
    ];

    // 1. Build the class and collect every fieldPath id it selects.
    mockGoogleAuthClient.request.mockResolvedValueOnce({
      data: { id: 'issuer.class_1' },
    });
    await service.createGenericClass({ classSuffix: 'class_1', rows });
    const classPayload = mockGoogleAuthClient.request.mock.calls[0][0].data;
    const fieldPathIds: string[] =
      classPayload.classTemplateInfo.cardTemplateOverride.cardRowTemplateInfos[0].twoItems.startItem.item.fieldSelector.fields
        .map((f: any) => f.fieldPath.match(/\['(.+)'\]/)[1])
        .concat(
          classPayload.classTemplateInfo.cardTemplateOverride.cardRowTemplateInfos[0].twoItems.endItem.item.fieldSelector.fields.map(
            (f: any) => f.fieldPath.match(/\['(.+)'\]/)[1],
          ),
        );

    // 2. Build the object and collect its textModulesData ids.
    const objectClient = { request: jest.fn().mockResolvedValue({ data: {} }) };
    jest
      .spyOn(service, 'getGoogleAuthClient')
      .mockResolvedValue(objectClient as any);
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    process.env.ISSUER_ID = 'issuer';
    process.env.GOOGLE_CLIENT_EMAIL = 'test@example.com';
    process.env.GOOGLE_PRIVATE_KEY = privateKey.replace(/\n/g, '\\n');

    // Phase 7.7 — identity fields are required now; no demo defaults.
    await service.createGoogleWalletPass({
      passId: 'pass1',
      rows,
      memberName: 'Asha',
      cardTitle: 'Bean House',
      balance: '0 Pts',
      classSuffix: 'beanhouse_coffee_standard',
    });

    const objectIds =
      objectClient.request.mock.calls[0][0].data.textModulesData.map(
        (m: any) => m.id,
      );

    for (const id of fieldPathIds) {
      expect(objectIds).toContain(id);
    }
  });
});

describe('createGenericClass — merchantLocations (geofencing)', () => {
  let service: WalletService;
  let mockGoogleAuthClient: { request: jest.Mock };

  beforeEach(() => {
    service = new WalletService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    mockGoogleAuthClient = { request: jest.fn() };
    jest
      .spyOn(service, 'getGoogleAuthClient')
      .mockResolvedValue(mockGoogleAuthClient as any);
  });

  it('maps storeLocations to merchantLocations with {latitude, longitude} pairs', async () => {
    mockGoogleAuthClient.request.mockResolvedValueOnce({
      data: { id: 'issuer.class_1' },
    });

    await service.createGenericClass({
      classSuffix: 'class_1',
      storeLocations: [
        { latitude: '19.076000', longitude: '72.877000' },
        { latitude: 28.6139, longitude: 77.209 },
      ],
    });

    const payload = mockGoogleAuthClient.request.mock.calls[0][0].data;
    expect(payload.merchantLocations).toEqual([
      {
        latitude: 19.076,
        longitude: 72.877,
      },
      {
        latitude: 28.6139,
        longitude: 77.209,
      },
    ]);
  });

  it('truncates to a max of 10 locations', async () => {
    mockGoogleAuthClient.request.mockResolvedValueOnce({
      data: { id: 'issuer.class_1' },
    });

    const eleven = Array.from({ length: 11 }, (_, i) => ({
      latitude: i,
      longitude: i,
    }));

    await service.createGenericClass({
      classSuffix: 'class_1',
      storeLocations: eleven,
    });

    const payload = mockGoogleAuthClient.request.mock.calls[0][0].data;
    expect(payload.merchantLocations).toHaveLength(10);
  });

  it('omits merchantLocations entirely when storeLocations is empty', async () => {
    mockGoogleAuthClient.request.mockResolvedValueOnce({
      data: { id: 'issuer.class_1' },
    });

    await service.createGenericClass({
      classSuffix: 'class_1',
      storeLocations: [],
    });

    const payload = mockGoogleAuthClient.request.mock.calls[0][0].data;
    expect(payload.merchantLocations).toBeUndefined();
  });
});

describe('resolveCallbackUrl', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let service: WalletService;

  beforeEach(() => {
    originalEnv = { ...process.env };
    service = new WalletService(
      {} as any, // mockSupabaseService
      {} as any, // configService
      {} as any, // notifyService
      {} as any, // whatsappService
      {} as any, // auditService
    );
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('ignores PUBLIC_CALLBACK_URL when VERCEL_ENV is set', () => {
    process.env.VERCEL_ENV = 'production';
    process.env.PUBLIC_CALLBACK_URL = 'https://some-tunnel.ngrok.io';
    process.env.NEXT_PUBLIC_API_URL = 'https://linearcard-api.vercel.app';
    delete process.env.WALLET_WEBHOOK_SECRET;

    expect(service.resolveCallbackUrl()).toBe(
      'https://linearcard-api.vercel.app/passes/webhooks/google-wallet',
    );
  });

  it('uses PUBLIC_CALLBACK_URL on local dev when VERCEL_ENV is not set', () => {
    delete process.env.VERCEL_ENV;
    process.env.PUBLIC_CALLBACK_URL = 'https://some-tunnel.ngrok.io';
    process.env.NEXT_PUBLIC_API_URL = 'http://localhost:3001';
    delete process.env.WALLET_WEBHOOK_SECRET;

    expect(service.resolveCallbackUrl()).toBe(
      'https://some-tunnel.ngrok.io/passes/webhooks/google-wallet',
    );
  });
});

describe('syncPassAfterTransaction', () => {
  let service: WalletService;
  let whatsappService: any;

  const basePass = {
    id: 'pass-1',
    fullPassId: 'issuer.pass-1',
    memberId: 'member-1',
    tenantId: 'tenant-1',
    tier: 'Bronze',
    phone: '+919876543210',
    tiers: [
      {
        id: 't-bronze',
        programId: 'program-1',
        name: 'Bronze',
        minPoints: 0,
        templateId: 'tpl-bronze',
        sortOrder: 0,
      },
      {
        id: 't-silver',
        programId: 'program-1',
        name: 'Silver',
        minPoints: 500,
        templateId: 'tpl-silver',
        sortOrder: 1,
      },
      {
        id: 't-gold',
        programId: 'program-1',
        name: 'Gold',
        minPoints: 2000,
        templateId: 'tpl-gold',
        sortOrder: 2,
      },
    ],
  };

  beforeEach(() => {
    const mockSupabaseService: any = {
      client: {
        from: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        eq: jest.fn().mockResolvedValue({ data: null, error: null }),
      },
    };
    const mockNotifyService: any = {
      logNotification: jest.fn(),
    };
    whatsappService = {
      sendRedemptionReceiptWithLog: jest.fn().mockResolvedValue(undefined),
      sendTierUpgradeMessage: jest.fn().mockResolvedValue(undefined),
    };

    service = new WalletService(
      mockSupabaseService,
      mockNotifyService,
      whatsappService,
      { record: jest.fn().mockResolvedValue(undefined) } as any,
      { dispatch: jest.fn().mockResolvedValue(undefined) } as any,
    );

    jest.spyOn(service, 'updateGenericObject').mockResolvedValue({});
    jest.spyOn(service as any, 'sendOfferMessage').mockResolvedValue({});
  });

  it('does not report a tier change when the balance stays within the same tier', async () => {
    const result = await service.syncPassAfterTransaction(
      basePass,
      { type: 'award', pointsChanged: 50, newBalance: 100, orderAmount: 500 },
      'Acme Cafe',
    );
    expect(result.tier).toBe('Bronze');
    expect(result.tierChanged).toBe(false);
    expect(whatsappService.sendTierUpgradeMessage).not.toHaveBeenCalled();
  });

  it('reports a tier change and sends a WhatsApp tier-upgrade message when crossing a threshold', async () => {
    const result = await service.syncPassAfterTransaction(
      basePass,
      { type: 'award', pointsChanged: 600, newBalance: 600, orderAmount: 6000 },
      'Acme Cafe',
    );
    expect(result.tier).toBe('Silver');
    expect(result.tierChanged).toBe(true);
    expect(whatsappService.sendTierUpgradeMessage).toHaveBeenCalledWith(
      basePass.phone,
      'Silver',
      'Acme Cafe',
      { tenantId: 'tenant-1', memberId: 'member-1' },
    );
  });

  it('always sends the WhatsApp redemption receipt for a redeem transaction', async () => {
    await service.syncPassAfterTransaction(
      basePass,
      { type: 'redeem', pointsChanged: 50, newBalance: 50, orderAmount: 100 },
      'Acme Cafe',
    );
    expect(whatsappService.sendRedemptionReceiptWithLog).toHaveBeenCalledWith(
      basePass.phone,
      '50 Pts',
      'Acme Cafe',
      { tenantId: 'tenant-1', memberId: 'member-1' },
    );
  });

  it('does not throw when the pass has no phone number', async () => {
    const noPhonePass = { ...basePass, phone: undefined };
    await expect(
      service.syncPassAfterTransaction(
        noPhonePass,
        { type: 'award', pointsChanged: 10, newBalance: 10, orderAmount: 100 },
        'Acme Cafe',
      ),
    ).resolves.toBeDefined();
    expect(whatsappService.sendRedemptionReceiptWithLog).not.toHaveBeenCalled();
  });

  it('swallows WhatsApp send failures without throwing', async () => {
    (
      whatsappService.sendRedemptionReceiptWithLog as jest.Mock
    ).mockRejectedValueOnce(new Error('WAHA down'));
    await expect(
      service.syncPassAfterTransaction(
        basePass,
        { type: 'award', pointsChanged: 10, newBalance: 10, orderAmount: 100 },
        'Acme Cafe',
      ),
    ).resolves.toBeDefined();
  });

  it('pushes the new tier to the Google Wallet object when a tier change occurs', async () => {
    await service.syncPassAfterTransaction(
      basePass,
      { type: 'award', pointsChanged: 600, newBalance: 600, orderAmount: 6000 },
      'Acme Cafe',
    );
    expect(service.updateGenericObject).toHaveBeenCalledWith(
      basePass.fullPassId,
      expect.objectContaining({ tier: 'Silver' }),
      'generic',
    );
  });

  it('does not send a WhatsApp tier message and marks isUpgrade false on a downgrade', async () => {
    const goldPass = { ...basePass, tier: 'Gold' };
    const result = await service.syncPassAfterTransaction(
      goldPass,
      {
        type: 'redeem',
        pointsChanged: 1900,
        newBalance: 100,
        orderAmount: 3800,
      },
      'Acme Cafe',
    );
    expect(result.tier).toBe('Bronze');
    expect(result.tierChanged).toBe(true);
    expect(result.isUpgrade).toBe(false);
    expect(whatsappService.sendTierUpgradeMessage).not.toHaveBeenCalled();
  });

  it('marks isUpgrade true and sends the WhatsApp message on an upgrade', async () => {
    const result = await service.syncPassAfterTransaction(
      basePass,
      { type: 'award', pointsChanged: 600, newBalance: 600, orderAmount: 6000 },
      'Acme Cafe',
    );
    expect(result.isUpgrade).toBe(true);
    expect(whatsappService.sendTierUpgradeMessage).toHaveBeenCalled();
  });

  it("resolves the design of the new tier's templateId and pushes it to the wallet object on a tier change", async () => {
    jest.spyOn(service, 'resolveTenantPassDesign').mockResolvedValue({
      hexBackgroundColor: '#SILVER',
      logoUrl: 'https://logo/silver.png',
    });

    await service.syncPassAfterTransaction(
      basePass,
      { type: 'award', pointsChanged: 600, newBalance: 600, orderAmount: 6000 },
      'Acme Cafe',
    );

    expect(service.resolveTenantPassDesign).toHaveBeenCalledWith(
      basePass.tenantId,
      'tpl-silver',
      undefined,
    );
    expect(service.updateGenericObject).toHaveBeenCalledWith(
      basePass.fullPassId,
      expect.objectContaining({
        tier: 'Silver',
        hexBackgroundColor: '#SILVER',
        logoUrl: 'https://logo/silver.png',
      }),
      'generic',
    );
  });

  it('keeps a manually-set tier unchanged when the tenant has no configured tiers', async () => {
    const manualTierPass = { ...basePass, tier: 'VIP', tiers: [] };
    const result = await service.syncPassAfterTransaction(
      manualTierPass,
      { type: 'award', pointsChanged: 10, newBalance: 10, orderAmount: 100 },
      'Acme Cafe',
    );
    expect(result.tier).toBe('VIP');
    expect(result.tierChanged).toBe(false);
    expect(whatsappService.sendTierUpgradeMessage).not.toHaveBeenCalled();
  });
});

describe('processOrderTransaction — tier propagation', () => {
  let service: WalletService;
  let supabaseServiceMock: any;
  let mockAuditService: any;

  beforeEach(() => {
    supabaseServiceMock = {
      client: {
        from: jest.fn(),
        // Phase 1.4: balance mutation goes through the atomic RPC. `data:
        // null` means "no authoritative balance returned", so these tests
        // keep asserting against the locally computed one.
        rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
      },
    };
    const mockNotifyService: any = {
      logNotification: jest.fn(),
    };
    const mockWhatsappService: any = {
      sendRedemptionReceiptWithLog: jest.fn().mockResolvedValue(undefined),
      sendTierUpgradeMessage: jest.fn().mockResolvedValue(undefined),
    };
    mockAuditService = {
      record: jest.fn().mockResolvedValue(undefined),
    };

    service = new WalletService(
      supabaseServiceMock,
      mockNotifyService,
      mockWhatsappService,
      mockAuditService,
      { dispatch: jest.fn().mockResolvedValue(undefined) } as any,
    );
  });

  it('returns the recomputed tier and tierChanged flag from syncPassAfterTransaction', async () => {
    supabaseServiceMock.client.from.mockImplementation((table: string) => {
      if (table === 'Pass') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: 'pass-1',
                  fullPassId: 'issuer.pass-1',
                  memberId: 'member-1',
                  tenantId: 'tenant-1',
                  balance: 100,
                  tier: 'Bronze',
                  Member: { phone: '+919876543210' },
                  Tenant: { name: 'Acme Cafe' },
                },
              }),
            }),
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
          insert: async () => ({ error: null }),
        };
      }
      if (table === 'Program') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: { id: 'program-1' } }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'Tier') {
        return {
          select: () => ({
            eq: () => ({
              order: async () => ({
                data: [
                  {
                    id: 't-silver',
                    programId: 'program-1',
                    name: 'Silver',
                    minPoints: 500,
                    templateId: 'tpl-silver',
                    sortOrder: 0,
                  },
                ],
              }),
            }),
          }),
        };
      }
      return { insert: async () => ({ error: null }) };
    });
    jest.spyOn(service, 'syncPassAfterTransaction').mockResolvedValue({
      walletPushed: true,
      directNotified: false,
      tier: 'Silver',
      tierChanged: true,
    });

    const result = await service.processOrderTransaction(
      'pass-1',
      5000,
      'award',
      'manual',
    );

    expect(result.tier).toBe('Silver');
    expect(result.tierChanged).toBe(true);
    expect(mockAuditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        memberId: 'member-1',
        passId: 'pass-1',
        action: 'order_transaction',
      }),
    );
  });

  it("scores a pass against its own program, not the tenant's oldest one (PRG-1)", async () => {
    // D8: one tenant, two programs. Before Phase 3.3 this resolved the
    // tenant's oldest Program and scored every scan against it, so a coffee
    // pass was ranked by the gym program's tiers.
    const tiersByProgram: Record<string, any[]> = {
      'program-coffee': [
        {
          id: 't-coffee-silver',
          programId: 'program-coffee',
          name: 'Silver',
          minPoints: 500,
          templateId: 'tpl-coffee',
          sortOrder: 0,
        },
      ],
      'program-gym': [
        {
          id: 't-gym-gold',
          programId: 'program-gym',
          name: 'Gold',
          minPoints: 9999,
          templateId: 'tpl-gym',
          sortOrder: 0,
        },
      ],
    };

    supabaseServiceMock.client.from.mockImplementation((table: string) => {
      if (table === 'Pass') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: 'pass-1',
                  fullPassId: 'issuer.pass-1',
                  memberId: 'member-1',
                  tenantId: 'tenant-1',
                  // The pass belongs to the coffee program, which is NOT the
                  // tenant's oldest.
                  programId: 'program-coffee',
                  balance: 100,
                  tier: 'Bronze',
                  Member: { phone: '+919876543210' },
                  Tenant: { name: 'Acme Cafe' },
                },
              }),
            }),
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
          insert: async () => ({ error: null }),
        };
      }
      if (table === 'Program') {
        return {
          select: () => ({
            eq: (_col: string, id: string) => ({
              maybeSingle: async () => ({
                data: { id, kind: 'loyalty', earnRate: null },
              }),
            }),
          }),
        };
      }
      if (table === 'Tier') {
        return {
          select: () => ({
            eq: (_col: string, programId: string) => ({
              order: async () => ({ data: tiersByProgram[programId] || [] }),
            }),
          }),
        };
      }
      return { insert: async () => ({ error: null }) };
    });

    const syncSpy = jest
      .spyOn(service, 'syncPassAfterTransaction')
      .mockResolvedValue({
        walletPushed: true,
        directNotified: false,
        tier: 'Silver',
        tierChanged: true,
      });

    await service.processOrderTransaction('pass-1', 5000, 'award', 'manual');

    const passedTiers = syncSpy.mock.calls[0][0].tiers;
    expect(passedTiers).toHaveLength(1);
    expect(passedTiers[0].name).toBe('Silver'); // coffee's tier, not gym's Gold
    expect(syncSpy.mock.calls[0][0].programId).toBe('program-coffee');
  });
});

/**
 * Phase 2 — gift cards hold money, not points. A `load` credits face value;
 * `earnRate` must never touch it.
 */
describe('processOrderTransaction — gift card load', () => {
  let service: WalletService;
  let supabaseServiceMock: any;
  let rpcMock: jest.Mock;

  const setup = (programKind: string, earnRate: number | null = 0) => {
    rpcMock = jest.fn().mockResolvedValue({ data: null, error: null });
    supabaseServiceMock = { client: { from: jest.fn(), rpc: rpcMock } };
    supabaseServiceMock.client.from.mockImplementation((table: string) => {
      if (table === 'Pass') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: 'pass-1',
                  fullPassId: 'issuer.pass-1',
                  memberId: 'member-1',
                  tenantId: 'tenant-1',
                  programId: 'program-gc',
                  balance: 100,
                  tier: 'Member',
                  Member: { phone: '+919876543210' },
                  Tenant: { name: 'Acme Retail' },
                },
              }),
            }),
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
          insert: async () => ({ error: null }),
        };
      }
      if (table === 'Program') {
        return {
          select: () => ({
            eq: (_col: string, id: string) => ({
              maybeSingle: async () => ({
                data: {
                  id,
                  kind: programKind,
                  earnRate,
                  redeemRate: 1,
                  redeemCapPercent: 100,
                },
              }),
            }),
          }),
        };
      }
      if (table === 'Tier') {
        return {
          select: () => ({ eq: () => ({ order: async () => ({ data: [] }) }) }),
        };
      }
      return { insert: async () => ({ error: null }) };
    });

    service = new WalletService(
      supabaseServiceMock,
      { logNotification: jest.fn() } as any,
      {
        sendRedemptionReceiptWithLog: jest.fn().mockResolvedValue(undefined),
        sendTierUpgradeMessage: jest.fn().mockResolvedValue(undefined),
      } as any,
      { record: jest.fn().mockResolvedValue(undefined) } as any,
      { dispatch: jest.fn().mockResolvedValue(undefined) } as any,
    );
    jest.spyOn(service, 'syncPassAfterTransaction').mockResolvedValue({
      walletPushed: true,
      directNotified: false,
      tier: 'Member',
      tierChanged: false,
    });
    return service;
  };

  it('credits a load at face value, never multiplied by earnRate', async () => {
    const svc = setup('giftcard', 0.1);
    const result = await svc.processOrderTransaction(
      'pass-1',
      500,
      'load',
      'manual',
    );

    expect(result.pointsChanged).toBe(500);
    expect(result.newBalance).toBe(600); // 100 existing + 500 loaded
    expect(rpcMock).toHaveBeenCalledWith('increment_pass_balance', {
      p_pass_id: 'pass-1',
      p_delta: 500,
    });
  });

  it("routes an 'award' on a gift card to the load path instead of rejecting it", async () => {
    const svc = setup('giftcard', 0.1);
    const result = await svc.processOrderTransaction(
      'pass-1',
      500,
      'award',
      'manual',
    );

    // 500 face value, not 50 (= 500 * 0.1 earnRate).
    expect(result.pointsChanged).toBe(500);
    expect(
      (svc.syncPassAfterTransaction as jest.Mock).mock.calls[0][1].type,
    ).toBe('load');
  });

  it('still spends a gift card down on redeem', async () => {
    const svc = setup('giftcard');
    const result = await svc.processOrderTransaction(
      'pass-1',
      80,
      'redeem',
      'manual',
    );

    expect(result.pointsChanged).toBe(80);
    expect(result.newBalance).toBe(20);
    expect(result.discountApplied).toBe(80);
  });

  it('refuses to load a non-gift-card program', async () => {
    const svc = setup('loyalty', 0.1);
    await expect(
      svc.processOrderTransaction('pass-1', 500, 'load', 'manual'),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('createGoogleWalletPass - tier/balance conditionally', () => {
  let service: WalletService;
  let mockGoogleAuthClient: { request: jest.Mock };

  beforeEach(() => {
    service = new WalletService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    mockGoogleAuthClient = {
      request: jest.fn().mockResolvedValue({ data: {} }),
    };
    jest
      .spyOn(service, 'getGoogleAuthClient')
      .mockResolvedValue(mockGoogleAuthClient as any);
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    jest.spyOn(service as any, 'getCredentialsOrThrow').mockReturnValue({
      issuerId: 'issuer',
      clientEmail: 'test@example.com',
      privateKey,
    });
  });

  it('omits subheader and barcode.alternateText when tier and balance are undefined', async () => {
    await service.createGoogleWalletPass({
      passId: 'pass-1',
      memberName: 'John Doe',
      cardTitle: 'Ticket',
      classSuffix: 'ticket_class',
      tier: undefined,
      balance: undefined,
    });

    const payload = mockGoogleAuthClient.request.mock.calls[0][0].data;
    expect(payload.subheader).toBeUndefined();
    expect(payload.barcode.alternateText).toBe(' ');
  });
});

describe('Phase 2 — gift card issuance (walletType: giftCard)', () => {
  let service: WalletService;
  let mockGoogleAuthClient: { request: jest.Mock };

  beforeEach(() => {
    service = new WalletService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    mockGoogleAuthClient = {
      request: jest.fn().mockResolvedValue({ data: {} }),
    };
    jest
      .spyOn(service, 'getGoogleAuthClient')
      .mockResolvedValue(mockGoogleAuthClient as any);
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    jest.spyOn(service as any, 'getCredentialsOrThrow').mockReturnValue({
      issuerId: 'issuer',
      clientEmail: 'test@example.com',
      privateKey,
    });
    jest.spyOn(service, 'storeLocationsForProgram').mockResolvedValue([]);
  });

  it('issues a giftCardObject with a Money balance, never a "X Pts" string', async () => {
    const result = await service.createGoogleWalletPass({
      passId: 'pass-1',
      memberName: 'Asha',
      cardTitle: 'Bistro Cafe · Gift card',
      classSuffix: 'bistro_gift_card',
      balance: '250',
      walletType: 'giftCard',
    });

    expect(result.success).toBe(true);
    const payload = mockGoogleAuthClient.request.mock.calls[0][0].data;
    expect(mockGoogleAuthClient.request.mock.calls[0][0].url).toContain(
      '/giftCardObject',
    );
    expect(payload.cardNumber).toBe('pass-1');
    expect(payload.balance).toEqual({
      micros: 250_000_000,
      currencyCode: 'INR',
    });
    expect(payload.cardTitle).toBeUndefined();
  });

  it('signs the save-link JWT under the giftCardObjects payload key', async () => {
    const { googleWalletUrl } = await service.createGoogleWalletPass({
      passId: 'pass-2',
      memberName: 'Asha',
      cardTitle: 'Bistro Cafe · Gift card',
      classSuffix: 'bistro_gift_card',
      balance: '100',
      walletType: 'giftCard',
    });
    const token = googleWalletUrl!.split('/save/')[1];
    const decoded = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64').toString(),
    );
    expect(decoded.payload.giftCardObjects).toBeDefined();
    expect(decoded.payload.genericObjects).toBeUndefined();
  });

  it('publishes a giftCardClass, not a genericClass', async () => {
    mockGoogleAuthClient.request.mockResolvedValueOnce({
      data: { id: 'issuer.gift_class' },
    });
    await service.createGenericClass(
      {
        classSuffix: 'bistro_gift_card',
        cardTitle: 'Bistro Cafe',
        hexBackgroundColor: '#14532D',
      },
      'giftCard',
    );
    const call = mockGoogleAuthClient.request.mock.calls[0][0];
    expect(call.url).toContain('/giftCardClass');
    expect(call.data.reviewStatus).toBe('UNDER_REVIEW');
    expect(call.data.merchantName).toBe('Bistro Cafe');
  });
});

describe('Phase 3 — offer, eventTicket, loyalty issuance', () => {
  let service: WalletService;
  let mockGoogleAuthClient: { request: jest.Mock };

  beforeEach(() => {
    service = new WalletService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    mockGoogleAuthClient = {
      request: jest.fn().mockResolvedValue({ data: {} }),
    };
    jest
      .spyOn(service, 'getGoogleAuthClient')
      .mockResolvedValue(mockGoogleAuthClient as any);
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    jest.spyOn(service as any, 'getCredentialsOrThrow').mockReturnValue({
      issuerId: 'issuer',
      clientEmail: 'test@example.com',
      privateKey,
    });
    jest.spyOn(service, 'storeLocationsForProgram').mockResolvedValue([]);
  });

  it('issues an offerObject and signs the save link under offerObjects', async () => {
    const result = await service.createGoogleWalletPass({
      passId: 'pass-1',
      memberName: 'Asha',
      cardTitle: 'One free coffee',
      classSuffix: 'bistro_coupon',
      walletType: 'offer',
    });
    expect(result.success).toBe(true);
    const call = mockGoogleAuthClient.request.mock.calls[0][0];
    expect(call.url).toContain('/offerObject');
    expect(call.data.state).toBe('ACTIVE');

    const token = result.googleWalletUrl!.split('/save/')[1];
    const decoded = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64').toString(),
    );
    expect(decoded.payload.offerObjects).toBeDefined();
  });

  it('flips an offerObject to COMPLETED once its balance reaches 0', async () => {
    await service.updateGenericObject(
      'issuer.pass-1',
      { balance: '0' },
      'offer',
    );
    const call = mockGoogleAuthClient.request.mock.calls[0][0];
    expect(call.url).toContain('/offerObject/issuer.pass-1');
    expect(call.data.state).toBe('COMPLETED');
  });

  it('leaves an offerObject ACTIVE while balance is still positive', async () => {
    await service.updateGenericObject(
      'issuer.pass-1',
      { balance: '1' },
      'offer',
    );
    const call = mockGoogleAuthClient.request.mock.calls[0][0];
    expect(call.data.state).toBeUndefined();
  });

  it('publishes an offerClass, not a genericClass', async () => {
    await service.createGenericClass(
      {
        classSuffix: 'bistro_coupon',
        cardTitle: 'One free coffee',
        provider: 'Bistro Cafe',
      },
      'offer',
    );
    const call = mockGoogleAuthClient.request.mock.calls[0][0];
    expect(call.url).toContain('/offerClass');
    expect(call.data.redemptionChannel).toBe('INSTORE');
  });

  it('issues an eventTicketObject with seatInfo pulled from template rows', async () => {
    const result = await service.createGoogleWalletPass({
      passId: 'pass-1',
      memberName: 'Asha',
      cardTitle: 'Summer Music Fest',
      classSuffix: 'city_event',
      walletType: 'eventTicket',
      rows: [
        {
          id: 'row1',
          columns: [
            { key: 'seat', header: 'Seat', body: '12' },
            { key: 'gate', header: 'Gate', body: 'B' },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
    const call = mockGoogleAuthClient.request.mock.calls[0][0];
    expect(call.url).toContain('/eventTicketObject');
    expect(call.data.seatInfo.seat.defaultValue.value).toBe('12');
    expect(call.data.seatInfo.gate.defaultValue.value).toBe('B');
    expect(call.data.ticketHolderName).toBe('Asha');
  });

  it('publishes an eventTicketClass with eventName/venue/dateTime', async () => {
    await service.createGenericClass(
      {
        classSuffix: 'city_event',
        cardTitle: 'Summer Music Fest',
        tenantName: 'City Events Co',
        venueName: 'Central Park',
        eventStartsAt: '2026-06-01T18:00:00Z',
      },
      'eventTicket',
    );
    const call = mockGoogleAuthClient.request.mock.calls[0][0];
    expect(call.url).toContain('/eventTicketClass');
    expect(call.data.eventName.defaultValue.value).toBe('Summer Music Fest');
    expect(call.data.venue.name.defaultValue.value).toBe('Central Park');
    expect(call.data.dateTime.start).toBe('2026-06-01T18:00:00Z');
  });

  it('issues a loyaltyObject with an int points balance, never "X Pts"', async () => {
    const result = await service.createGoogleWalletPass({
      passId: 'pass-1',
      memberName: 'Asha',
      cardTitle: 'Bistro Rewards',
      classSuffix: 'bistro_loyalty',
      balance: '120',
      tier: 'Gold',
      walletType: 'loyalty',
    });
    expect(result.success).toBe(true);
    const call = mockGoogleAuthClient.request.mock.calls[0][0];
    expect(call.url).toContain('/loyaltyObject');
    expect(call.data.loyaltyPoints.balance).toEqual({ int: 120 });
    expect(call.data.accountId).toBe('pass-1');
    expect(
      call.data.textModulesData.find((m: any) => m.id === 'tier').body,
    ).toBe('Gold');

    const token = result.googleWalletUrl!.split('/save/')[1];
    const decoded = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64').toString(),
    );
    expect(decoded.payload.loyaltyObjects).toBeDefined();
  });

  it('patches loyaltyObject balance as an int on redemption', async () => {
    await service.updateGenericObject(
      'issuer.pass-1',
      { balance: '80', tier: 'Silver' },
      'loyalty',
    );
    const call = mockGoogleAuthClient.request.mock.calls[0][0];
    expect(call.url).toContain('/loyaltyObject/issuer.pass-1');
    expect(call.data.loyaltyPoints).toEqual({
      label: 'Points',
      balance: { int: 80 },
    });
    expect(call.data.textModulesData).toContainEqual({
      id: 'tier',
      header: 'Tier',
      body: 'Silver',
    });
  });

  it('publishes a loyaltyClass, not a genericClass', async () => {
    await service.createGenericClass(
      {
        classSuffix: 'bistro_loyalty',
        cardTitle: 'Bistro Rewards',
        tenantName: 'Bistro Cafe',
      },
      'loyalty',
    );
    const call = mockGoogleAuthClient.request.mock.calls[0][0];
    expect(call.url).toContain('/loyaltyClass');
    expect(call.data.programName).toBe('Bistro Rewards');
  });
});

/**
 * Phase 3 — a custom column configured with `{{balance}}` must re-render on
 * every transaction, not keep the value baked in at issuance.
 */
describe('updateGenericObject — {{token}} columns', () => {
  let service: WalletService;
  let mockGoogleAuthClient: { request: jest.Mock };

  const existingObject = {
    id: 'issuer.pass-1',
    textModulesData: [
      { id: 'balance', header: 'Points', body: '100 Pts' },
      { id: 'blurb', header: 'Status', body: '100 Pts to spend' },
      { id: 'static', header: 'Since', body: '2024' },
    ],
  };

  const patchBody = (fieldId: string) => {
    const patch = mockGoogleAuthClient.request.mock.calls.find(
      (c: any[]) => c[0].method === 'PATCH',
    )![0].data;
    return patch.textModulesData.find((m: any) => m.id === fieldId)?.body;
  };

  beforeEach(() => {
    service = new WalletService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    mockGoogleAuthClient = {
      request: jest
        .fn()
        .mockImplementation((opts: any) =>
          opts.method === 'GET'
            ? Promise.resolve({ data: existingObject })
            : Promise.resolve({ data: {} }),
        ),
    };
    jest
      .spyOn(service, 'getGoogleAuthClient')
      .mockResolvedValue(mockGoogleAuthClient as any);
  });

  it('re-renders a token column against the new balance', async () => {
    await service.updateGenericObject('issuer.pass-1', {
      balance: '450 Pts',
      templateRows: [
        {
          id: 'row1',
          columns: [
            { key: 'blurb', header: 'Status', body: '{{balance}} to spend' },
          ],
        },
      ],
      tokenContext: { balance: '450 Pts' },
    });

    expect(patchBody('blurb')).toBe('450 Pts to spend');
  });

  it('leaves a column with no token at its stored value', async () => {
    await service.updateGenericObject('issuer.pass-1', {
      balance: '450 Pts',
      templateRows: [
        {
          id: 'row1',
          columns: [{ key: 'static', header: 'Since', body: '2024' }],
        },
      ],
      tokenContext: { balance: '450 Pts' },
    });

    expect(patchBody('static')).toBe('2024');
  });

  it('still fills the reserved balance key by key, not by token', async () => {
    await service.updateGenericObject('issuer.pass-1', {
      balance: '450 Pts',
      tokenContext: { balance: '450 Pts' },
    });

    expect(patchBody('balance')).toBe('450 Pts');
  });

  it('interpolates when the rows are rebuilt from the template too', async () => {
    await service.updateGenericObject('issuer.pass-1', {
      balance: '450 Pts',
      tier: 'Gold',
      rows: [
        {
          id: 'row1',
          columns: [
            { key: 'blurb', header: 'Status', body: '{{tier}}: {{balance}}' },
          ],
        },
      ],
      tokenContext: { balance: '450 Pts', tier: 'Gold' },
    });

    expect(patchBody('blurb')).toBe('Gold: 450 Pts');
  });
});

/**
 * Phase 4 — cashier-specified redemption, and a straight answer on the
 * presets whose balance was never redeemable against a bill.
 */
describe('processOrderTransaction — direct points redemption & zero cap', () => {
  const build = (redeemCapPercent: number, redeemRate = 1, balance = 400) => {
    const supabaseServiceMock: any = {
      client: {
        from: jest.fn().mockImplementation((table: string) => {
          if (table === 'Pass') {
            return {
              select: () => ({
                eq: () => ({
                  single: async () => ({
                    data: {
                      id: 'pass-1',
                      fullPassId: 'issuer.pass-1',
                      memberId: 'member-1',
                      tenantId: 'tenant-1',
                      programId: 'program-1',
                      balance,
                      tier: 'Bronze',
                      Member: { phone: '+919876543210' },
                      Tenant: { name: 'Acme Gym' },
                    },
                  }),
                }),
              }),
              update: () => ({ eq: async () => ({ error: null }) }),
              insert: async () => ({ error: null }),
            };
          }
          if (table === 'Program') {
            return {
              select: () => ({
                eq: (_col: string, id: string) => ({
                  maybeSingle: async () => ({
                    data: {
                      id,
                      kind: 'loyalty',
                      earnRate: 1,
                      redeemRate,
                      redeemCapPercent,
                    },
                  }),
                }),
              }),
            };
          }
          if (table === 'Tier') {
            return {
              select: () => ({
                eq: () => ({ order: async () => ({ data: [] }) }),
              }),
            };
          }
          return { insert: async () => ({ error: null }) };
        }),
        rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
      },
    };

    const service = new WalletService(
      supabaseServiceMock,
      { logNotification: jest.fn() } as any,
      {
        sendRedemptionReceiptWithLog: jest.fn().mockResolvedValue(undefined),
        sendTierUpgradeMessage: jest.fn().mockResolvedValue(undefined),
      } as any,
      { record: jest.fn().mockResolvedValue(undefined) } as any,
      { dispatch: jest.fn().mockResolvedValue(undefined) } as any,
    );
    jest.spyOn(service, 'syncPassAfterTransaction').mockResolvedValue({
      walletPushed: true,
      directNotified: false,
      tier: 'Bronze',
      tierChanged: false,
    });
    return service;
  };

  it('burns exactly the points the cashier named, ignoring the cap formula', async () => {
    // The formula would allow only 50% of ₹200 = 100 points.
    const result = await build(50).processOrderTransaction(
      'pass-1',
      200,
      'redeem',
      'manual',
      undefined,
      undefined,
      undefined,
      150,
    );

    expect(result.pointsChanged).toBe(150);
    expect(result.discountApplied).toBe(150);
    expect(result.payableAmount).toBe(50);
    expect(result.newBalance).toBe(250);
  });

  it('still falls back to the cap formula when no points are named', async () => {
    const result = await build(50).processOrderTransaction(
      'pass-1',
      200,
      'redeem',
      'manual',
    );

    expect(result.pointsChanged).toBe(100);
  });

  it('refuses to burn more points than the customer holds', async () => {
    await expect(
      build(50, 1, 400).processOrderTransaction(
        'pass-1',
        5000,
        'redeem',
        'manual',
        undefined,
        undefined,
        undefined,
        401,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a discount larger than the order, which would hand back cash', async () => {
    await expect(
      build(50).processOrderTransaction(
        'pass-1',
        100,
        'redeem',
        'manual',
        undefined,
        undefined,
        undefined,
        200,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it.each([0, -5, 1.5])('rejects a pointsToRedeem of %s', async (points) => {
    await expect(
      build(50).processOrderTransaction(
        'pass-1',
        500,
        'redeem',
        'manual',
        undefined,
        undefined,
        undefined,
        points,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('tells a zero-cap program it is not redeemable, not that the order is too small', async () => {
    await expect(
      build(0).processOrderTransaction('pass-1', 5000, 'redeem', 'manual'),
    ).rejects.toThrow(/not redeemable against a bill/);
  });

  it('does not let explicit points bypass a zero cap', async () => {
    await expect(
      build(0).processOrderTransaction(
        'pass-1',
        5000,
        'redeem',
        'manual',
        undefined,
        undefined,
        undefined,
        100,
      ),
    ).rejects.toThrow(/not redeemable against a bill/);
  });

  it('keeps the "order too small" error where it is actually true', async () => {
    // 10% of ₹5 is ₹0 — a real "too small", not a non-redeemable program.
    await expect(
      build(10).processOrderTransaction('pass-1', 5, 'redeem', 'manual'),
    ).rejects.toThrow(/too small/);
  });
});

describe('processOrderTransaction — GAP-13 reward threshold', () => {
  let webhookDispatch: jest.Mock;
  let whatsappSend: jest.Mock;

  const build = (startingBalance: number) => {
    const rpcMock = jest
      .fn()
      .mockImplementation((_fn: string, args: any) =>
        Promise.resolve({ data: startingBalance + args.p_delta, error: null }),
      );
    const supabaseServiceMock: any = {
      client: { from: jest.fn(), rpc: rpcMock },
    };
    supabaseServiceMock.client.from.mockImplementation((table: string) => {
      if (table === 'Pass') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: 'pass-1',
                  fullPassId: 'issuer.pass-1',
                  memberId: 'member-1',
                  tenantId: 'tenant-1',
                  programId: 'program-stamp',
                  balance: startingBalance,
                  tier: 'Member',
                  Member: { phone: '+919876543210' },
                  Tenant: { name: 'BeanHouse' },
                },
              }),
            }),
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
          insert: async () => ({ error: null }),
        };
      }
      if (table === 'Program') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: 'program-stamp',
                  kind: 'loyalty',
                  earnRate: 1,
                  redeemRate: 1,
                  redeemCapPercent: 100,
                  visitMode: true,
                  rewardThreshold: 10,
                },
              }),
            }),
          }),
        };
      }
      if (table === 'Tier') {
        return {
          select: () => ({ eq: () => ({ order: async () => ({ data: [] }) }) }),
        };
      }
      return { insert: async () => ({ error: null }) };
    });

    webhookDispatch = jest.fn().mockResolvedValue(undefined);
    whatsappSend = jest.fn().mockResolvedValue(undefined);
    const service = new WalletService(
      supabaseServiceMock,
      { logNotification: jest.fn() } as any,
      {
        sendRedemptionReceiptWithLog: jest.fn().mockResolvedValue(undefined),
        sendTierUpgradeMessage: jest.fn().mockResolvedValue(undefined),
        sendTextWithLog: whatsappSend,
      } as any,
      { record: jest.fn().mockResolvedValue(undefined) } as any,
      { dispatch: webhookDispatch } as any,
    );
    jest.spyOn(service, 'syncPassAfterTransaction').mockResolvedValue({
      walletPushed: true,
      directNotified: false,
      tier: 'Member',
      tierChanged: false,
    });
    return service;
  };

  it('fires reward.unlocked and a WhatsApp message the instant balance crosses the threshold', async () => {
    const svc = build(9); // 9 stamps already
    await svc.processOrderTransaction('pass-1', 1, 'award', 'manual');

    expect(webhookDispatch).toHaveBeenCalledWith(
      'tenant-1',
      'reward.unlocked',
      expect.objectContaining({
        passId: 'pass-1',
        threshold: 10,
        newBalance: 10,
      }),
    );
    expect(whatsappSend).toHaveBeenCalledTimes(1);
  });

  it('does not fire again on a later scan once already past the threshold', async () => {
    const svc = build(12); // already past 10
    await svc.processOrderTransaction('pass-1', 1, 'award', 'manual');

    expect(webhookDispatch).not.toHaveBeenCalledWith(
      'tenant-1',
      'reward.unlocked',
      expect.anything(),
    );
    expect(whatsappSend).not.toHaveBeenCalled();
  });

  it('does not fire before the threshold is reached', async () => {
    const svc = build(5);
    await svc.processOrderTransaction('pass-1', 1, 'award', 'manual');

    expect(webhookDispatch).not.toHaveBeenCalledWith(
      'tenant-1',
      'reward.unlocked',
      expect.anything(),
    );
  });
});
