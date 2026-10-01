import { Test, TestingModule } from '@nestjs/testing';
import { TemplatesController } from './templates.controller';
import { SupabaseService } from '../supabase/supabase.service';
import { WalletService } from '../wallet/wallet.service';
import { TemplatesService } from './templates.service';

import { TenantGuard } from '../auth/tenant.guard';

describe('TemplatesController.updateTemplate', () => {
  let controller: TemplatesController;
  let mockUpdatePayload: any;
  let mockUpdatedRecord: any;
  let updateMock: jest.Mock;
  let supabaseServiceMock: any;

  beforeEach(async () => {
    mockUpdatedRecord = {
      id: 'tmpl-123',
      title: 'Updated Title',
    };

    updateMock = jest.fn().mockImplementation((payload) => {
      mockUpdatePayload = payload;
      return {
        eq: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              single: jest.fn().mockImplementation(() =>
                Promise.resolve({
                  data: mockUpdatedRecord,
                  error: null,
                }),
              ),
            }),
          }),
        }),
      };
    });

    supabaseServiceMock = {
      client: {
        from: jest.fn().mockImplementation(() => ({
          update: updateMock,
        })),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TemplatesController],
      providers: [
        { provide: SupabaseService, useValue: supabaseServiceMock },
        { provide: WalletService, useValue: {} },
        { provide: TemplatesService, useValue: {} },
      ],
    }).compile();

    controller = module.get<TemplatesController>(TemplatesController);
  });

  it('should update template fields and map name to title', async () => {
    const body = {
      name: 'Updated Title',
    };

    const res = await (controller as any).updateTemplate('tmpl-123', body, {
      tenantId: 'tenant-1',
    });

    expect(mockUpdatePayload).toEqual(
      expect.objectContaining({
        title: 'Updated Title',
        updatedAt: expect.any(String),
      }),
    );
    expect(res).toEqual({
      success: true,
      template: {
        ...mockUpdatedRecord,
        name: 'Updated Title',
      },
    });
  });

  it('should throw 404 if template not found', async () => {
    mockUpdatedRecord = null;
    await expect(
      (controller as any).updateTemplate(
        'tmpl-123',
        {
          name: 'Nonexistent',
        },
        { tenantId: 'tenant-1' },
      ),
    ).rejects.toMatchObject({
      status: 404,
      response: { success: false, error: 'Template not found' },
    });
  });

  describe('updateTemplate — hexBackgroundColor validation', () => {
    it('rejects a malformed hex code', async () => {
      await expect(
        controller.updateTemplate(
          'template-1',
          { hexBackgroundColor: '#GGGGGG' },
          { tenantId: 'tenant-1' } as any,
        ),
      ).rejects.toThrow('hexBackgroundColor must be a 6-digit hex code');
    });

    it('rejects a non-hex color name', async () => {
      await expect(
        controller.updateTemplate('template-1', { hexBackgroundColor: 'red' }, {
          tenantId: 'tenant-1',
        } as any),
      ).rejects.toThrow('hexBackgroundColor must be a 6-digit hex code');
    });

    it('accepts and uppercases a valid lowercase hex code', async () => {
      const result = await controller.updateTemplate(
        'template-1',
        { hexBackgroundColor: '#7c3aed' },
        { tenantId: 'tenant-1' } as any,
      );
      expect(result.success).toBe(true);
      expect(mockUpdatePayload).toEqual(
        expect.objectContaining({ hexBackgroundColor: '#7C3AED' }),
      );
    });
  });

  // storeLocations validation lives on ProgramsController.updateProgram now
  // (see programs.controller.ts), not on TemplatesController.updateTemplate.
  // A body.storeLocations here is simply ignored (not persisted).
  it('ignores a storeLocations field on the template update body', async () => {
    const result = await controller.updateTemplate(
      'template-1',
      { storeLocations: [{ latitude: 19.076, longitude: 72.8777 }] },
      { tenantId: 'tenant-1' } as any,
    );
    expect(result.success).toBe(true);
    expect(mockUpdatePayload).not.toHaveProperty('storeLocations');
  });
});

