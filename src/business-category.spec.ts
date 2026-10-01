/**
 * Business categories & wallet types — Phase 1: category gating.
 * See plans/BUSINESS_CATEGORY_WALLET_TYPES_PLAN.md.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as jwt from 'jsonwebtoken';
import { HttpException } from '@nestjs/common';
import { BUSINESS_CATEGORIES, BusinessCategory } from './types';
import { AuthController } from './auth/auth.controller';
import { JWT_SECRET } from './env';
import { ProgramsController } from './programs/programs.controller';
import { PROGRAM_PRESETS, presetsForCategory } from './programs/presets';
import { SettingsController } from './settings/settings.controller';

const MIGRATIONS = path.resolve(__dirname, '../supabase/migrations');
const SCHEMA = fs.readFileSync(
  path.join(MIGRATIONS, '20260928000001_business_category.sql'),
  'utf8',
);
const BACKFILL = fs.readFileSync(
  path.join(MIGRATIONS, '20260928000002_business_category_backfill.sql'),
  'utf8',
);

/** Minimal chainable Supabase stub: table -> canned rows, records writes. */
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
          chain._inserted = (Array.isArray(payload) ? payload : [payload]).map(
            (p: any, i: number) => ({ id: `${table}-${i}`, ...p }),
          );
          return chain;
        },
        update: (payload: any) => {
          writes.push({ table, op: 'update', payload, filters });
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
        limit: () => chain,
        order: () => chain,
        maybeSingle: async () => ({ data: rowsFor()[0] ?? null, error: null }),
        single: async () => ({
          data: chain._inserted?.[0] ?? chain._updated ?? rowsFor()[0] ?? null,
          error: null,
        }),
        then: (resolve: any) =>
          resolve({ data: chain._inserted ?? rowsFor(), error: null }),
      };
      return chain;
    },
  };
  return { writes, service: { client } as any };
}

const statusOf = async (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e) => (e as HttpException).getStatus(),
  );

