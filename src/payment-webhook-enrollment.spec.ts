/**
 * Phase 5 — "Payment-triggered enrollment".
 * One assertion per thing the phase promises.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  PaymentsService,
  normalizePayment,
  signPaymentPayload,
  signatureMatches,
  TIMESTAMP_TOLERANCE_MS,
  adapterFor,
  MockAdapter,
  PAYMENT_ADAPTERS,
} from './payments/payments.service';

const MIGRATION = fs.readFileSync(
  path.resolve(
    __dirname,
    '../supabase/migrations/20260921000005_phase5.sql',
  ),
  'utf8',
);

const SECRET = 'lc_pay_testsecret';

/** Minimal chainable Supabase stub: canned rows per table, records writes. */
function supabaseStub(tables: Record<string, any[]>, insertError?: any) {
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
          chain._inserted = [{ id: `${table}-1`, ...payload }];
          chain._error = table === 'PaymentEvent' ? insertError : null;
          return chain;
        },
        upsert: (payload: any) => {
          writes.push({ table, op: 'upsert', payload });
          chain._inserted = [{ id: `${table}-1`, ...payload }];
          return chain;
        },
        update: (payload: any) => {
          writes.push({ table, op: 'update', payload });
          chain._updated = payload;
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
          data: chain._inserted?.[0] ?? rowsFor()[0] ?? null,
          error: chain._error ?? null,
        }),
        then: (resolve: any) =>
          resolve({ data: chain._inserted ?? rowsFor(), error: null }),
      };
      return chain;
    },
  };
  return { writes, service: { client } as any };
}

function service(
  tables: Record<string, any[]>,
  opts: {
    insertError?: any;
    processOrder?: any;
    issue?: any;
  } = {},
) {
  const stub = supabaseStub(tables, opts.insertError);
  const wallet = {
    processOrderTransaction: jest.fn().mockResolvedValue(
      opts.processOrder ?? {
        pointsChanged: 45,
        newBalance: 45,
        tier: 'Bronze',
        tierChanged: false,
      },
    ),
  };
  const whatsapp = { sendTextWithLog: jest.fn().mockResolvedValue(undefined) };
  const issuance = {
    issueForMember: jest
      .fn()
      .mockResolvedValue(
        opts.issue ?? { success: true, existing: false, passId: 'pass-1' },
      ),
    shortPassUrl: (id: string) => `http://localhost:3000/api/p/${id}`,
  };
  return {
    stub,
    wallet,
    whatsapp,
    issuance,
    svc: new PaymentsService(
      stub.service,
      wallet as any,
      whatsapp as any,
      issuance as any,
    ),
  };
}

function signedBody(overrides: Record<string, any> = {}) {
  return JSON.stringify({
    phone: '+919876543210',
    amountMinor: 45000,
    currency: 'INR',
    merchantRef: 'order_1',
    nonce: crypto.randomUUID(),
    timestamp: Date.now(),
    ...overrides,
  });
}

const TENANT = {
  id: 'tenant-1',
  name: 'Bean House',
  paymentWebhookSecret: SECRET,
};
const PROGRAM = { id: 'program-1', tenantId: 'tenant-1', kind: 'loyalty' };

