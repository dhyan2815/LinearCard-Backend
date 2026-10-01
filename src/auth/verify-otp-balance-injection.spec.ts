/**
 * Real-world scenario this guards against:
 *
 * A member opens the public enroll page (`/enroll/<tenantSlug>/<programSlug>`)
 * for a tiered loyalty program or a gift card, opens devtools, and replays the
 * `POST /auth/verify-otp` call with `balance`/`tier` added to the JSON body —
 * or simply scripts the call directly with curl/Postman, skipping the browser
 * entirely. Nothing about OTP verification or consent requires a browser.
 *
 * Before the fix: `VerifyOtpRequest` declared `tier`/`balance` as accepted
 * client fields, `auth.controller.ts` spread the whole body (minus a short
 * denylist) into `passData`, and `PassIssuanceService.issueForMember` read
 * `passData.balance` / `passData.tier` straight into the minted pass — so a
 * forged `"balance": "99999"` landed on the Wallet object and in the `Pass`
 * row, no payment, no admin action, no server-side computation involved.
 *
 * After the fix: `tier`/`balance` are stripped out of the body before
 * `passData` is built, so `issueForMember` only ever sees the real starting
 * balance the service itself computes from the program's entry tier.
 */
import { HttpException } from '@nestjs/common';
import { AuthController } from './auth.controller';

/** Minimal chainable Supabase stub: canned rows per table. */
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
          chain._inserted = [{ id: `${table}-1`, ...payload }];
          return chain;
        },
        update: (payload: any) => {
          writes.push({ table, op: 'update', payload });
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

const TENANT = { id: 'tenant-1', name: 'Kora Home', classSuffix: 'kora' };
// A real target: a tiered loyalty program, so a forged balance would also
// forge a tier (Gold at 500 pts) and the free-item unlocks that come with it.
const PROGRAM = {
  id: 'program-1',
  tenantId: 'tenant-1',
  kind: 'loyalty',
  enrollmentFields: null,
};
const OTP_SESSION = {
  id: 'otp-1',
  phone: '+919876543210',
  purpose: 'enrollment',
  tenantId: 'tenant-1',
  consumedAt: null,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

function controller(tables: Record<string, any[]>) {
  const { writes, service } = supabaseStub(tables);
  const otpService = {
    isOtpRateLimited: jest.fn().mockResolvedValue(false),
    verifyOtpAttempt: jest.fn().mockResolvedValue({ ok: true }),
  };
  const whatsappService = {
    sendPassLinkWithLog: jest.fn().mockResolvedValue(undefined),
    sendTextWithLog: jest.fn().mockResolvedValue(undefined),
  };
  const issuance = {
    // Mirrors the real service: it computes its own starting balance from
    // the program's entry tier and ignores anything the caller passes in
    // passData.balance — this test only needs to see WHAT the controller
    // forwards, not re-derive the service's own tier math.
    issueForMember: jest.fn().mockResolvedValue({
      success: true,
      existing: false,
      passId: 'pass-1',
      googleWalletUrl: 'https://pay.google.com/x',
    }),
  };
  const ctrl = new AuthController(
    service,
    otpService as any,
    whatsappService as any,
    issuance as any,
  );
  return { ctrl, writes, issuance };
}

describe('POST /auth/verify-otp — forged starting balance/tier', () => {
  it('drops a client-supplied balance before issuing the pass', async () => {
    const { ctrl, issuance } = controller({
      OtpSession: [OTP_SESSION],
      Tenant: [TENANT],
      Admin: [],
      Program: [PROGRAM],
    });

    await ctrl.verifyOtp(
      {
        phone: '+919876543210',
        otp: '1234',
        consentGiven: true,
        memberName: 'Attacker',
        // The forged payload a tampered client would send.
        balance: '99999',
        tier: 'Gold',
      } as any,
      { headers: {} } as any,
    );

    expect(issuance.issueForMember).toHaveBeenCalledTimes(1);
    const call = issuance.issueForMember.mock.calls[0][0];
    expect(call.passData).not.toHaveProperty('balance');
    expect(call.passData).not.toHaveProperty('tier');
    // The legitimate field alongside the attack payload still passes through.
    expect(call.passData.memberName).toBe('Attacker');
  });

  it('still issues a normal pass when no attack payload is present', async () => {
    const { ctrl, issuance } = controller({
      OtpSession: [OTP_SESSION],
      Tenant: [TENANT],
      Admin: [],
      Program: [PROGRAM],
    });

    const result = await ctrl.verifyOtp(
      {
        phone: '+919876543210',
        otp: '1234',
        consentGiven: true,
        memberName: 'Arjun',
      } as any,
      { headers: {} } as any,
    );

    expect(result.success).toBe(true);
    const call = issuance.issueForMember.mock.calls[0][0];
    expect(call.passData.memberName).toBe('Arjun');
    expect(call.passData).not.toHaveProperty('balance');
  });

  it('rejects the request before reaching issuance when the OTP is wrong', async () => {
    const { ctrl, issuance } = controller({
      OtpSession: [OTP_SESSION],
      Tenant: [TENANT],
      Admin: [],
      Program: [PROGRAM],
    });
    const otpService = (ctrl as any).otpService;
    otpService.verifyOtpAttempt.mockResolvedValueOnce({
      ok: false,
      locked: false,
    });

    await expect(
      ctrl.verifyOtp(
        {
          phone: '+919876543210',
          otp: '0000',
          consentGiven: true,
          balance: '99999',
        } as any,
        { headers: {} } as any,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(issuance.issueForMember).not.toHaveBeenCalled();
  });
});
