/**
 * Phase 8 — PassKit project model: self-serve signup and program-scoped views.
 * One assertion per defect the phase closed.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as jwt from 'jsonwebtoken';
import { PassIssuanceService } from './passes/pass-issuance.service';
import { AuthController } from './auth/auth.controller';
import { JWT_SECRET } from './env';
import { buildMemberQuery } from './members/member-query';
import { ProgramMembersController } from './programs/program-members.controller';
import { ProgramAnalyticsController } from './programs/program-analytics.controller';
import { AuditService } from './audit/audit.service';
import { ProgramsController } from './programs/programs.controller';
import { WebhookService } from './developers/webhook.service';
import { PROGRAM_PRESETS } from './programs/presets';

/** Minimal chainable Supabase stub: one table -> canned rows, records writes. */
function supabaseStub(tables: Record<string, any[]>) {
  const writes: any[] = [];
  const client = {
    from(table: string) {
      const filters: Record<string, any> = {};
      const rowsFor = () => {
        let rows = tables[table] ?? [];
        for (const [col, val] of Object.entries(filters))
          rows = rows.filter((r: any) => r[col] === val);
        return rows;
      };
      const chain: any = {
        select: () => chain,
        insert: (payload: any) => {
          writes.push({ table, op: 'insert', payload });
          const rows = (Array.isArray(payload) ? payload : [payload]).map(
            (p: any, i: number) => ({ id: `${table}-${i}`, ...p }),
          );
          chain._inserted = rows;
          return chain;
        },
        update: (payload: any) => {
          writes.push({ table, op: 'update', payload });
          chain._updated = payload;
          return chain;
        },
        delete: () => {
          writes.push({ table, op: 'delete' });
          return chain;
        },
        eq: (col: string, val: any) => {
          filters[col] = val;
          return chain;
        },
        is: () => chain,
        gte: () => chain,
        lte: () => chain,
        or: () => chain,
        range: () => chain,
        limit: () => chain,
        order: () => chain,
        maybeSingle: async () => ({ data: rowsFor()[0] ?? null, error: null }),
        single: async () => ({
          data: chain._inserted?.[0] ?? chain._updated ?? rowsFor()[0] ?? null,
          error: null,
        }),
        then: (resolve: any) =>
          resolve({ data: rowsFor(), error: null, count: rowsFor().length }),
      };
      return chain;
    },
  };
  return { client, writes };
}

describe('8.1 — the demo gate covers every issuance path', () => {
  const walletStub: any = {
    resolveTenantPassDesign: async () => ({ classSuffix: 'x' }),
    forTenant: async () => ({
      buildSaveLink: () => ({ token: 't', googleWalletUrl: 'https://w' }),
      createGoogleWalletPass: async () => ({
        success: true,
        fullPassId: 'f1',
        googleWalletUrl: 'https://w',
      }),
    }),
  };
  const noopWhatsapp: any = {
    sendPassLinkWithLog: async () => {},
    sendTextWithLog: async () => {},
  };
  const noopWebhooks: any = { dispatch: async () => {} };

  function serviceFor(publishStatus: string, isTestAccount: boolean) {
    const { client } = supabaseStub({
      Tenant: [{ id: 't1', name: 'Demo Co', publishStatus }],
      Member: [{ id: 'm1', tenantId: 't1', phone: '+911', isTestAccount }],
      Tier: [],
      Pass: [],
      Program: [{ id: 'p1', tenantId: 't1' }],
    });
    return new PassIssuanceService(
      { client } as any,
      walletStub,
      noopWhatsapp,
      noopWebhooks,
    );
  }

  // The demo gate in PassIssuanceService.issueForMember is currently
  // commented out ("Temporarily disabled for PoC"), so a demo tenant may
  // issue to any member regardless of isTestAccount.
  it('allows a demo tenant issuing to a non-test member while the gate is disabled', async () => {
    const result = await serviceFor('demo', false).issueForMember({
      tenantId: 't1',
      member: { id: 'm1', phone: '+911' },
      program: { id: 'p1' },
    });
    expect(String(result.error ?? '')).not.toMatch(/demo mode/i);
  });

  it('allows a demo tenant issuing to a test member', async () => {
    const result = await serviceFor('demo', true).issueForMember({
      tenantId: 't1',
      member: { id: 'm1', phone: '+911' },
      program: { id: 'p1' },
    });
    expect(String(result.error ?? '')).not.toMatch(/demo mode/i);
  });

  it('fails open when publishStatus is missing', async () => {
    const result = await serviceFor(undefined as any, false).issueForMember({
      tenantId: 't1',
      member: { id: 'm1', phone: '+911' },
      program: { id: 'p1' },
    });
    expect(String(result.error ?? '')).not.toMatch(/demo mode/i);
  });
});

