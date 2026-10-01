/**
 * GAP-7 / GAP-14 — before this, `validate-pass` wrote nothing: an event
 * ticket scanned ten times read valid ten times, with no check-in record and
 * no expiry enforcement even though the program already has a real
 * `eventEndsAt` timestamp. Scenario: a gate staffer scans the same ticket QR
 * twice (screenshot shared, or an accidental double-tap) — the second scan
 * must be refused, not re-admit the holder.
 */
import { PassesController } from './passes.controller';

const TENANT_ID = 'tenant-1';

function jsonRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function controller(opts: { pass: any; program: any }) {
  const updates: any[] = [];
  const supabaseService = {
    client: {
      from(table: string) {
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          ilike: () => chain,
          order: () => chain,
          limit: () => chain,
          update: (payload: any) => {
            updates.push({ table, payload });
            if (table === 'Pass') Object.assign(opts.pass, payload);
            return { eq: async () => ({ error: null }) };
          },
          maybeSingle: async () => {
            if (table === 'Pass') return { data: opts.pass, error: null };
            if (table === 'Program') return { data: opts.program, error: null };
            return { data: null, error: null };
          },
          single: async () => {
            if (table === 'Pass') return { data: opts.pass, error: null };
            return { data: null, error: null };
          },
        };
        return chain;
      },
    },
  };
  const auditService = { record: jest.fn().mockResolvedValue(undefined) };
  const ctrl = new PassesController(
    supabaseService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    auditService as any,
    {} as any,
  );
  return { ctrl, updates, auditService };
}

const EVENT_PROGRAM = {
  id: 'program-1',
  kind: 'ticket',
  archetype: 'event_ticket',
  eventStartsAt: new Date(Date.now() - 3600_000).toISOString(),
  eventEndsAt: new Date(Date.now() + 3600_000).toISOString(),
};

const ACCESS_PROGRAM = {
  id: 'program-2',
  kind: 'ticket',
  archetype: 'access_pass',
  eventStartsAt: new Date(Date.now() - 3600_000).toISOString(),
  eventEndsAt: null,
};

function pass(overrides: any = {}) {
  return {
    id: 'pass-1',
    fullPassId: 'issuer.pass-1',
    tenantId: TENANT_ID,
    programId: overrides.programId ?? 'program-1',
    balance: 0,
    tier: null,
    usedAt: null,
    Member: { id: 'member-1', name: 'Ishita', phone: '+919876543210' },
    Tenant: { name: 'Lumen Live' },
    ...overrides,
  };
}

function req() {
  return { body: { passId: 'issuer.pass-1' }, tenantId: TENANT_ID } as any;
}

describe('validate-pass — event ticket single-use check-in (GAP-7)', () => {
  it('checks in on the first scan and records usedAt', async () => {
    const { ctrl, updates, auditService } = controller({
      pass: pass(),
      program: EVENT_PROGRAM,
    });
    const res = jsonRes();
    await ctrl.postvalidatepass(req(), res);

    const body = res.json.mock.calls[0][0];
    expect(body.valid).toBe(true);
    expect(body.checkedInNow).toBe(true);
    expect(updates).toContainEqual(
      expect.objectContaining({
        table: 'Pass',
        payload: expect.objectContaining({ usedAt: expect.any(String) }),
      }),
    );
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ticket_checked_in' }),
    );
  });

  it('refuses a second scan of the same ticket', async () => {
    const { ctrl, updates } = controller({
      pass: pass({ usedAt: new Date().toISOString() }),
      program: EVENT_PROGRAM,
    });
    const res = jsonRes();
    await ctrl.postvalidatepass(req(), res);

    const body = res.json.mock.calls[0][0];
    expect(body.valid).toBe(false);
    expect(body.error).toMatch(/already used/i);
    expect(updates).toHaveLength(0);
  });

  it('refuses a scan after the event has ended', async () => {
    const { ctrl, updates } = controller({
      pass: pass(),
      program: {
        ...EVENT_PROGRAM,
        eventEndsAt: new Date(Date.now() - 1000).toISOString(),
      },
    });
    const res = jsonRes();
    await ctrl.postvalidatepass(req(), res);

    const body = res.json.mock.calls[0][0];
    expect(body.valid).toBe(false);
    expect(body.error).toMatch(/ended/i);
    expect(updates).toHaveLength(0);
  });

  it('never mutates a non-event-ticket program (access_pass stays reusable)', async () => {
    const { ctrl, updates } = controller({
      pass: pass({ programId: 'program-2' }),
      program: ACCESS_PROGRAM,
    });
    const res = jsonRes();
    await ctrl.postvalidatepass(req(), res);

    const body = res.json.mock.calls[0][0];
    expect(body.valid).toBe(true);
    expect(body.checkedInNow).toBe(false);
    expect(updates).toHaveLength(0);
  });
});