describe('5.1 — signature verification', () => {
  it('accepts a correctly signed body', async () => {
    const { svc } = service({ Tenant: [TENANT], Program: [PROGRAM] });
    const body = signedBody();
    const res = await svc.handleWebhook(
      'tenant-1',
      body,
      signPaymentPayload(SECRET, body),
    );
    expect(res.success).toBe(true);
  });

  it('rejects a tampered body with 401', async () => {
    const { svc } = service({ Tenant: [TENANT], Program: [PROGRAM] });
    const body = signedBody();
    const sig = signPaymentPayload(SECRET, body);
    const tampered = signedBody({ amountMinor: 9999900 });
    await expect(
      svc.handleWebhook('tenant-1', tampered, sig),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a missing signature with 401', async () => {
    const { svc } = service({ Tenant: [TENANT], Program: [PROGRAM] });
    await expect(
      svc.handleWebhook('tenant-1', signedBody(), undefined),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('compares signatures without leaking length differences', () => {
    const sig = signPaymentPayload(SECRET, '{}');
    expect(signatureMatches(sig, sig)).toBe(true);
    expect(signatureMatches(sig, sig.slice(0, 10))).toBe(false);
    expect(signatureMatches(sig, undefined)).toBe(false);
  });
});

describe('5.1 — replay protection', () => {
  it('rejects a stale timestamp', async () => {
    const { svc } = service({ Tenant: [TENANT], Program: [PROGRAM] });
    const body = signedBody({
      timestamp: Date.now() - TIMESTAMP_TOLERANCE_MS - 1000,
    });
    await expect(
      svc.handleWebhook('tenant-1', body, signPaymentPayload(SECRET, body)),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a replayed nonce with 409 instead of awarding twice', async () => {
    const { svc, wallet } = service(
      { Tenant: [TENANT], Program: [PROGRAM] },
      { insertError: { code: '23505', message: 'duplicate key' } },
    );
    const body = signedBody();
    await expect(
      svc.handleWebhook('tenant-1', body, signPaymentPayload(SECRET, body)),
    ).rejects.toMatchObject({ status: 409 });
    expect(wallet.processOrderTransaction).not.toHaveBeenCalled();
  });

  it('is enforced by a unique index, not in-process memory', () => {
    expect(MIGRATION).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "PaymentEvent_tenantId_nonce_unique"',
    );
  });
});

describe('5.1 — normalization keeps the privacy boundary', () => {
  it('keeps only phone, amount, merchant ref and time', () => {
    const p = normalizePayment('mock', {
      phone: '+91 98765 43210',
      amountMinor: 45000,
      merchantRef: 'order_1',
      nonce: 'n1',
      timestamp: 123,
      card: { pan: '4111111111111111' },
      vpa: 'someone@upi',
    });
    expect(p.phone).toBe('+919876543210');
    expect(Object.keys(p).sort()).toEqual([
      'amountMinor',
      'currency',
      'merchantRef',
      'nonce',
      'occurredAt',
      'phone',
      'timestamp',
    ]);
  });

  it('rejects a non-positive amount', () => {
    expect(() =>
      normalizePayment('mock', { phone: '+919876543210', amountMinor: 0 }),
    ).toThrow();
  });

  it('refuses an unimplemented PSP rather than guessing its shape', () => {
    expect(() => normalizePayment('razorpay', {})).toThrow(/razorpay/);
  });

  it('defaults to the mock adapter when no provider is named', () => {
    expect(
      normalizePayment('', { phone: '+919876543210', amountMinor: 100 }),
    ).toMatchObject({ phone: '+919876543210' });
  });

  it('stores no card or UPI columns at all', () => {
    expect(MIGRATION).not.toMatch(/"(pan|vpa|cardToken|cardNumber)"/i);
  });
});

describe('5.2 — enrollment on payment', () => {
  it('enrolls an unknown phone and awards in one call', async () => {
    const { svc, stub, wallet } = service({
      Tenant: [TENANT],
      Program: [PROGRAM],
      Member: [],
    });
    const body = signedBody();
    const res = await svc.handleWebhook(
      'tenant-1',
      body,
      signPaymentPayload(SECRET, body),
    );

    expect(res.enrolled).toBe(true);
    expect(res.pointsAwarded).toBe(45);
    // ₹450.00 reaches the points pipeline as rupees, not paise.
    expect(wallet.processOrderTransaction).toHaveBeenCalledWith(
      'pass-1',
      450,
      'award',
      'webhook',
      'order_1',
      'payment-webhook',
      'tenant-1',
    );
    // Consent is *pending* for a payment-created member — no consentedAt.
    const memberWrite = stub.writes.find((w: any) => w.table === 'Member');
    expect(memberWrite.payload.consentedAt).toBeUndefined();
  });

  it('awards on the existing pass for a known phone', async () => {
    const { svc } = service(
      {
        Tenant: [TENANT],
        Program: [PROGRAM],
        Member: [
          { id: 'member-1', phone: '+919876543210', tenantId: 'tenant-1' },
        ],
      },
      { issue: { success: true, existing: true, passId: 'pass-1' } },
    );
    const body = signedBody();
    const res = await svc.handleWebhook(
      'tenant-1',
      body,
      signPaymentPayload(SECRET, body),
    );
    expect(res.enrolled).toBe(false);
    expect(res.memberId).toBe('member-1');
  });

  it.each(['ticket', 'studentid'])(
    'never scores a payment against a %s program',
    async (kind) => {
      const { svc } = service({
        Tenant: [TENANT],
        Program: [{ id: 'program-2', tenantId: 'tenant-1', kind }],
      });
      await expect(
        svc.resolveProgram('tenant-1', 'program-2'),
      ).rejects.toMatchObject({ status: 400 });
    },
  );

  // Phase 2 — a payment against a gift card sells/tops it up at face value.
  it('loads a gift card program instead of awarding points', async () => {
    const { svc, wallet } = service(
      {
        Tenant: [TENANT],
        Program: [{ id: 'program-gc', tenantId: 'tenant-1', kind: 'giftcard' }],
        Member: [],
      },
      { processOrder: { pointsChanged: 450, newBalance: 450, tier: 'Member' } },
    );
    const body = signedBody({ programId: 'program-gc' });
    const res = await svc.handleWebhook(
      'tenant-1',
      body,
      signPaymentPayload(SECRET, body),
    );

    expect(res.success).toBe(true);
    expect(wallet.processOrderTransaction).toHaveBeenCalledWith(
      'pass-1',
      450,
      'load',
      'webhook',
      'order_1',
      'payment-webhook',
      'tenant-1',
    );
  });

  it('still defaults to the loyalty program, never a gift card', async () => {
    const { svc } = service({
      Tenant: [TENANT],
      Program: [
        { id: 'program-gc', tenantId: 'tenant-1', kind: 'giftcard' },
        PROGRAM,
      ],
    });
    await expect(svc.resolveProgram('tenant-1')).resolves.toMatchObject({
      kind: 'loyalty',
    });
  });

  it('defaults to the tenant’s loyalty program, never another tenant’s', async () => {
    const { svc } = service({
      Tenant: [TENANT],
      Program: [
        PROGRAM,
        { id: 'other', tenantId: 'tenant-2', kind: 'loyalty' },
      ],
    });
    await expect(svc.resolveProgram('tenant-1')).resolves.toMatchObject({
      id: 'program-1',
    });
    await expect(svc.resolveProgram('tenant-1', 'other')).rejects.toMatchObject(
      { status: 404 },
    );
  });
});

/**
 * Phase 5 — adapter scaffold + loud failure on an ambiguous payment.
 */
describe('5 — PSP adapter registry', () => {
  it('exposes mock as the only adapter that ships', () => {
    expect(PAYMENT_ADAPTERS.map((a) => a.provider)).toEqual(['mock']);
  });

  it('resolves an adapter by provider, case-insensitively', () => {
    expect(adapterFor('MOCK')).toBeInstanceOf(MockAdapter);
    expect(adapterFor(undefined)).toBeInstanceOf(MockAdapter);
  });

  it('names the supported providers when one is unknown', () => {
    expect(() => adapterFor('cashfree')).toThrow(/Supported: mock/);
  });

  it('drops card and UPI fields rather than normalizing them through', () => {
    const p = new MockAdapter().normalize({
      phone: '+919876543210',
      amountMinor: 45000,
      nonce: 'n1',
      timestamp: 123,
      card: { pan: '4111111111111111' },
      vpa: 'someone@upi',
    });
    expect(p).not.toHaveProperty('card');
    expect(p).not.toHaveProperty('vpa');
  });
});

describe('5 — ambiguous multi-program payments', () => {
  const loyalty = (id: string) => ({
    id,
    tenantId: 'tenant-1',
    kind: 'loyalty',
  });

  it('refuses to guess when the tenant runs two loyalty programs', async () => {
    const { svc } = service({
      Tenant: [TENANT],
      Program: [loyalty('program-1'), loyalty('program-2')],
    });
    await expect(svc.resolveProgram('tenant-1')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('names programId as the fix', async () => {
    const { svc } = service({
      Tenant: [TENANT],
      Program: [loyalty('program-1'), loyalty('program-2')],
    });
    await expect(svc.resolveProgram('tenant-1')).rejects.toThrow(
      /programId required/,
    );
  });

  it('accepts an explicit programId when several exist', async () => {
    const { svc } = service({
      Tenant: [TENANT],
      Program: [loyalty('program-1'), loyalty('program-2')],
    });
    await expect(
      svc.resolveProgram('tenant-1', 'program-2'),
    ).resolves.toMatchObject({ id: 'program-2' });
  });

  it('still resolves silently when only one loyalty program exists', async () => {
    const { svc } = service({
      Tenant: [TENANT],
      Program: [
        loyalty('program-1'),
        { id: 'gc', tenantId: 'tenant-1', kind: 'giftcard' },
      ],
    });
    await expect(svc.resolveProgram('tenant-1')).resolves.toMatchObject({
      id: 'program-1',
    });
  });

  it('returns null when the tenant has no loyalty program at all', async () => {
    const { svc } = service({ Tenant: [TENANT], Program: [] });
    await expect(svc.resolveProgram('tenant-1')).resolves.toBeNull();
  });
});