describe('8.2 — an unknown admin phone no longer joins the first tenant', () => {
  const otpServiceStub: any = {
    hashOtp: () => 'hash',
    isOtpRateLimited: async () => false,
    verifyOtpAttempt: async () => ({ ok: true, locked: false }),
  };

  function controllerFor(tables: Record<string, any[]>) {
    const stub = supabaseStub(tables);
    // Constructor order: supabase, otp, whatsapp, notify, passIssuance.
    const controller = new AuthController(
      { client: stub.client } as any,
      otpServiceStub,
      { sendOtp: async () => {} } as any,
      {} as any,
    );
    return { controller, stub };
  }

  const otpRow = {
    id: 'o1',
    phone: '+919999999999',
    purpose: 'admin_login',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    consumedAt: null,
  };

  it('creates no Admin row and returns needsOnboarding', async () => {
    const { controller, stub } = controllerFor({
      OtpSession: [otpRow],
      Admin: [],
      Tenant: [{ id: 'someone-elses-tenant' }],
    });
    const res: any = { cookie: jest.fn() };

    const result: any = await controller.adminVerifyOtp(
      { phone: '+919999999999', otp: '1234' },
      res,
    );

    expect(result.needsOnboarding).toBe(true);
    expect(typeof result.signupToken).toBe('string');
    expect(res.cookie).not.toHaveBeenCalled();
    expect(
      stub.writes.some((w) => w.table === 'Admin' && w.op === 'insert'),
    ).toBe(false);
  });

  it('logs an existing admin in unchanged', async () => {
    const { controller } = controllerFor({
      OtpSession: [otpRow],
      Admin: [
        { id: 'a1', phone: '+919999999999', tenantId: 't1', role: 'admin' },
      ],
    });
    const res: any = { cookie: jest.fn() };

    const result: any = await controller.adminVerifyOtp(
      { phone: '+919999999999', otp: '1234' },
      res,
    );

    expect(result.success).toBe(true);
    expect(result.needsOnboarding).toBeUndefined();
    expect(res.cookie).toHaveBeenCalled();
  });
});

describe('8.3 — self-serve tenant signup', () => {
  function controllerFor(tables: Record<string, any[]>) {
    const stub = supabaseStub(tables);
    const controller = new AuthController(
      { client: stub.client } as any,
      { hashOtp: () => 'h' } as any,
      { sendOtp: async () => {} } as any,
      {} as any,
    );
    return { controller, stub };
  }

  const token = () =>
    jwt.sign({ phone: '+919999999999', purpose: 'signup' }, JWT_SECRET, {
      expiresIn: '10m',
    });

  it('creates a demo tenant and its admin', async () => {
    const { controller, stub } = controllerFor({ Admin: [], Tenant: [] });
    const res: any = { cookie: jest.fn() };

    const result: any = await controller.adminSignup(
      {
        signupToken: token(),
        brandName: 'Blue Tokai',
        adminName: 'Priya',
        businessCategory: 'food_beverage',
      },
      res,
    );

    expect(result.success).toBe(true);
    const tenantInsert = stub.writes.find(
      (w) => w.table === 'Tenant' && w.op === 'insert',
    );
    expect(tenantInsert.payload.publishStatus).toBe('demo');
    expect(tenantInsert.payload.classSuffix).toBe('blue_tokai');
    expect(
      stub.writes.some((w) => w.table === 'Admin' && w.op === 'insert'),
    ).toBe(true);
    expect(res.cookie).toHaveBeenCalled();
  });

  it('refuses a token whose phone already has an admin', async () => {
    const { controller } = controllerFor({
      Admin: [{ id: 'a1', phone: '+919999999999', tenantId: 't1' }],
      Tenant: [],
    });
    const res: any = { cookie: jest.fn() };

    await expect(
      controller.adminSignup({ signupToken: token(), brandName: 'Dup' }, res),
    ).rejects.toThrow();
  });

  it('refuses a blank brand name', async () => {
    const { controller } = controllerFor({ Admin: [], Tenant: [] });
    const res: any = { cookie: jest.fn() };
    await expect(
      controller.adminSignup({ signupToken: token(), brandName: '   ' }, res),
    ).rejects.toThrow();
  });
});

