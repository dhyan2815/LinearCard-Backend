/**
 * Phase 1 — "One Flow, Undeniable".
 * One assertion per defect the phase closed.
 */
process.env.PUBLIC_CALLBACK_URL = 'https://api.test.linearcard.example';

import {
  WalletService,
  resolveLoyaltyRules,
  DEFAULT_LOYALTY_RULES,
} from './wallet/wallet.service';
import { TemplatesController } from './templates/templates.controller';
import { MembersController } from './members/members.controller';
import { TenantGuard } from './auth/tenant.guard';

const makeService = (supabase: any = { client: {} }) =>
  new WalletService(
    supabase,
    { logNotification: jest.fn() } as any,
    {
      sendRedemptionReceiptWithLog: jest.fn().mockResolvedValue(undefined),
      sendTierUpgradeMessage: jest.fn().mockResolvedValue(undefined),
    } as any,
    { record: jest.fn().mockResolvedValue(undefined) } as any,
    { dispatch: jest.fn().mockResolvedValue(undefined) } as any,
  );

describe('Phase 1.2 — WAL-1: field updates bind to the stable key', () => {
  const liveObject = {
    textModulesData: [
      // The designer renamed "Points" to "Stars" and "Tier" to "Level".
      { id: 'points', header: 'Stars', body: '100 Pts' },
      { id: 'tier', header: 'Level', body: 'Bronze' },
      {
        id: 'field_custom',
        header: 'Points earned this year',
        body: 'untouched',
      },
    ],
    barcode: { type: 'QR_CODE', value: 'x' },
  };

  const patchFor = async (updateData: any) => {
    const service = makeService();
    const request = jest.fn(async (opts: any) =>
      opts.method === 'GET' ? { data: liveObject } : { data: {} },
    );
    jest
      .spyOn(service, 'getGoogleAuthClient')
      .mockResolvedValue({ request } as any);
    await service.updateGenericObject('issuer.pass-1', updateData);
    return request.mock.calls.find((c) => c[0].method === 'PATCH')![0].data;
  };

  it('updates balance and tier after their display headers were renamed', async () => {
    const patch = await patchFor({ balance: 250, tier: 'Gold' });
    const byId = Object.fromEntries(
      patch.textModulesData.map((m: any) => [m.id, m.body]),
    );

    expect(byId.points).toBe('250 Pts');
    expect(byId.tier).toBe('Gold');
  });

  it('never writes into a field whose header merely mentions "points"', async () => {
    const patch = await patchFor({ balance: 250 });
    const custom = patch.textModulesData.find(
      (m: any) => m.id === 'field_custom',
    );

    expect(custom.body).toBe('untouched');
  });
});

describe('Phase 1.3 — WAL-4: loyalty economics are per template', () => {
  it('falls back to the historical 10% / 1:₹1 / 50% rules', () => {
    expect(resolveLoyaltyRules(undefined)).toEqual(DEFAULT_LOYALTY_RULES);
    expect(resolveLoyaltyRules([{ status: 'draft' }])).toEqual(
      DEFAULT_LOYALTY_RULES,
    );
  });

  it('prefers the most recently updated published template', () => {
    const rules = resolveLoyaltyRules([
      { status: 'draft', earnRate: 9, redeemRate: 9, redeemCapPercent: 99 },
      {
        status: 'published',
        updatedAt: '2026-01-01',
        earnRate: 0.05,
        redeemRate: 2,
        redeemCapPercent: 20,
      },
      {
        status: 'published',
        updatedAt: '2026-06-01',
        earnRate: 0.2,
        redeemRate: 0.5,
        redeemCapPercent: 30,
      },
    ]);

    expect(rules).toEqual({
      earnRate: 0.2,
      redeemRate: 0.5,
      redeemCapPercent: 30,
      visitMode: false,
      rewardThreshold: null,
    });
  });

  it("awards and caps redemption using the template's own rates", async () => {
    const template = {
      status: 'published',
      earnRate: 0.2,
      redeemRate: 2,
      redeemCapPercent: 25,
    };
    const pass = {
      id: '11111111-1111-1111-1111-111111111111',
      fullPassId: 'issuer.pass-1',
      memberId: 'member-1',
      tenantId: 'tenant-1',
      balance: 1000,
      tier: 'Bronze',
      Member: { phone: '+910000000000' },
      Tenant: { name: 'Acme', PassTemplate: [template] },
    };
    const run = async (type: 'award' | 'redeem') => {
      const service = makeService({
        client: {
          from: (table: string) =>
            table === 'Pass'
              ? {
                  select: () => ({
                    eq: () => ({ single: async () => ({ data: pass }) }),
                  }),
                }
              : {
                  select: () => ({
                    eq: () => ({
                      order: () => ({
                        limit: () => ({
                          maybeSingle: async () => ({ data: null }),
                        }),
                      }),
                    }),
                  }),
                  insert: async () => ({ error: null }),
                },
          rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
        },
      });
      jest.spyOn(service, 'syncPassAfterTransaction').mockResolvedValue({
        walletPushed: true,
        directNotified: false,
        tier: 'Bronze',
        tierChanged: false,
      });
      return service.processOrderTransaction(pass.id, 1000, type, 'manual');
    };

    // 20% of ₹1000 = 200 pts, not the hardcoded 100.
    await expect(run('award')).resolves.toMatchObject({ pointsChanged: 200 });
    // Cap is 25% of ₹1000 = ₹250, and each point buys ₹2 ⇒ 125 points.
    await expect(run('redeem')).resolves.toMatchObject({
      pointsChanged: 125,
      discountApplied: 250,
      payableAmount: 750,
    });
  });
});