describe('schema migration', () => {
  it('adds Tenant.businessCategory with a CHECK over all 8 ids', () => {
    expect(SCHEMA).toContain(
      'ADD COLUMN IF NOT EXISTS "businessCategory" TEXT NULL',
    );
    for (const c of BUSINESS_CATEGORIES) expect(SCHEMA).toContain(`'${c.id}'`);
  });

  it('adds Program.walletType defaulting to generic (D1)', () => {
    expect(SCHEMA).toContain(
      `ADD COLUMN IF NOT EXISTS "walletType" TEXT NOT NULL DEFAULT 'generic'`,
    );
    expect(SCHEMA).toContain(
      `"walletType" IN ('generic', 'loyalty', 'giftCard', 'offer', 'eventTicket')`,
    );
  });

  it('widens Program_kind_check to the five kinds', () => {
    expect(SCHEMA).toContain('DROP CONSTRAINT IF EXISTS "Program_kind_check"');
    expect(SCHEMA).toContain(
      `"kind" IN ('loyalty', 'ticket', 'giftcard', 'coupon', 'studentid')`,
    );
  });

  it('backfills the four existing tenants by id only', () => {
    expect(BACKFILL.match(/UPDATE "Tenant"/g)).toHaveLength(4);
    expect(BACKFILL.match(/WHERE "id" = '/g)).toHaveLength(4);
  });
});

describe('presetsForCategory', () => {
  it.each([null, undefined, 'test'] as const)(
    'returns every preset for %s',
    (category) => {
      expect(presetsForCategory(category)).toEqual(PROGRAM_PRESETS);
    },
  );

  const selectable = BUSINESS_CATEGORIES.filter((c) => c.selectable);
  it.each(selectable.map((c) => c.id))(
    'returns only presets tagged %s, and at least one',
    (category) => {
      const presets = presetsForCategory(category);
      expect(presets.length).toBeGreaterThan(0);
      for (const p of presets) expect(p.categories).toContain(category);
    },
  );

  it('matches the plan map for a few spot checks', () => {
    const ids = (c: BusinessCategory) => presetsForCategory(c).map((p) => p.id);
    expect(ids('travel')).toEqual(['travel_ticket']);
    expect(ids('education')).toEqual(['student_id']);
    expect(ids('food_beverage')).toContain('gift_card');
    expect(ids('retail')).not.toContain('event_ticket');
  });

  it('keeps every preset on the generic wallet type until verified (D11)', () => {
    for (const p of PROGRAM_PRESETS) expect(p.walletType).toBe('generic');
  });

  it('never tags a preset with the hidden test category', () => {
    for (const p of PROGRAM_PRESETS) expect(p.categories).not.toContain('test');
  });
});

describe('programs — category gating', () => {
  const req = { tenantId: 'tenant-1' } as any;
  const tenant = (businessCategory: string | null) => ({
    Tenant: [
      { id: 'tenant-1', name: 'Acme', classSuffix: 'acme', businessCategory },
    ],
  });

  it('GET /programs/presets filters by the tenant row', async () => {
    const stub = supabaseStub(tenant('travel'));
    const ctrl = new ProgramsController(stub.service, {} as any);
    const res = await ctrl.presets(req);
    expect(res.presets.map((p) => p.id)).toEqual(['travel_ticket']);
  });

  it('GET /programs/presets returns everything for a legacy (null) tenant', async () => {
    const stub = supabaseStub(tenant(null));
    const ctrl = new ProgramsController(stub.service, {} as any);
    expect((await ctrl.presets(req)).presets).toEqual(PROGRAM_PRESETS);
  });

  it('POST /programs rejects an out-of-category preset with 403 and writes nothing', async () => {
    const stub = supabaseStub(tenant('travel'));
    const ctrl = new ProgramsController(stub.service, {} as any);
    expect(
      await statusOf(ctrl.create({ presetId: 'coffee_loyalty' }, req)),
    ).toBe(403);
    expect(stub.writes).toEqual([]);
  });

  it('POST /programs ignores a category in the body', async () => {
    const stub = supabaseStub(tenant('travel'));
    const ctrl = new ProgramsController(stub.service, {} as any);
    const body: any = { presetId: 'coffee_loyalty', businessCategory: 'test' };
    expect(await statusOf(ctrl.create(body, req))).toBe(403);
  });

  it('POST /programs persists kind and walletType from the preset', async () => {
    const stub = supabaseStub(tenant('education'));
    const ctrl = new ProgramsController(stub.service, {} as any);
    await ctrl.create({ presetId: 'student_id' }, req);
    const insert = stub.writes.find(
      (w) => w.table === 'Program' && w.op === 'insert',
    );
    expect(insert.payload).toMatchObject({
      kind: 'studentid',
      walletType: 'generic',
    });
  });

  it('a legacy tenant (null category) can still create any preset', async () => {
    const stub = supabaseStub(tenant(null));
    const ctrl = new ProgramsController(stub.service, {} as any);
    const res = await ctrl.create({ presetId: 'coffee_loyalty' }, req);
    expect(res.success).toBe(true);
  });

  it('an existing loyalty program keeps its economics and tier editing', async () => {
    const program = { id: 'p1', tenantId: 'tenant-1', kind: 'loyalty' };
    const stub = supabaseStub({ ...tenant(null), Program: [program] });
    const ctrl = new ProgramsController(stub.service, {} as any);
    const res = await ctrl.update('p1', { earnRate: 0.5 }, req);
    expect(res.success).toBe(true);
    expect(await statusOf(ctrl.setTiers('p1', { tiers: [] }, req))).toBe(200);
  });

  it.each([
    ['giftcard', { earnRate: 0 }, 200],
    ['coupon', { earnRate: 0 }, 400],
    ['studentid', { earnRate: 0 }, 400],
    ['studentid', { venueName: 'Hall' }, 400],
    ['ticket', { venueName: 'Hall' }, 200],
  ])('PATCH on a %s program with %j → %i', async (kind, body, status) => {
    const program = { id: 'p1', tenantId: 'tenant-1', kind };
    const stub = supabaseStub({ Program: [program] });
    const ctrl = new ProgramsController(stub.service, {} as any);
    expect(await statusOf(ctrl.update('p1', body as any, req))).toBe(status);
  });

  it.each(['giftcard', 'coupon', 'studentid', 'ticket'])(
    'refuses tiers on a %s program',
    async (kind) => {
      const program = { id: 'p1', tenantId: 'tenant-1', kind };
      const stub = supabaseStub({ Program: [program] });
      const ctrl = new ProgramsController(stub.service, {} as any);
      expect(await statusOf(ctrl.setTiers('p1', { tiers: [] }, req))).toBe(400);
    },
  );
});

describe('signup — business category', () => {
  const token = () =>
    jwt.sign({ phone: '+919999999999', purpose: 'signup' }, JWT_SECRET, {
      expiresIn: '10m',
    });
  function controller() {
    const stub = supabaseStub({ Admin: [], Tenant: [] });
    const ctrl = new AuthController(
      stub.service,
      {} as any,
      {} as any,
      {} as any,
    );
    return { stub, ctrl };
  }
  const body = (businessCategory?: string) => ({
    signupToken: token(),
    brandName: 'Blue Tokai',
    adminName: 'Priya',
    businessCategory,
  });

  it.each([undefined, 'bakery', 'test'])(
    'rejects category %s with 400 and creates nothing',
    async (category) => {
      const { stub, ctrl } = controller();
      const res: any = { cookie: jest.fn() };
      expect(await statusOf(ctrl.adminSignup(body(category), res))).toBe(400);
      expect(stub.writes).toEqual([]);
    },
  );

  it('stores a valid category on the new tenant', async () => {
    const { stub, ctrl } = controller();
    const res: any = { cookie: jest.fn() };
    await ctrl.adminSignup(body('education'), res);
    const insert = stub.writes.find(
      (w) => w.table === 'Tenant' && w.op === 'insert',
    );
    expect(insert.payload.businessCategory).toBe('education');
  });
});

describe('settings — business category', () => {
  const req = { tenantId: 'tenant-1' } as any;

  it('GET /settings returns businessCategory', async () => {
    const stub = supabaseStub({
      Tenant: [{ id: 'tenant-1', businessCategory: 'retail' }],
    });
    const res = await new SettingsController(stub.service).getSettings(req);
    expect(res.tenant.businessCategory).toBe('retail');
  });

  it('PATCH /settings updates only the calling tenant and no programs', async () => {
    const stub = supabaseStub({ Tenant: [{ id: 'tenant-1' }] });
    await new SettingsController(stub.service).updateSettings(req, {
      businessCategory: 'travel',
    });
    expect(stub.writes).toEqual([
      {
        table: 'Tenant',
        op: 'update',
        payload: { businessCategory: 'travel' },
        filters: { id: 'tenant-1' },
      },
    ]);
  });

  it.each(['test', 'bakery', null])(
    'PATCH /settings rejects %s with 400',
    async (category) => {
      const stub = supabaseStub({ Tenant: [{ id: 'tenant-1' }] });
      const ctrl = new SettingsController(stub.service);
      expect(
        await statusOf(
          ctrl.updateSettings(req, { businessCategory: category }),
        ),
      ).toBe(400);
      expect(stub.writes).toEqual([]);
    },
  );
});
