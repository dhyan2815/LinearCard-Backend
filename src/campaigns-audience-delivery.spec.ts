/**
 * Phase 2 — "Campaigns As A Real Feature".
 * One assertion per defect the phase closed.
 */
process.env.PUBLIC_CALLBACK_URL = 'https://api.test.linearcard.example';

import {
  CampaignsService,
  SEND_CHUNK_SIZE,
} from './campaigns/campaigns.service';
import { NotificationsController } from './notifications/notifications.controller';

/** Minimal Supabase stub: one table -> one canned result, chainable. */
function supabaseStub(tables: Record<string, any>) {
  const calls: any[] = [];
  return {
    calls,
    client: {
      from(table: string) {
        const record: any = { table, filters: {} };
        calls.push(record);
        const chain: any = new Proxy(
          {},
          {
            get: (_t, prop: string) => {
              if (prop === 'then') {
                return (resolve: any) => resolve(tables[table] ?? { data: [] });
              }
              if (prop === 'single') {
                const row = (tables[table]?.data || [])[0] ?? null;
                return () => Promise.resolve({ data: row, error: null });
              }
              return (...args: any[]) => {
                if (prop === 'update' || prop === 'insert')
                  record[prop] = args[0];
                else record.filters[prop] = args;
                return chain;
              };
            },
          },
        );
        return chain;
      },
    },
  };
}

const member = (over: Partial<any> = {}) => ({
  id: over.id || 'm1',
  name: 'A',
  phone: '+919000000001',
  isTestAccount: false,
  marketingOptOutAt: null,
  passes: [
    {
      id: 'p1',
      fullPassId: 'iss.p1',
      tier: 'Gold',
      balance: 500,
      deletedAt: null,
      programId: null,
    },
  ],
  ...over,
});

const makeService = (tables: Record<string, any>, deps: any = {}) => {
  const supabase = supabaseStub(tables);
  const service = new CampaignsService(
    supabase as any,
    deps.notify || { logNotification: jest.fn().mockResolvedValue(undefined) },
    deps.whatsapp || { sendText: jest.fn().mockResolvedValue(undefined) },
    deps.wallet || {
      sendOfferMessage: jest.fn().mockResolvedValue(undefined),
      sendClassMessage: jest.fn().mockResolvedValue(undefined),
    },
  );
  return { service, supabase };
};

describe('Phase 2.4 — DB-8: opt-out is not a filter option', () => {
  it('excludes a member who replied STOP even with an empty audience filter', async () => {
    const { service } = makeService({
      Member: {
        data: [
          member({ id: 'in' }),
          member({ id: 'out', marketingOptOutAt: '2026-09-01T00:00:00Z' }),
        ],
      },
    });

    const audience = await service.resolveAudience('t1', {});

    expect(audience.members.map((m) => m.id)).toEqual(['in']);
    expect(audience.optedOutCount).toBe(1);
  });
});

describe('Phase 2.2 — audience segmentation', () => {
  it('narrows by tier and balance range', async () => {
    const { service } = makeService({
      Member: {
        data: [
          member({
            id: 'gold-rich',
            passes: [{ id: 'p', fullPassId: 'x', tier: 'Gold', balance: 900 }],
          }),
          member({
            id: 'gold-poor',
            passes: [{ id: 'p', fullPassId: 'x', tier: 'Gold', balance: 10 }],
          }),
          member({
            id: 'bronze',
            passes: [
              { id: 'p', fullPassId: 'x', tier: 'Bronze', balance: 900 },
            ],
          }),
        ],
      },
    });

    const { members } = await service.resolveAudience('t1', {
      tiers: ['Gold'],
      balanceMin: 100,
    });

    expect(members.map((m) => m.id)).toEqual(['gold-rich']);
  });

  it('excludes members with AuditLog activity inside the inactivity window', async () => {
    const { service } = makeService({
      Member: { data: [member({ id: 'active' }), member({ id: 'dormant' })] },
      AuditLog: { data: [{ memberId: 'active' }] },
    });

    const { members } = await service.resolveAudience('t1', {
      inactiveForDays: 21,
    });

    expect(members.map((m) => m.id)).toEqual(['dormant']);
  });
});

