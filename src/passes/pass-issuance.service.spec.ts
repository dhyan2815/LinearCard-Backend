import { PassIssuanceService } from './pass-issuance.service';

describe('PassIssuanceService.issueForMember — dynamic field rows', () => {
  let service: PassIssuanceService;
  let mockSupabaseService: any;
  let mockWalletService: any;
  let createGoogleWalletPassCalls: any[];
  let passInserts: any[];

  const giftCardFieldRows = [
    {
      id: 'row1',
      columns: [
        { key: 'balance', header: 'Balance', body: '0' },
        { key: 'card', header: 'Card', body: '—' },
      ],
    },
  ];

  beforeEach(() => {
    createGoogleWalletPassCalls = [];
    passInserts = [];
    mockSupabaseService = {
      client: {
        from: jest.fn().mockImplementation((table: string) => {
          if (table === 'Tier') {
            return {
              select: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () => ({
                      maybeSingle: async () => ({ data: null }),
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'Pass') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    is: () => ({
                      eq: () => ({
                        order: () => ({
                          limit: () => ({
                            maybeSingle: async () => ({ data: null }),
                          }),
                        }),
                      }),
                      order: () => ({
                        limit: () => ({
                          maybeSingle: async () => ({ data: null }),
                        }),
                      }),
                    }),
                  }),
                }),
              }),
              insert: (payload: any) => {
                passInserts.push(payload);
                return {
                  select: () => ({
                    single: async () => ({
                      data: { id: 'pass-1' },
                      error: null,
                    }),
                  }),
                };
              },
            };
          }
          if (table === 'Program') {
            return {
              select: () => ({
                eq: () => ({ maybeSingle: async () => ({ data: null }) }),
              }),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
      },
    };
    mockWalletService = {
      resolveTenantPassDesign: async () => ({
        hexBackgroundColor: '#123456',
        cardTitle: 'Bistro Cafe · Gift Card',
        classSuffix: 'bistro_cafe_gift_card',
        fieldRows: giftCardFieldRows,
      }),
      forTenant: async () => ({
        buildSaveLink: () => ({
          token: 't',
          googleWalletUrl: 'https://pay.google.com/gp/v/save/t',
        }),
        createGoogleWalletPass: async (data: any) => {
          createGoogleWalletPassCalls.push(data);
          return {
            success: true,
            fullPassId: 'issuer.pass-1',
            googleWalletUrl: 'https://pay.google.com/gp/v/save/t',
          };
        },
      }),
    };
    service = new PassIssuanceService(
      mockSupabaseService,
      mockWalletService,
      { sendPassLinkWithLog: async () => {} } as any,
      { dispatch: () => ({ catch: () => {} }) } as any,
    );
  });

  it('forwards the template design fieldRows as rows on the created pass', async () => {
    await service.issueForMember({
      tenantId: 'tenant-1',
      member: { id: 'member-1', phone: '+911234567890' },
      program: { id: 'prog-1' },
      tenant: { name: 'Bistro Cafe' },
      sendPassLink: false,
    });

    expect(createGoogleWalletPassCalls[0].rows).toBe(giftCardFieldRows);
  });

  it('lets an explicit passData.rows override the template design', async () => {
    const customRows = [
      { id: 'row1', columns: [{ key: 'custom', header: 'Custom', body: 'x' }] },
    ];
    await service.issueForMember({
      tenantId: 'tenant-1',
      member: { id: 'member-1', phone: '+911234567890' },
      program: { id: 'prog-1' },
      tenant: { name: 'Bistro Cafe' },
      passData: { rows: customRows },
      sendPassLink: false,
    });

    expect(createGoogleWalletPassCalls[0].rows).toBe(customRows);
  });

  it('omits tier and balance for tier-less programs', async () => {
    await service.issueForMember({
      tenantId: 'tenant-1',
      member: { id: 'member-1', phone: '+911234567890' },
      program: { id: 'prog-1' },
      tenant: { name: 'Bistro Cafe' },
      sendPassLink: false,
    });

    const callArgs = createGoogleWalletPassCalls[0];
    expect(callArgs.tier).toBeUndefined();
    expect(callArgs.balance).toBeUndefined();
    expect(callArgs.barcodeAltText).toBeUndefined();
  });

  // Phase 2 — a gift card sold with value on it must not land in the DB at 0.
  it('persists an initial balance when the pass is issued with one', async () => {
    await service.issueForMember({
      tenantId: 'tenant-1',
      member: { id: 'member-1', phone: '+911234567890' },
      program: { id: 'prog-1' },
      tenant: { name: 'Bistro Cafe' },
      passData: { tier: 'Member', balance: '₹500' },
      sendPassLink: false,
    });

    expect(passInserts[0].balance).toBe(500);
  });

  // Phase 6 — the defect: every enrolled member's ticket showed the same
  // static placeholder because nothing per-member was ever captured.
  it('renders the member’s own enrollment answers into the pass rows', async () => {
    mockWalletService.resolveTenantPassDesign = async () => ({
      hexBackgroundColor: '#123456',
      cardTitle: 'Arena · Ticket',
      classSuffix: 'arena_ticket',
      fieldRows: [
        {
          id: 'row1',
          columns: [
            { key: 'seat', header: 'Seat', body: '{{seat}}' },
            { key: 'gate', header: 'Gate', body: '{{gate}}' },
          ],
        },
      ],
    });

    await service.issueForMember({
      tenantId: 'tenant-1',
      member: { id: 'member-1', phone: '+911234567890' },
      program: { id: 'prog-1' },
      tenant: { name: 'Sunburn Arena' },
      customAttributes: { seat: '12A', gate: 'B' },
      sendPassLink: false,
    });

    const cols = createGoogleWalletPassCalls[0].rows[0].columns;
    expect(cols[0].body).toBe('12A');
    expect(cols[1].body).toBe('B');
  });

  it('persists customAttributes on the Pass row', async () => {
    await service.issueForMember({
      tenantId: 'tenant-1',
      member: { id: 'member-1', phone: '+911234567890' },
      program: { id: 'prog-1' },
      tenant: { name: 'Sunburn Arena' },
      customAttributes: { seat: '12A' },
      sendPassLink: false,
    });

    expect(passInserts[0].customAttributes).toEqual({ seat: '12A' });
  });

  it('defaults customAttributes to an empty object when none are captured', async () => {
    await service.issueForMember({
      tenantId: 'tenant-1',
      member: { id: 'member-1', phone: '+911234567890' },
      program: { id: 'prog-1' },
      tenant: { name: 'Bistro Cafe' },
      sendPassLink: false,
    });

    expect(passInserts[0].customAttributes).toEqual({});
  });

  it('defaults the persisted balance to 0 when none is provided', async () => {
    await service.issueForMember({
      tenantId: 'tenant-1',
      member: { id: 'member-1', phone: '+911234567890' },
      program: { id: 'prog-1' },
      tenant: { name: 'Bistro Cafe' },
      passData: { tier: 'Member' },
      sendPassLink: false,
    });

    expect(passInserts[0].balance).toBe(0);
  });
});