describe('Phase 1.4 — WAL-5: balance updates are atomic', () => {
  const passId = '22222222-2222-2222-2222-222222222222';

  // Stands in for Postgres: the RPC is the only thing that mutates balance,
  // so two concurrent awards must both land.
  const makeDb = (startBalance: number) => {
    const state = { balance: startBalance };
    return {
      state,
      client: {
        from: (table: string) =>
          table === 'Pass'
            ? {
                select: () => ({
                  eq: () => ({
                    single: async () => ({
                      data: {
                        id: passId,
                        fullPassId: 'issuer.pass-1',
                        memberId: 'member-1',
                        tenantId: 'tenant-1',
                        balance: state.balance,
                        tier: 'Bronze',
                        Member: { phone: '+910000000000' },
                        Tenant: { name: 'Acme', PassTemplate: [] },
                      },
                    }),
                  }),
                }),
                update: () => ({ eq: async () => ({ error: null }) }),
              }
            : {
                select: () => ({
                  eq: () => ({
                    order: () => ({
                      limit: () => ({
                        maybeSingle: async () => ({ data: null }),
                      }),
                    }),
                  }),
                }),
                insert: async () => ({ error: null }),
              },
        rpc: jest.fn(async (_fn: string, args: any) => {
          state.balance = Math.max(0, state.balance + args.p_delta);
          return { data: state.balance, error: null };
        }),
      },
    };
  };

  it('does not lose one of two concurrent awards', async () => {
    const db = makeDb(0);
    const service = makeService(db);
    jest.spyOn(service, 'syncPassAfterTransaction').mockResolvedValue({
      walletPushed: true,
      directNotified: false,
      tier: 'Bronze',
      tierChanged: false,
    });

    const [a, b] = await Promise.all([
      service.processOrderTransaction(passId, 1000, 'award', 'manual'),
      service.processOrderTransaction(passId, 1000, 'award', 'manual'),
    ]);

    // Read-modify-write would leave 100 here (both reads saw balance 0).
    expect(db.state.balance).toBe(200);
    expect([a.newBalance, b.newBalance].sort((x, y) => x - y)).toEqual([
      100, 200,
    ]);
  });
});

describe('Phase 1.1 / 1.5 — new endpoints are tenant-guarded', () => {
  const guardsOn = (proto: any, method: string) =>
    (Reflect.getMetadata('__guards__', proto[method]) || []).map(
      (g: any) => g.name || g.constructor?.name,
    );

  it('preview-pass requires a tenant session', () => {
    expect(guardsOn(TemplatesController.prototype, 'previewPass')).toContain(
      TenantGuard.name,
    );
  });

  it('the test-account toggle requires a tenant session', () => {
    expect(guardsOn(MembersController.prototype, 'setTestAccount')).toContain(
      TenantGuard.name,
    );
  });
});