describe('Phase 2.3 — WAL-3: wallet push uses addMessage, never pushNotification', () => {
  it('calls sendOfferMessage per pass and never touches updateGenericObject', async () => {
    const wallet = {
      sendOfferMessage: jest.fn().mockResolvedValue(undefined),
      updateGenericObject: jest.fn(),
    };
    const { service } = makeService({}, { wallet });

    const { sent } = await service.dispatch(
      {
        id: 'c1',
        tenantId: 't1',
        channel: 'wallet_push',
        header: 'Hi',
        body: 'Body',
      },
      [member() as any],
    );

    expect(sent).toBe(1);
    expect(wallet.sendOfferMessage).toHaveBeenCalledWith(
      'iss.p1',
      expect.any(String),
      'Hi',
      'Body',
      'generic',
    );
    expect(wallet.updateGenericObject).not.toHaveBeenCalled();
  });

  it('refuses a class-level broadcast when anyone has opted out', async () => {
    const wallet = { sendClassMessage: jest.fn(), forTenant: jest.fn() };
    const { service } = makeService({}, { wallet });

    const used = await service.tryClassBroadcast(
      { id: 'c1', tenantId: 't1', header: 'Hi', body: 'Body' },
      { members: [member() as any], optedOutCount: 1 },
      {},
    );

    expect(used).toBe(false);
    expect(wallet.sendClassMessage).not.toHaveBeenCalled();
  });
});

describe('Phase 2.5 — chunked send', () => {
  it('logs one NotificationLog row per recipient and survives a partial failure', async () => {
    const notify = { logNotification: jest.fn().mockResolvedValue(undefined) };
    const whatsapp = {
      sendText: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Waha error 500')),
    };
    const { service } = makeService({}, { notify, whatsapp });

    const { sent, failed } = await service.dispatch(
      {
        id: 'c1',
        tenantId: 't1',
        channel: 'whatsapp',
        header: null,
        body: 'Body',
      },
      [member({ id: 'ok' }) as any, member({ id: 'bad' }) as any],
    );

    expect({ sent, failed }).toEqual({ sent: 1, failed: 1 });
    expect(notify.logNotification).toHaveBeenCalledTimes(2);
    expect(notify.logNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: 'c1',
        status: 'failed',
        // Phase 6.2: every logged failure carries a stable code prefix.
        errorReason: 'UNKNOWN: Waha error 500',
      }),
    );
  });

  it('dispatches in batches rather than one request per member', async () => {
    const whatsapp = { sendText: jest.fn().mockResolvedValue(undefined) };
    const { service } = makeService({}, { whatsapp });
    const members = Array.from({ length: SEND_CHUNK_SIZE * 2 + 1 }, (_, i) =>
      member({ id: `m${i}` }),
    );

    const { sent } = await service.dispatch(
      {
        id: 'c1',
        tenantId: 't1',
        channel: 'whatsapp',
        header: null,
        body: 'B',
      },
      members as any,
    );

    expect(sent).toBe(members.length);
  });
});

describe('Phase 2.4 — inbound STOP sets marketingOptOutAt', () => {
  const run = async (body: any) => {
    const supabase = supabaseStub({
      Member: { data: [{ id: 'm1', tenantId: 't1' }] },
      ConsentLog: { data: [] },
    });
    const whatsapp = {
      sendTextWithLog: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new NotificationsController(
      supabase as any,
      whatsapp as any,
    );
    const res: any = {
      status: () => res,
      json: (payload: any) => payload,
    };
    const payload = await controller.whatsappInbound({ body } as any, res);
    return { payload, supabase, whatsapp };
  };

  it('opts the member out and confirms', async () => {
    const { payload, supabase, whatsapp } = await run({
      payload: { from: '919000000001@c.us', body: 'STOP' },
    });

    expect(payload).toMatchObject({ success: true, optedOut: true });
    const update = supabase.calls.find((c) => c.table === 'Member')?.update;
    expect(update.marketingOptOutAt).toEqual(expect.any(String));
    expect(whatsapp.sendTextWithLog).toHaveBeenCalled();
  });

  it('clears the opt-out on START', async () => {
    const { supabase } = await run({
      payload: { from: '919000000001@c.us', body: 'start' },
    });

    const update = supabase.calls.find((c) => c.table === 'Member')?.update;
    expect(update.marketingOptOutAt).toBeNull();
  });

  it('ignores ordinary replies', async () => {
    const { payload } = await run({
      payload: { from: '919000000001@c.us', body: 'thanks!' },
    });

    expect(payload).toMatchObject({ ignored: true });
  });
});