describe('8.5 — the phase 8 migration', () => {
  const MIGRATION = fs.readFileSync(
    path.resolve(
      __dirname,
      '../supabase/migrations/20260922000007_phase8.sql',
    ),
    'utf8',
  );

  it('adds every column the phase depends on', () => {
    expect(MIGRATION).toMatch(/ALTER TABLE "AuditLog"[\s\S]*"programId" UUID/);
    expect(MIGRATION).toMatch(
      /ALTER TABLE "Pass"[\s\S]*"installedAt" TIMESTAMPTZ/,
    );
    expect(MIGRATION).toMatch(/"welcomeMessage" TEXT/);
    expect(MIGRATION).toMatch(/"retentionDays" INTEGER/);
    expect(MIGRATION).toMatch(
      /ALTER TABLE "WebhookEndpoint"[\s\S]*"programId" UUID/,
    );
  });

  it('is re-runnable', () => {
    const adds = MIGRATION.match(/ADD COLUMN/g) || [];
    const guarded = MIGRATION.match(/ADD COLUMN IF NOT EXISTS/g) || [];
    expect(guarded.length).toBe(adds.length);
    expect(MIGRATION).not.toMatch(/CREATE INDEX (?!IF NOT EXISTS)/);
  });

  it('leaves no pass without a program', () => {
    expect(MIGRATION).toMatch(/UPDATE "Pass" p[\s\S]*"programId" IS NULL/);
  });
});

describe('8.6 — program-scoped member list', () => {
  /** Records every filter the builder applies, ignoring the row data. */
  function recordingClient(calls: Array<[string, any]>) {
    return {
      from: () => {
        const chain: any = {
          select: () => chain,
          eq: (col: string, val: any) => {
            calls.push([col, val]);
            return chain;
          },
          is: (col: string, val: any) => {
            calls.push([`is:${col}`, val]);
            return chain;
          },
          or: () => chain,
          order: () => chain,
          range: () => chain,
        };
        return chain;
      },
    } as any;
  }

  it('filters passes by program when a programId is given', () => {
    const calls: Array<[string, any]> = [];
    buildMemberQuery(recordingClient(calls), {
      tenantId: 't1',
      programId: 'p1',
      limit: 50,
      offset: 0,
    });

    expect(calls).toContainEqual(['tenantId', 't1']);
    expect(calls.some(([c]) => c.includes('programId'))).toBe(true);
  });

  it('omits the program filter when no programId is given', () => {
    const calls: Array<[string, any]> = [];
    buildMemberQuery(recordingClient(calls), {
      tenantId: 't1',
      limit: 50,
      offset: 0,
    });

    expect(calls.some(([c]) => c.includes('programId'))).toBe(false);
  });
});

describe('8.7 — program member events', () => {
  it("returns this program's audit rows, newest first", async () => {
    const { client } = supabaseStub({
      Program: [{ id: 'p1', tenantId: 't1', name: 'Coffee' }],
      AuditLog: [
        {
          id: 'e1',
          tenantId: 't1',
          programId: 'p1',
          memberId: 'm1',
          action: 'pass_installed',
          actor: 'google-wallet-webhook',
          createdAt: '2026-09-20T10:00:00Z',
          Member: { name: 'Asha', phone: '+911' },
        },
      ],
    });
    const controller = new ProgramMembersController({ client } as any);
    const result: any = await controller.events('p1', {
      tenantId: 't1',
    } as any);

    expect(result.success).toBe(true);
    expect(result.events[0].action).toBe('pass_installed');
    expect(result.events[0].memberName).toBe('Asha');
  });

  it("404s for another tenant's program", async () => {
    const { client } = supabaseStub({
      Program: [{ id: 'p1', tenantId: 'other' }],
    });
    const controller = new ProgramMembersController({ client } as any);
    await expect(
      controller.events('p1', { tenantId: 't1' } as any),
    ).rejects.toThrow();
  });
});

describe('8.11 — pass lifecycle events', () => {
  it('writes programId as its own column, not inside details', async () => {
    const { client, writes } = supabaseStub({ AuditLog: [] });
    await new AuditService({ client } as any).record({
      tenantId: 't1',
      memberId: 'm1',
      passId: 'pass1',
      programId: 'p1',
      actor: 'system',
      action: 'pass_created',
    });

    const row = writes.find((w) => w.table === 'AuditLog').payload;
    expect(row.programId).toBe('p1');
    expect(row.action).toBe('pass_created');
    expect(row.details.passId).toBe('pass1');
  });

  it('omits programId when the caller has none', async () => {
    const { client, writes } = supabaseStub({ AuditLog: [] });
    await new AuditService({ client } as any).record({
      tenantId: 't1',
      memberId: 'm1',
      actor: 'system',
      action: 'data_export',
    });
    const row = writes.find((w) => w.table === 'AuditLog').payload;
    expect(row.programId ?? null).toBeNull();
  });
});

