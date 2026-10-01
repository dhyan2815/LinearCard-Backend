import { TemplatesService } from './templates.service';

describe('TemplatesService.publish — cardTitle', () => {
  let service: TemplatesService;
  let mockSupabaseService: any;
  let mockWalletService: any;
  let createGenericClassCalls: any[];

  beforeEach(() => {
    createGenericClassCalls = [];
    mockSupabaseService = {
      client: {
        from: jest.fn((table: string) => {
          if (table === 'PassTemplate') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    single: async () => ({
                      data: {
                        id: 'tpl-1',
                        tenantId: 'tenant-1',
                        title: 'Gift Card',
                        fieldRows: [],
                        googleClassIds: {},
                        tenant: { name: 'Bistro Cafe' },
                      },
                    }),
                  }),
                }),
              }),
              update: () => ({
                eq: () => ({
                  eq: () => ({
                    select: () => ({ single: async () => ({ data: null }) }),
                  }),
                }),
              }),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
      },
    };
    mockWalletService = {
      forTenant: async () => ({
        getWalletEnvPrefix: () => 'dev',
        createGenericClass: async (data: any) => {
          createGenericClassCalls.push(data);
          return { id: 'issuer.dev_class', existing: false, updated: true };
        },
        patchClassLocations: async () => ({}),
      }),
      storeLocationsForProgram: async () => [],
    };
    service = new TemplatesService(mockSupabaseService, mockWalletService);
  });

  it('combines tenant name and template title when publishing a class', async () => {
    await service.publish('tpl-1', 'tenant-1');
    expect(createGenericClassCalls[0].cardTitle).toBe(
      'Bistro Cafe · Gift Card',
    );
  });
});

describe('TemplatesService.resyncPasses — program scoping', () => {
  let service: TemplatesService;
  let mockSupabaseService: any;
  let mockWalletService: any;
  let passQueryFilters: Record<string, any>;
  let updateGenericObjectCalls: any[];

  beforeEach(() => {
    passQueryFilters = {};
    updateGenericObjectCalls = [];
    mockSupabaseService = {
      client: {
        from: jest.fn((table: string) => {
          if (table === 'PassTemplate') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    single: async () => ({
                      data: {
                        id: 'tpl-1',
                        tenantId: 'tenant-1',
                        programId: 'prog-gift-card',
                        title: 'Gift Card',
                        fieldRows: [],
                        tenant: { name: 'Bistro Cafe' },
                      },
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'Pass') {
            const query: any = {
              select: () => query,
              eq: (col: string, val: any) => {
                passQueryFilters[col] = val;
                return query;
              },
              is: (col: string, val: any) => {
                passQueryFilters[col] = val;
                return query;
              },
              then: (resolve: any) => {
                resolve({
                  data: [{ id: 'pass-1', fullPassId: 'issuer.pass-1' }],
                  error: null,
                });
              },
            };
            return query;
          }
          if (table === 'Program') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({
                      data: { walletType: 'generic' },
                    }),
                  }),
                }),
              }),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
      },
    };
    mockWalletService = {
      forTenant: async () => ({
        updateGenericObject: async (passId: string, data: any) => {
          updateGenericObjectCalls.push({ passId, data });
          return {};
        },
      }),
    };
    service = new TemplatesService(mockSupabaseService, mockWalletService);
  });

  it('scopes the resync query to the template’s own programId', async () => {
    await service.resyncPasses('tenant-1', 'tpl-1');
    expect(passQueryFilters.programId).toBe('prog-gift-card');
  });

  it('includes the combined cardTitle in each pushed update', async () => {
    await service.resyncPasses('tenant-1', 'tpl-1');
    expect(updateGenericObjectCalls[0].data.cardTitle).toBe(
      'Bistro Cafe · Gift Card',
    );
  });
});