// Phase 4.1 — the class-inspection endpoint exists to answer one question
// ("did the geofences and the callback actually land on Google?"), so the
// check is that it reports a mismatch rather than a cheerful success.
describe('TemplatesController.getWalletClass', () => {
  const build = async (template: any, walletClass: any) => {
    const supabaseServiceMock = {
      client: {
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                single: jest
                  .fn()
                  .mockResolvedValue({ data: template, error: null }),
              }),
            }),
          }),
        }),
      },
    };
    const walletServiceMock = {
      forTenant: jest.fn().mockResolvedValue({
        getGenericClass: jest.fn().mockResolvedValue(walletClass),
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TemplatesController],
      providers: [
        { provide: SupabaseService, useValue: supabaseServiceMock },
        { provide: WalletService, useValue: walletServiceMock },
        { provide: TemplatesService, useValue: {} },
      ],
    }).compile();
    return module.get<TemplatesController>(TemplatesController);
  };

  it('flags a geofence mismatch and a localhost callback', async () => {
    const controller = await build(
      { id: 't1', classSuffix: 'acme', storeLocations: [{}, {}] },
      {
        id: 'iss.dev_acme',
        merchantLocations: [],
        callbackOptions: { url: 'http://localhost:3001/passes/webhooks' },
      },
    );
    const res: any = await controller.getWalletClass('t1', {
      tenantId: 'tenant-1',
    } as any);
    expect(res.geofenceCount).toBe(0);
    expect(res.expectedGeofenceCount).toBe(2);
    expect(res.callbackIsLocalhost).toBe(true);
  });

  it('reports a healthy class', async () => {
    const controller = await build(
      { id: 't1', classSuffix: 'acme', storeLocations: [{}] },
      {
        id: 'iss.acme',
        merchantLocations: [{ latitude: 1, longitude: 2 }],
        callbackOptions: { url: 'https://api.example.com/passes/webhooks' },
      },
    );
    const res: any = await controller.getWalletClass('t1', {
      tenantId: 'tenant-1',
    } as any);
    expect(res.geofenceCount).toBe(1);
    expect(res.callbackIsLocalhost).toBe(false);
  });

  it('returns exists:false when the class is not on Google yet', async () => {
    const controller = await build(
      { id: 't1', classSuffix: 'acme', storeLocations: [{}] },
      null,
    );
    const res: any = await controller.getWalletClass('t1', {
      tenantId: 'tenant-1',
    } as any);
    expect(res.exists).toBe(false);
    expect(res.expectedGeofenceCount).toBe(1);
  });
});

describe('TemplatesController — tenant scoping on :id routes', () => {
  let controller: TemplatesController;
  let eqSpy: jest.Mock;
  let singleResult: { data: any; error: any };
  let supabaseServiceMock: any;

  beforeEach(async () => {
    singleResult = { data: null, error: null };
    // select('*').eq('id', id).eq('tenantId', tenantId).single()
    const selectChain = {
      eq: jest.fn(),
    };
    eqSpy = jest.fn().mockImplementation((field: string, value: string) => {
      selectChain[`__${field}`] = value;
      return {
        eq: jest.fn().mockImplementation((field2: string, value2: string) => {
          selectChain[`__${field2}`] = value2;
          return {
            single: jest
              .fn()
              .mockImplementation(() => Promise.resolve(singleResult)),
          };
        }),
      };
    });

    supabaseServiceMock = {
      client: {
        from: jest.fn().mockImplementation(() => ({
          select: jest.fn().mockImplementation(() => ({ eq: eqSpy })),
        })),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TemplatesController],
      providers: [
        { provide: SupabaseService, useValue: supabaseServiceMock },
        { provide: WalletService, useValue: {} },
        { provide: TemplatesService, useValue: {} },
      ],
    }).compile();

    controller = module.get<TemplatesController>(TemplatesController);
  });

  it("filters the lookup by tenantId, so a foreign tenantId returns 404 instead of another tenant's template", async () => {
    // The mocked query returns no row (as Supabase would when the eq('tenantId', ...)
    // filter excludes the row), proving the controller does not fetch by id alone.
    singleResult = { data: null, error: null };

    await expect(
      controller.getTemplateById('template-1', {
        tenantId: 'attacker-tenant',
      } as any),
    ).rejects.toMatchObject({ status: 404 });

    expect(eqSpy).toHaveBeenCalledWith('id', 'template-1');
  });

  it('returns the template when it belongs to the requesting tenant', async () => {
    singleResult = {
      data: { id: 'template-1', tenantId: 'tenant-1', title: 'Mine' },
      error: null,
    };

    const result = await controller.getTemplateById('template-1', {
      tenantId: 'tenant-1',
    } as any);

    expect(result.success).toBe(true);
    expect(result.template.name).toBe('Mine');
  });
});

