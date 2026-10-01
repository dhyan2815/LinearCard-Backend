import { Test, TestingModule } from '@nestjs/testing';
import { DashboardController } from './dashboard.controller';
import { SupabaseService } from '../supabase/supabase.service';
import { WalletService } from '../wallet/wallet.service';
import { TenantGuard } from '../auth/tenant.guard';

describe('DashboardController.getstats', () => {
  let controller: DashboardController;
  let eqCalls: Array<[string, any]>;
  let forTenantMock: jest.Mock;

  const makeQuery = (rows: any[] | null) => {
    const q: any = {
      select: () => q,
      is: () => q,
      eq: (col: string, val: any) => {
        eqCalls.push([col, val]);
        return q;
      },
      // Awaited directly by the controller.
      then: (resolve: any) =>
        resolve({ count: rows ? rows.length : 0, data: rows }),
    };
    return q;
  };

  beforeEach(async () => {
    eqCalls = [];
    forTenantMock = jest.fn().mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DashboardController],
      providers: [
        {
          provide: SupabaseService,
          useValue: {
            client: {
              from: (table: string) =>
                makeQuery(table === 'Pass' ? [{ tier: 'Gold' }] : [{}, {}]),
            },
          },
        },
        { provide: WalletService, useValue: { forTenant: forTenantMock } },
        { provide: TenantGuard, useValue: { canActivate: () => true } },
      ],
    }).compile();

    controller = module.get<DashboardController>(DashboardController);
  });

  it('is guarded by TenantGuard', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      DashboardController.prototype.getstats,
    );
    expect(guards).toEqual([TenantGuard]);
  });

  it('scopes every aggregate query to the guard-resolved tenant', async () => {
    const res: any = await controller.getstats({ tenantId: 't1' } as any);

    expect(res.success).toBe(true);
    expect(eqCalls).toHaveLength(3);
    expect(
      eqCalls.every(([col, val]) => col === 'tenantId' && val === 't1'),
    ).toBe(true);
    expect(res.tierDistribution).toEqual({ Gold: 1 });
  });

  it('reports google connectivity via per-tenant credential resolution', async () => {
    const connected: any = await controller.getstats({ tenantId: 't1' } as any);
    expect(forTenantMock).toHaveBeenCalledWith('t1');
    expect(connected.walletStatus.google).toBe('connected');

    forTenantMock.mockRejectedValueOnce(new Error('no credentials'));
    const missing: any = await controller.getstats({ tenantId: 't1' } as any);
    expect(missing.walletStatus.google).toBe('not_configured');
  });
});
