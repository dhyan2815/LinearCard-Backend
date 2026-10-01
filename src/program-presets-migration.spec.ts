/**
 * Phase 3 — "Program → Tier → Template migration".
 * One assertion per defect the phase closed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ProgramsController } from './programs/programs.controller';
import { PROGRAM_PRESETS, slugify } from './programs/presets';
import { buildClassSuffix, resolveLoyaltyRules } from './wallet/wallet.service';
import { computeTier } from './tiers/tier.util';

const MIGRATION = fs.readFileSync(
  path.resolve(
    __dirname,
    '../supabase/migrations/20260921000004_phase3.sql',
  ),
  'utf8',
);

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

describe('3.1 — schema', () => {
  it('drops the one-program-per-tenant unique index (DB-4, D8)', () => {
    expect(MIGRATION).toContain(
      'DROP INDEX IF EXISTS "Program_tenantId_unique"',
    );
    expect(MIGRATION).toContain(
      'CREATE INDEX IF NOT EXISTS "Program_tenantId_idx"',
    );
  });

  it('adds PassTemplate.programId (DB-5)', () => {
    expect(MIGRATION).toMatch(
      /ALTER TABLE "PassTemplate"[\s\S]*?ADD COLUMN IF NOT EXISTS "programId" UUID/,
    );
  });

  it('adds the kind discriminator with only loyalty and ticket (D9/D14)', () => {
    expect(MIGRATION).toContain(`CHECK ("kind" IN ('loyalty', 'ticket'))`);
  });

  it('drops PassTemplate.tierThresholds in the same migration (D11)', () => {
    expect(MIGRATION).toContain(
      'ALTER TABLE "PassTemplate" DROP COLUMN IF EXISTS "tierThresholds"',
    );
  });

  it('seeds real Tier rows from the legacy JSONB before dropping it', () => {
    expect(MIGRATION.indexOf('INSERT INTO "Tier"')).toBeLessThan(
      MIGRATION.indexOf('DROP COLUMN IF EXISTS "tierThresholds"'),
    );
  });
});

describe('3.2 — single tier source of truth (DB-9)', () => {
  const program = {
    id: 'program-1',
    tenantId: 'tenant-1',
    kind: 'loyalty',
    name: 'Coffee',
  };

  function controller(tables: Record<string, any[]>) {
    const stub = supabaseStub(tables);
    return {
      stub,
      ctrl: new ProgramsController(stub.service, {} as any),
    };
  }

  it('writes Tier rows the scan pipeline reads, sorted by minPoints', async () => {
    const { stub, ctrl } = controller({
      Program: [program],
      PassTemplate: [
        { id: 'tpl-1', programId: 'program-1', tenantId: 'tenant-1' },
      ],
    });

    const res = await ctrl.setTiers(
      'program-1',
      {
        tiers: [
          { name: 'Gold', minPoints: 500 },
          { name: 'Bronze', minPoints: 0 },
        ],
      },
      { tenantId: 'tenant-1' } as any,
    );

    expect(res.success).toBe(true);
    const insert = stub.writes.find(
      (w) => w.table === 'Tier' && w.op === 'insert',
    );
    expect(insert.payload.map((t: any) => t.name)).toEqual(['Bronze', 'Gold']);
    // Every tier points at a template the program owns, so the tier-driven
    // design swap has something to swap to.
    expect(insert.payload.every((t: any) => t.templateId === 'tpl-1')).toBe(
      true,
    );
  });

  it('replaces the whole set rather than appending', async () => {
    const { stub, ctrl } = controller({
      Program: [program],
      PassTemplate: [
        { id: 'tpl-1', programId: 'program-1', tenantId: 'tenant-1' },
      ],
    });
    await ctrl.setTiers(
      'program-1',
      { tiers: [{ name: 'Bronze', minPoints: 0 }] },
      { tenantId: 'tenant-1' } as any,
    );
    expect(
      stub.writes.some((w) => w.table === 'Tier' && w.op === 'delete'),
    ).toBe(true);
  });

  it('rejects duplicate minPoints — two tiers at the same threshold are unrankable', async () => {
    const { ctrl } = controller({ Program: [program] });
    await expect(
      ctrl.setTiers(
        'program-1',
        {
          tiers: [
            { name: 'Bronze', minPoints: 0 },
            { name: 'Silver', minPoints: 0 },
          ],
        },
        { tenantId: 'tenant-1' } as any,
      ),
    ).rejects.toThrow('distinct minPoints');
  });

  it('refuses tiers on a ticket program (D9 — tickets have none)', async () => {
    const { ctrl } = controller({
      Program: [{ ...program, kind: 'ticket' }],
    });
    await expect(
      ctrl.setTiers(
        'program-1',
        { tiers: [{ name: 'Bronze', minPoints: 0 }] },
        { tenantId: 'tenant-1' } as any,
      ),
    ).rejects.toThrow('ticket programs have no tiers');
  });

  it("refuses a tier pointing at another program's template", async () => {
    const { ctrl } = controller({
      Program: [program],
      PassTemplate: [
        { id: 'tpl-1', programId: 'program-1', tenantId: 'tenant-1' },
      ],
    });
    await expect(
      ctrl.setTiers(
        'program-1',
        { tiers: [{ name: 'Bronze', minPoints: 0, templateId: 'tpl-other' }] },
        { tenantId: 'tenant-1' } as any,
      ),
    ).rejects.toThrow('must belong to this program');
  });

  it('a tier edit changes what the next scan computes', () => {
    const tiers = [
      {
        id: 'a',
        programId: 'p',
        name: 'Bronze',
        minPoints: 0,
        templateId: 't',
        sortOrder: 0,
      },
      {
        id: 'b',
        programId: 'p',
        name: 'Gold',
        minPoints: 500,
        templateId: 't',
        sortOrder: 1,
      },
    ];
    expect(computeTier(600, tiers)!.name).toBe('Gold');
    // Raise the Gold threshold — the same balance now computes Bronze.
    const edited = tiers.map((t) =>
      t.name === 'Gold' ? { ...t, minPoints: 1000 } : t,
    );
    expect(computeTier(600, edited)!.name).toBe('Bronze');
  });
});

describe('3.3 — two programs per tenant (PRG-1, PRG-2)', () => {
  it("scores a transaction against its own program's economics, not a sibling's", () => {
    const templates = [
      {
        id: 'a',
        programId: 'coffee',
        status: 'published',
        updatedAt: '2',
        earnRate: 0.1,
      },
      {
        id: 'b',
        programId: 'gym',
        status: 'published',
        updatedAt: '9',
        earnRate: 5,
      },
    ];
    // Unscoped, the gym template wins on updatedAt — the PRG-2 bug shape.
    expect(resolveLoyaltyRules(templates).earnRate).toBe(5);
    expect(resolveLoyaltyRules(templates, 'coffee').earnRate).toBe(0.1);
  });

  it('falls back to the defaults rather than a sibling when the program has no template', () => {
    const templates = [
      {
        id: 'b',
        programId: 'gym',
        status: 'published',
        updatedAt: '9',
        earnRate: 5,
      },
    ];
    expect(resolveLoyaltyRules(templates, 'coffee').earnRate).toBe(0.1);
  });
});

describe('3.5 — preset catalog (D9/D14)', () => {
  // Phase 8 grew the catalog to twelve for the template gallery; the point
  // this assertion protects is that both kinds ship, not the exact count.
  it('ships presets across two kinds', () => {
    expect(
      PROGRAM_PRESETS.filter((p) => p.kind === 'loyalty').length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      PROGRAM_PRESETS.filter((p) => p.kind === 'ticket').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('gives every points-bearing preset economics, and every ticket preset neither', () => {
    for (const preset of PROGRAM_PRESETS) {
      if (['loyalty', 'giftcard', 'coupon'].includes(preset.kind)) {
        // Phase 8 added one-off cards (gift card, coupon, business card) that
        // legitimately have no tiers; economics are still required so the
        // scanner always has rates to apply.
        expect(preset.loyalty).toBeDefined();
      } else {
        expect(preset.tiers).toEqual([]);
        expect(preset.loyalty).toBeUndefined();
      }
    }
  });

  it('creates program + per-tier templates + tiers in one call', async () => {
    const stub = supabaseStub({
      Tenant: [{ id: 'tenant-1', name: 'Acme', classSuffix: 'acme' }],
    });
    const ctrl = new ProgramsController(stub.service, {} as any);

    const res = await ctrl.create(
      { presetId: 'coffee_loyalty', name: 'Acme Coffee' },
      { tenantId: 'tenant-1' } as any,
    );

    expect(res.success).toBe(true);
    expect(res.templates).toHaveLength(3); // one per tier (Phase 3.7)
    expect(res.tiers).toHaveLength(3);
    const suffixes = stub.writes
      .find((w) => w.table === 'PassTemplate' && w.op === 'insert')
      .payload.map((t: any) => t.classSuffix);
    expect(suffixes).toEqual([
      'acme_acme_coffee_bronze',
      'acme_acme_coffee_silver',
      'acme_acme_coffee_gold',
    ]);
  });

  it('gives a ticket program exactly one template and no tiers', async () => {
    const stub = supabaseStub({
      Tenant: [{ id: 'tenant-1', name: 'Acme', classSuffix: 'acme' }],
    });
    const ctrl = new ProgramsController(stub.service, {} as any);

    const res = await ctrl.create({ presetId: 'event_ticket' }, {
      tenantId: 'tenant-1',
    } as any);

    expect(res.templates).toHaveLength(1);
    expect(res.tiers).toEqual([]);
    expect(stub.writes.some((w) => w.table === 'Tier')).toBe(false);
  });

  it('rejects an unknown preset instead of creating an empty program', async () => {
    const stub = supabaseStub({});
    const ctrl = new ProgramsController(stub.service, {} as any);
    await expect(
      ctrl.create({ presetId: 'nope' }, { tenantId: 'tenant-1' } as any),
    ).rejects.toThrow('presetId');
  });

  it('deletes a program, expires Google Wallet passes, and removes passes, tiers, templates from DB', async () => {
    const expiredPassIds: string[] = [];
    const mockWallet = {
      forTenant: async () => ({
        expireGenericObject: async (passId: string) => {
          expiredPassIds.push(passId);
          return true;
        },
      }),
    };
    const stub = supabaseStub({
      Program: [{ id: 'p-1', tenantId: 'tenant-1', name: 'Apex Events' }],
      Pass: [
        {
          id: 'pass-1',
          programId: 'p-1',
          tenantId: 'tenant-1',
          fullPassId: 'pass.123',
        },
      ],
      Tier: [{ id: 'tier-1', programId: 'p-1' }],
      PassTemplate: [{ id: 'tpl-1', programId: 'p-1', tenantId: 'tenant-1' }],
      Campaign: [{ id: 'cmp-1', programId: 'p-1', tenantId: 'tenant-1' }],
    });
    const ctrl = new ProgramsController(
      stub.service,
      {} as any,
      mockWallet as any,
    );

    // Phase 8 — the delete is name-confirmed; the cascade below is unchanged.
    const res = await ctrl.remove('p-1', { tenantId: 'tenant-1' } as any, {
      confirmName: 'Apex Events',
    });
    expect(res.success).toBe(true);
    expect(res.expiredPassesCount).toBe(1);
    expect(expiredPassIds).toContain('pass.123');

    // Check DB writes
    expect(
      stub.writes.some((w) => w.table === 'Pass' && w.op === 'delete'),
    ).toBe(true);
    expect(
      stub.writes.some((w) => w.table === 'Tier' && w.op === 'delete'),
    ).toBe(true);
    expect(
      stub.writes.some((w) => w.table === 'PassTemplate' && w.op === 'delete'),
    ).toBe(true);
    expect(
      stub.writes.some((w) => w.table === 'Program' && w.op === 'delete'),
    ).toBe(true);
    expect(
      stub.writes.some((w) => w.table === 'Campaign' && w.op === 'update'),
    ).toBe(true);
  });
});

describe('3.7 — class suffixes (DB-6)', () => {
  it('derives from tenant, program and tier — never the shared sandbox literal', () => {
    expect(buildClassSuffix('Bean House', 'Coffee Loyalty', 'Gold')).toBe(
      'bean_house_coffee_loyalty_gold',
    );
    expect(buildClassSuffix('acme', 'gym')).toBe('acme_gym');
  });

  it('gives each tier of one program its own suffix, so the design swap swaps classes', () => {
    const bronze = buildClassSuffix('acme', 'coffee', 'Bronze');
    const gold = buildClassSuffix('acme', 'coffee', 'Gold');
    expect(bronze).not.toBe(gold);
  });

  it('matches the slug the SQL backfill generates', () => {
    expect(slugify('Bean House Coffee!')).toBe('bean_house_coffee');
    expect(slugify('')).toBe('program');
  });

  it('leaves the environment prefix out — it is applied at call time (D13/D15)', () => {
    expect(buildClassSuffix('acme', 'coffee')).not.toMatch(/dev|preview|prod/);
  });
});
