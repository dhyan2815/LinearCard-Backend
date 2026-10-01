/**
 * Phase 0 — "Stop the Bleeding" regressions.
 * One file, one assertion per defect the phase closed.
 */
import { PassesController } from './passes/passes.controller';
import { TenantGuard } from './auth/tenant.guard';
import { OtpService } from './notification/otp.service';
import { WalletService } from './wallet/wallet.service';

const guardsOn = (method: string) =>
  (
    Reflect.getMetadata(
      '__guards__',
      (PassesController.prototype as any)[method],
    ) || []
  ).map((g: any) => g.name || g.constructor?.name);

describe('Phase 0.3 — endpoints that leaked are now guarded', () => {
  it('SEC-1: validate-pass requires a tenant session', () => {
    expect(guardsOn('postvalidatepass')).toContain(TenantGuard.name);
  });

  it('SEC-3: create-class requires a tenant session', () => {
    expect(guardsOn('postcreateclass')).toContain(TenantGuard.name);
  });
});

describe('Phase 0.3 — SEC-4: OTP verify attempt limiting', () => {
  const makeService = () => {
    const update = jest
      .fn()
      .mockReturnValue({ eq: jest.fn().mockResolvedValue({}) });
    const service = new OtpService({
      client: { from: () => ({ update }) },
    } as any);
    return { service, update };
  };

  it('locks (and burns the session) on the 5th wrong guess', async () => {
    const { service, update } = makeService();
    const session = {
      id: 's1',
      otpHash: service.hashOtp('1234'),
      attempts: OtpService.MAX_VERIFY_ATTEMPTS - 1,
    };

    const result = await service.verifyOtpAttempt('9999', session);

    expect(result).toEqual({ ok: false, locked: true });
    expect(update.mock.calls[0][0]).toHaveProperty('consumedAt');
  });

  it('refuses a correct code once the session is already locked', async () => {
    const { service } = makeService();
    const session = {
      id: 's1',
      otpHash: service.hashOtp('1234'),
      attempts: OtpService.MAX_VERIFY_ATTEMPTS,
    };

    await expect(service.verifyOtpAttempt('1234', session)).resolves.toEqual({
      ok: false,
      locked: true,
    });
  });

  it('accepts a correct code below the limit', async () => {
    const { service } = makeService();
    await expect(
      service.verifyOtpAttempt('1234', {
        id: 's1',
        otpHash: service.hashOtp('1234'),
        attempts: 2,
      }),
    ).resolves.toEqual({ ok: true, locked: false });
  });
});

describe('Phase 0.2 — ENV-1/ENV-4: environment isolation', () => {
  const service = () =>
    new WalletService({} as any, {} as any, {} as any, {} as any, {} as any);
  const withEnv = (
    vars: Record<string, string | undefined>,
    fn: () => void,
  ) => {
    const saved = { ...process.env };
    // Assigning undefined to process.env yields the string "undefined".
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      fn();
    } finally {
      process.env = saved;
    }
  };

  it('prefixes class ids outside production, and leaves production ids untouched', () => {
    withEnv({ WALLET_ENV_PREFIX: undefined, VERCEL_ENV: undefined }, () => {
      expect(service().resolveClassId('123', 'beanhouse')).toBe(
        '123.dev_beanhouse',
      );
    });
    withEnv({ WALLET_ENV_PREFIX: undefined, VERCEL_ENV: 'preview' }, () => {
      expect(service().resolveClassId('123', 'beanhouse')).toBe(
        '123.preview_beanhouse',
      );
    });
    withEnv({ WALLET_ENV_PREFIX: undefined, VERCEL_ENV: 'production' }, () => {
      expect(service().resolveClassId('123', 'beanhouse')).toBe(
        '123.beanhouse',
      );
    });
  });

  it('refuses to build a localhost callback URL', () => {
    withEnv(
      {
        PUBLIC_CALLBACK_URL: undefined,
        NEXT_PUBLIC_API_URL: 'http://localhost:3001',
        VERCEL_URL: undefined,
        NEXT_PUBLIC_VERCEL_BRANCH_URL: undefined,
      },
      () => {
        expect(() => service().resolveCallbackUrl()).toThrow(/localhost/i);
      },
    );
  });

  it('accepts an explicit public tunnel URL and appends the webhook secret', () => {
    withEnv(
      {
        PUBLIC_CALLBACK_URL: 'https://tunnel.example.com/',
        WALLET_WEBHOOK_SECRET: 's3cret',
      },
      () => {
        expect(service().resolveCallbackUrl()).toBe(
          'https://tunnel.example.com/passes/webhooks/google-wallet/s3cret',
        );
      },
    );
  });
});