describe('8.12 — program overview', () => {
  function controllerWith(passes: any[], audit: any[]) {
    const { client } = supabaseStub({
      Program: [{ id: 'p1', tenantId: 't1' }],
      Pass: passes,
      AuditLog: audit,
    });
    return new ProgramAnalyticsController({ client } as any);
  }

  it('aggregates revenue, orders and points, bucketed by day', async () => {
    const controller = controllerWith(
      [{ id: 'x', memberId: 'm1' }],
      [
        {
          tenantId: 't1',
          programId: 'p1',
          action: 'order_transaction',
          createdAt: '2026-09-20T09:00:00Z',
          details: {
            orderAmount: 100,
            transactionType: 'earn',
            pointsChanged: 10,
          },
        },
        {
          tenantId: 't1',
          programId: 'p1',
          action: 'order_transaction',
          createdAt: '2026-09-21T10:00:00Z',
          details: {
            orderAmount: 50,
            transactionType: 'redeem',
            pointsChanged: -5,
          },
        },
      ],
    );

    const result: any = await controller.overview(
      'p1',
      { tenantId: 't1' } as any,
      undefined,
      undefined,
      'day',
    );

    expect(result.overview.totalRevenue).toBe(150);
    expect(result.overview.totalOrders).toBe(2);
    expect(result.overview.pointsAwarded).toBe(10);
    expect(result.overview.pointsRedeemed).toBe(5);
    const day20 = result.overview.series.find(
      (b: any) => b.bucket === '2026-09-20',
    );
    expect(day20).toEqual({
      bucket: '2026-09-20',
      revenue: 100,
      orders: 1,
      pointsAwarded: 10,
      pointsRedeemed: 0,
    });
  });

  it('reports zero totals rather than throwing when there is no activity', async () => {
    const controller = controllerWith([], []);
    const result: any = await controller.overview(
      'p1',
      { tenantId: 't1' } as any,
      undefined,
      undefined,
      'day',
    );
    expect(result.overview.totalRevenue).toBe(0);
    expect(result.overview.totalOrders).toBe(0);
    expect(result.overview.pointsAwarded).toBe(0);
    expect(result.overview.pointsRedeemed).toBe(0);
    expect(result.overview.historyStartsAt).toBeNull();
  });

  it("404s for another tenant's program", async () => {
    const { client } = supabaseStub({
      Program: [{ id: 'p1', tenantId: 'other' }],
    });
    const controller = new ProgramAnalyticsController({ client } as any);
    await expect(
      controller.overview(
        'p1',
        { tenantId: 't1' } as any,
        undefined,
        undefined,
        'day',
      ),
    ).rejects.toThrow();
  });
});

describe('8.15 — destructive delete needs the program name', () => {
  function controllerFor() {
    const stub = supabaseStub({
      Program: [{ id: 'p1', tenantId: 't1', name: 'Coffee Loyalty' }],
      Pass: [],
      Campaign: [],
    });
    return {
      controller: new ProgramsController(
        { client: stub.client } as any,
        {} as any,
        undefined,
      ),
      stub,
    };
  }

  it('refuses a mismatched confirmName', async () => {
    const { controller, stub } = controllerFor();
    await expect(
      controller.remove('p1', { tenantId: 't1' } as any, {
        confirmName: 'coffee',
      }),
    ).rejects.toThrow();
    expect(stub.writes.some((w) => w.op === 'delete')).toBe(false);
  });

  it('proceeds on an exact match', async () => {
    const { controller } = controllerFor();
    const result: any = await controller.remove(
      'p1',
      { tenantId: 't1' } as any,
      { confirmName: 'Coffee Loyalty' },
    );
    expect(result.success).toBe(true);
  });
});

