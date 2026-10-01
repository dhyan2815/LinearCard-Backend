import { PController } from './p.controller';

describe('PController.redirectPass — dynamic field rows', () => {
  let controller: PController;
  let createGoogleWalletPassCalls: any[];

  const fieldRows = [
    { id: 'row1', columns: [{ key: 'balance', header: 'Balance', body: '0' }] },
  ];

  beforeEach(() => {
    createGoogleWalletPassCalls = [];
    const mockSupabaseService = {
      client: {
        from: jest.fn().mockImplementation(() => ({
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: 'pass-1',
                  fullPassId: 'issuer.pass-1',
                  balance: 0,
                  tier: 'Member',
                  tenantId: 'tenant-1',
                  programId: 'prog-1',
                  member: { name: 'Aniket Sharma', phone: '+911234567890' },
                  tenant: { name: 'Bistro Cafe', classSuffix: 'bistro' },
                },
              }),
            }),
          }),
        })),
      },
    };
    const mockWalletService = {
      resolveTenantPassDesign: async () => ({
        hexBackgroundColor: '#123456',
        cardTitle: 'Bistro Cafe · Gift Card',
        classSuffix: 'bistro_cafe_gift_card',
        fieldRows,
      }),
      forTenant: async () => ({
        createGoogleWalletPass: async (data: any) => {
          createGoogleWalletPassCalls.push(data);
          return {
            success: true,
            googleWalletUrl: 'https://pay.google.com/gp/v/save/t',
          };
        },
      }),
    };
    controller = new PController(
      mockSupabaseService as any,
      mockWalletService as any,
    );
  });

  it('forwards the template design fieldRows when re-minting a save link', async () => {
    const res = { redirect: jest.fn() } as any;
    await controller.redirectPass('pass-1', res);
    expect(createGoogleWalletPassCalls[0].rows).toBe(fieldRows);
  });
});