describe('TemplatesController.createTemplate', () => {
  let controller: TemplatesController;
  let mockInsertPayload: any;
  let mockInsertedRecord: any;
  let insertMock: jest.Mock;
  let supabaseServiceMock: any;

  beforeEach(async () => {
    mockInsertedRecord = {
      id: 'tmpl-new',
      title: 'New Template',
    };

    insertMock = jest.fn().mockImplementation((payload) => {
      mockInsertPayload = payload;
      return {
        select: jest.fn().mockReturnValue({
          single: jest
            .fn()
            .mockImplementation(() =>
              Promise.resolve({ data: mockInsertedRecord, error: null }),
            ),
        }),
      };
    });

    supabaseServiceMock = {
      client: {
        from: jest.fn().mockImplementation(() => ({
          insert: insertMock,
        })),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TemplatesController],
      providers: [
        { provide: SupabaseService, useValue: supabaseServiceMock },
        { provide: WalletService, useValue: {} },
        { provide: TemplatesService, useValue: {} },
      ],
    }).compile();

    controller = module.get<TemplatesController>(TemplatesController);
  });

  it('attaches the template to its program on create (DB-5)', async () => {
    await controller.createTemplate(
      { name: 'New Template', programId: 'program-1' },
      { tenantId: 'tenant-1' } as any,
    );

    expect(mockInsertPayload).toEqual(
      expect.objectContaining({ programId: 'program-1' }),
    );
  });

  it('rejects a malformed hexBackgroundColor on create', async () => {
    await expect(
      controller.createTemplate(
        { name: 'New Template', hexBackgroundColor: 'red' },
        { tenantId: 'tenant-1' } as any,
      ),
    ).rejects.toThrow('hexBackgroundColor must be a 6-digit hex code');
  });
});

describe('TemplatesController collection-route tenant scoping', () => {
  it('guards both collection routes with TenantGuard', () => {
    expect(
      Reflect.getMetadata(
        '__guards__',
        TemplatesController.prototype.getTemplates,
      ),
    ).toEqual([TenantGuard]);
    expect(
      Reflect.getMetadata(
        '__guards__',
        TemplatesController.prototype.createTemplate,
      ),
    ).toEqual([TenantGuard]);
  });

  it('getTemplates filters by the guard tenant, not a query param', async () => {
    const eqMock = jest.fn().mockReturnValue({
      order: jest.fn().mockResolvedValue({ data: [], error: null }),
    });
    const controller = new TemplatesController(
      { client: { from: () => ({ select: () => ({ eq: eqMock }) }) } } as any,
      {} as any,
      {} as any,
    );

    await controller.getTemplates({ tenantId: 'guard-tenant' } as any);

    expect(eqMock).toHaveBeenCalledWith('tenantId', 'guard-tenant');
  });

  it('createTemplate ignores a caller-supplied body.tenantId', async () => {
    let payload: any;
    const controller = new TemplatesController(
      {
        client: {
          from: () => ({
            insert: (p: any) => {
              payload = p;
              return {
                select: () => ({
                  single: async () => ({
                    data: { id: 'x', title: 'T' },
                    error: null,
                  }),
                }),
              };
            },
          }),
        },
      } as any,
      {} as any,
      {} as any,
    );

    await controller.createTemplate(
      { name: 'T', tenantId: 'attacker-tenant' },
      {
        tenantId: 'guard-tenant',
      } as any,
    );

    expect(payload.tenantId).toBe('guard-tenant');
  });
});

describe('TemplatesController.previewPass — cardTitle', () => {
  let controller: TemplatesController;
  let createGenericClassCalls: any[];
  let mockWalletService: any;

  beforeEach(async () => {
    createGenericClassCalls = [];
    const supabaseServiceMock = {
      client: {
        from: jest.fn().mockImplementation((table: string) => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({
                  data: {
                    id: 'tpl-1',
                    programId: 'prog-1',
                    fieldRows: [],
                    tenant: { name: 'Bistro Cafe' },
                    title: 'Gift Card',
                  },
                }),
                maybeSingle: async () =>
                  table === 'Program'
                    ? { data: { walletType: 'generic' } }
                    : { data: null },
              }),
            }),
          }),
        })),
      },
    };
    mockWalletService = {
      forTenant: async () => ({
        createGenericClass: async (data: any) => {
          createGenericClassCalls.push(data);
          return { id: 'issuer.dev_prog-1_preview' };
        },
        createGoogleWalletPass: async () => ({
          googleWalletUrl: 'https://pay.google.com/gp/v/save/token',
          passId: 'preview_tpl-1',
        }),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TemplatesController],
      providers: [
        { provide: SupabaseService, useValue: supabaseServiceMock },
        { provide: WalletService, useValue: mockWalletService },
        { provide: TemplatesService, useValue: {} },
      ],
    }).compile();

    controller = module.get<TemplatesController>(TemplatesController);
  });

  it('combines tenant name and template title for the preview class', async () => {
    await controller.previewPass('tpl-1', { tenantId: 'tenant-1' } as any);
    expect(createGenericClassCalls[0].cardTitle).toBe(
      'Bistro Cafe · Gift Card',
    );
  });
});