describe('8.16 — webhook scoping', () => {
  function serviceWith(endpoints: any[]) {
    const { client } = supabaseStub({ WebhookEndpoint: endpoints });
    const service = new WebhookService({ client } as any);
    const delivered: string[] = [];
    (service as any).deliverWithRetry = async (endpoint: any) => {
      delivered.push(endpoint.id);
    };
    return { service, delivered };
  }

  const rows = [
    {
      id: 'tenant-wide',
      tenantId: 't1',
      programId: null,
      active: true,
      events: ['pass.installed'],
      url: 'https://a',
      secret: 's',
    },
    {
      id: 'program-p1',
      tenantId: 't1',
      programId: 'p1',
      active: true,
      events: ['pass.installed'],
      url: 'https://b',
      secret: 's',
    },
    {
      id: 'program-p2',
      tenantId: 't1',
      programId: 'p2',
      active: true,
      events: ['pass.installed'],
      url: 'https://c',
      secret: 's',
    },
  ];

  it('fires tenant-wide and matching-program hooks only', async () => {
    const { service, delivered } = serviceWith(rows);
    await service.dispatch('t1', 'pass.installed', {}, 'p1');
    expect(delivered.sort()).toEqual(['program-p1', 'tenant-wide']);
  });

  it('fires only tenant-wide hooks when no program is given', async () => {
    const { service, delivered } = serviceWith(rows);
    await service.dispatch('t1', 'pass.installed', {});
    expect(delivered).toEqual(['tenant-wide']);
  });
});

describe('8.17 — welcome message', () => {
  function serviceFor(
    welcomeMessage: string | null,
    marketingOptOutAt: string | null,
  ) {
    const sent: Array<{ phone: string; text: string }> = [];
    const { client } = supabaseStub({
      Tenant: [{ id: 't1', name: 'Blue Tokai', publishStatus: 'production' }],
      Program: [{ id: 'p1', tenantId: 't1', welcomeMessage }],
      Member: [{ id: 'm1', tenantId: 't1', phone: '+911', marketingOptOutAt }],
      Tier: [],
      Pass: [],
    });
    const whatsapp: any = {
      sendPassLinkWithLog: async () => {},
      sendTextWithLog: async (phone: string, text: string) => {
        sent.push({ phone, text });
      },
    };
    const service = new PassIssuanceService(
      { client } as any,
      {
        resolveTenantPassDesign: async () => ({ classSuffix: 'x' }),
        forTenant: async () => ({
          buildSaveLink: () => ({ token: 't', googleWalletUrl: 'https://w' }),
          createGoogleWalletPass: async () => ({
            success: true,
            fullPassId: 'f1',
            googleWalletUrl: 'https://w',
          }),
        }),
      } as any,
      whatsapp,
      { dispatch: async () => {} } as any,
    );
    return { service, sent };
  }

  it('is skipped for a member who opted out of marketing', async () => {
    const { service, sent } = serviceFor(
      'Welcome to Blue Tokai',
      '2026-09-01T00:00:00Z',
    );
    await service.issueForMember({
      tenantId: 't1',
      member: {
        id: 'm1',
        phone: '+911',
        marketingOptOutAt: '2026-09-01T00:00:00Z',
      },
      program: { id: 'p1' },
    });
    expect(sent.some((s) => s.text === 'Welcome to Blue Tokai')).toBe(false);
  });

  it('sends once when the program has one and the member has not opted out', async () => {
    const { service, sent } = serviceFor('Welcome to Blue Tokai', null);
    await service.issueForMember({
      tenantId: 't1',
      member: { id: 'm1', phone: '+911', marketingOptOutAt: null },
      program: { id: 'p1' },
    });
    expect(sent.filter((s) => s.text === 'Welcome to Blue Tokai')).toHaveLength(
      1,
    );
  });

  it('sends nothing when the program has no welcome message', async () => {
    const { service, sent } = serviceFor(null, null);
    await service.issueForMember({
      tenantId: 't1',
      member: { id: 'm1', phone: '+911', marketingOptOutAt: null },
      program: { id: 'p1' },
    });
    expect(sent).toHaveLength(0);
  });
});

describe('8.18 — the template gallery catalog', () => {
  it('offers thirteen presets', () => {
    expect(PROGRAM_PRESETS.length).toBe(13);
  });

  it('gives every preset the fields the gallery card renders', () => {
    for (const preset of PROGRAM_PRESETS) {
      expect(preset.id).toMatch(/^[a-z0-9_]+$/);
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
      expect(preset.hexBackgroundColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(Array.isArray(preset.fieldRows)).toBe(true);
      expect(preset.fieldRows.length).toBeGreaterThan(0);
    }
  });

  it('has unique ids', () => {
    const ids = PROGRAM_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ships a preset for every program kind', () => {
    const kinds = new Set(PROGRAM_PRESETS.map((p) => p.kind));
    for (const kind of ['loyalty', 'ticket', 'giftcard', 'coupon', 'studentid'])
      expect(kinds.has(kind as any)).toBe(true);
  });
});
