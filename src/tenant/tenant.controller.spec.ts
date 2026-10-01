import { Test, TestingModule } from '@nestjs/testing';
import { TenantController } from './tenant.controller';
import { SupabaseService } from '../supabase/supabase.service';
import { TenantGuard } from '../auth/tenant.guard';

describe('TenantController.getTenants', () => {
  let controller: TenantController;
  let selectMock: jest.Mock;

  beforeEach(async () => {
    selectMock = jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        order: jest
          .fn()
          .mockResolvedValue({ data: [{ id: 't1' }], error: null }),
      }),
    });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TenantController],
      providers: [
        {
          provide: SupabaseService,
          useValue: { client: { from: () => ({ select: selectMock }) } },
        },
        { provide: TenantGuard, useValue: { canActivate: () => true } },
      ],
    }).compile();

    controller = module.get<TenantController>(TenantController);
  });

  it('is guarded by TenantGuard', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      TenantController.prototype.getTenants,
    );
    expect(guards).toEqual([TenantGuard]);
  });

  it('never selects credential, business-detail or legacy apiKey columns', async () => {
    await controller.getTenants({ tenantId: 'test-tenant' } as any);

    const columns: string = selectMock.mock.calls[0][0];
    expect(columns).not.toContain('*');
    for (const secret of [
      'apiKey',
      'issuerId',
      'googleClientEmail',
      'googlePrivateKeyEncrypted',
      'businessDetails',
    ]) {
      expect(columns).not.toContain(secret);
    }
    // Still returns what the dashboard tenant switcher needs.
    for (const needed of ['id', 'name', 'brandHexColor', 'classSuffix']) {
      expect(columns).toContain(needed);
    }
  });
});
