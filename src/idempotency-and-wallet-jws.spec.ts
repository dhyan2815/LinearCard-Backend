import * as crypto from 'crypto';
import {
  verifyWalletCallback,
  __setRootKeyCache,
  SignatureError,
} from './wallet/google-jws';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { WalletService } from './wallet/wallet.service';
import { of, lastValueFrom, throwError } from 'rxjs';

/**
 * Phase 7 checks. Deliberately narrow: the money/security paths only.
 *   7.1 idempotency — a replay must not run the handler twice
 *   7.2 JWS        — a forged callback must not verify
 *   7.5 resync     — a design push must not overwrite live balances
 *   7.7 defaults   — a pass must not be issued with demo values
 */

// ── 7.2 ──────────────────────────────────────────────────────────────────
describe('Phase 7.2 — Google Wallet callback signature verification', () => {
  const ISSUER = '3388000000012345678';

  const ec = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });

  const spkiB64 = (key: crypto.KeyObject) =>
    key.export({ type: 'spki', format: 'der' }).toString('base64');

  const signedBytes = (...parts: string[]) => {
    const chunks: Buffer[] = [];
    for (const p of parts) {
      const b = Buffer.from(p, 'utf8');
      const len = Buffer.alloc(4);
      len.writeUInt32LE(b.length, 0);
      chunks.push(len, b);
    }
    return Buffer.concat(chunks);
  };

  const sign = (key: crypto.KeyObject, msg: Buffer) =>
    crypto.sign('sha256', msg, key).toString('base64');

  /** Builds a callback envelope the way Google does. */
  const envelopeFor = (
    message: object,
    opts: { rootKey?: crypto.KeyPairKeyObjectResult } = {},
  ) => {
    const root = opts.rootKey || rootPair;
    const signedMessage = JSON.stringify(message);
    const signedKey = JSON.stringify({
      keyValue: spkiB64(intermediatePair.publicKey),
      keyExpiration: String(Date.now() + 60_000),
    });
    return {
      protocolVersion: 'ECv2SigningOnly',
      intermediateSigningKey: {
        signedKey,
        signatures: [
          sign(
            root.privateKey,
            signedBytes('GooglePayPasses', 'ECv2SigningOnly', signedKey),
          ),
        ],
      },
      signedMessage,
      signature: sign(
        intermediatePair.privateKey,
        signedBytes(
          'GooglePayPasses',
          ISSUER,
          'ECv2SigningOnly',
          signedMessage,
        ),
      ),
    };
  };

  let rootPair: crypto.KeyPairKeyObjectResult;
  let intermediatePair: crypto.KeyPairKeyObjectResult;

  beforeEach(() => {
    rootPair = ec();
    intermediatePair = ec();
    __setRootKeyCache([
      {
        keyValue: spkiB64(rootPair.publicKey),
        protocolVersion: 'ECv2SigningOnly',
      },
    ]);
  });

  afterAll(() => __setRootKeyCache(null));

  it('accepts a correctly signed callback and returns the message', async () => {
    const message = { objectId: 'iss.abc', eventType: 'save', nonce: 'n1' };
    const decoded = await verifyWalletCallback(envelopeFor(message), ISSUER);
    expect(decoded).toEqual(message);
  });

  it('rejects a forged del (SEC-2): unsigned envelope does not verify', async () => {
    const forged = {
      protocolVersion: 'ECv2SigningOnly',
      signedMessage: JSON.stringify({ objectId: 'iss.abc', eventType: 'del' }),
      signature: Buffer.from('nope').toString('base64'),
      intermediateSigningKey: { signedKey: '{}', signatures: ['nope'] },
    };
    await expect(verifyWalletCallback(forged, ISSUER)).rejects.toBeInstanceOf(
      SignatureError,
    );
  });

  it('rejects an intermediate key signed by a key Google does not publish', async () => {
    const attackerRoot = ec();
    await expect(
      verifyWalletCallback(
        envelopeFor(
          { objectId: 'x', eventType: 'del' },
          { rootKey: attackerRoot },
        ),
        ISSUER,
      ),
    ).rejects.toThrow(/not signed by any current Google root key/);
  });

  it('rejects a message tampered with after signing', async () => {
    const envelope = envelopeFor({ objectId: 'iss.abc', eventType: 'save' });
    envelope.signedMessage = JSON.stringify({
      objectId: 'iss.abc',
      eventType: 'del',
    });
    await expect(verifyWalletCallback(envelope, ISSUER)).rejects.toThrow(
      /signature did not verify/,
    );
  });

  it('rejects a callback signed for a different issuer', async () => {
    await expect(
      verifyWalletCallback(
        envelopeFor({ objectId: 'iss.abc', eventType: 'save' }),
        '9999000000099999999',
      ),
    ).rejects.toThrow(/signature did not verify/);
  });
});

// ── 7.1 ──────────────────────────────────────────────────────────────────
describe('Phase 7.1 — idempotency keys', () => {
  /** Minimal Supabase stub backed by an in-memory table. */
  const stub = (rows: any[] = []) => {
    const table = rows;
    const client = {
      from: () => ({
        select: () => ({
          eq: (_c1: string, v1: any) => ({
            eq: (_c2: string, v2: any) => ({
              eq: (_c3: string, v3: any) => ({
                maybeSingle: async () => ({
                  data:
                    table.find(
                      (r) => r.key === v1 && r.method === v2 && r.path === v3,
                    ) || null,
                }),
              }),
            }),
          }),
        }),
        insert: (row: any) => ({
          select: () => ({
            single: async () => {
              const clash = table.find(
                (r) =>
                  r.key === row.key &&
                  r.method === row.method &&
                  r.path === row.path,
              );
              if (clash) return { data: null, error: { message: 'duplicate' } };
              const created = { id: `rec_${table.length}`, ...row };
              table.push(created);
              return { data: created, error: null };
            },
          }),
        }),
        update: (patch: any) => ({
          eq: async (_c: string, id: string) => {
            const row = table.find((r) => r.id === id);
            if (row) Object.assign(row, patch);
            return { error: null };
          },
        }),
        delete: () => ({
          eq: async (_c: string, id: string) => {
            const i = table.findIndex((r) => r.id === id);
            if (i >= 0) table.splice(i, 1);
            return { error: null };
          },
        }),
      }),
    };
    return { client, table };
  };

  const ctx = (req: any) =>
    ({
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({
          statusCode: 201,
          status: jest.fn(),
          setHeader: jest.fn(),
        }),
      }),
    }) as any;

  const request = (over: any = {}) => ({
    method: 'POST',
    path: '/passes/process-order',
    url: '/passes/process-order',
    headers: { 'idempotency-key': 'key-1' },
    body: { amount: 450 },
    tenantId: 't1',
    ...over,
  });

  it('runs the handler once and replays the stored response on a retry', async () => {
    const { client, table } = stub();
    const interceptor = new IdempotencyInterceptor({ client } as any);
    const handler = jest.fn(() => of({ success: true, awarded: 45 }));

    const first = await lastValueFrom(
      await interceptor.intercept(ctx(request()), { handle: handler } as any),
    );
    expect(first).toEqual({ success: true, awarded: 45 });
    expect(handler).toHaveBeenCalledTimes(1);
    // Stored by the tap, so the replay below has something to return.
    expect(table[0].completedAt).toBeTruthy();

    const second = await lastValueFrom(
      await interceptor.intercept(ctx(request()), { handle: handler } as any),
    );
    // The point of the whole phase: 45 points were awarded once, not twice.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ success: true, awarded: 45 });
  });

  it('rejects the same key used with a different body', async () => {
    const { client } = stub();
    const interceptor = new IdempotencyInterceptor({ client } as any);
    const handler = { handle: () => of({ ok: true }) } as any;

    await lastValueFrom(await interceptor.intercept(ctx(request()), handler));

    await expect(
      interceptor.intercept(ctx(request({ body: { amount: 9999 } })), handler),
    ).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_REUSED' },
    });
  });

  it('releases the key when the handler fails, so a real retry can proceed', async () => {
    const { client, table } = stub();
    const interceptor = new IdempotencyInterceptor({ client } as any);
    const failing = {
      handle: () => throwError(() => new Error('Google 503')),
    } as any;

    await expect(
      lastValueFrom(await interceptor.intercept(ctx(request()), failing)),
    ).rejects.toThrow('Google 503');
    expect(table).toHaveLength(0);
  });

  it('ignores requests without a key, and GETs entirely', async () => {
    const { client, table } = stub();
    const interceptor = new IdempotencyInterceptor({ client } as any);
    const handler = { handle: () => of('passthrough') } as any;

    await lastValueFrom(
      await interceptor.intercept(ctx(request({ headers: {} })), handler),
    );
    await lastValueFrom(
      await interceptor.intercept(ctx(request({ method: 'GET' })), handler),
    );
    expect(table).toHaveLength(0);
  });
});

// ── 7.5 / 7.7 ────────────────────────────────────────────────────────────
describe('Phase 7.5 — resync pushes the full design without touching live values', () => {
  const makeWallet = () =>
    new WalletService({} as any, {} as any, {} as any, {} as any, {} as any);

  /** The generic object as it stands on a member's phone today. */
  const liveObject = {
    textModulesData: [
      { id: 'memberName', header: 'Member', body: 'Asha' },
      { id: 'points', header: 'Points', body: '340 Pts' },
      { id: 'tier', header: 'Tier', body: 'Gold' },
      { id: 'perk', header: 'Perk', body: 'Old copy' },
    ],
  };

  const capturePatch = async (updateData: any) => {
    const service = makeWallet();
    let patch: any;
    jest.spyOn(service, 'getGoogleAuthClient' as any).mockResolvedValue({
      request: jest.fn(async (req: any) => {
        if (req.method === 'GET') return { data: liveObject };
        patch = req.data;
        return { data: {} };
      }),
    } as any);
    await service.updateGenericObject('iss.pass-1', updateData);
    return patch;
  };

  it('applies new headers and static copy from the template rows', async () => {
    const patch = await capturePatch({
      hexBackgroundColor: '#112233',
      logoUrl: 'https://cdn.example.com/logo.png',
      heroImageUrl: 'https://cdn.example.com/hero.png',
      rows: [
        {
          id: 'r1',
          columns: [
            { key: 'memberName', header: 'Name' },
            // WAL-1: renamed header, same stable key.
            { key: 'points', header: 'Stars' },
            { key: 'tier', header: 'Status' },
            { key: 'perk', header: 'Perk', body: 'Free refill' },
          ],
        },
      ],
    });

    // WAL-6: these three used to be silently dropped.
    expect(patch.hexBackgroundColor).toBe('#112233');
    expect(patch.logo.sourceUri.uri).toBe('https://cdn.example.com/logo.png');
    expect(patch.heroImage.sourceUri.uri).toBe(
      'https://cdn.example.com/hero.png',
    );

    const byId = Object.fromEntries(
      patch.textModulesData.map((m: any) => [m.id, m]),
    );
    expect(byId.points.header).toBe('Stars');
    expect(byId.perk.body).toBe('Free refill');

    // The whole risk of pushing rows: a design change must never reset
    // someone's balance, tier or name to the template's placeholder.
    expect(byId.points.body).toBe('340 Pts');
    expect(byId.tier.body).toBe('Gold');
    expect(byId.memberName.body).toBe('Asha');
  });

  it('still updates balance and tier when the transaction path supplies them', async () => {
    const patch = await capturePatch({ balance: 500, tier: 'Platinum' });
    const byId = Object.fromEntries(
      patch.textModulesData.map((m: any) => [m.id, m]),
    );
    expect(byId.points.body).toBe('500 Pts');
    expect(byId.tier.body).toBe('Platinum');
  });
});

describe('Phase 7.7 — no demo values as production defaults (WAL-7)', () => {
  const service = () =>
    new WalletService({} as any, {} as any, {} as any, {} as any, {} as any);

  it('refuses to issue a pass with missing identity fields', async () => {
    await expect(
      service().createGoogleWalletPass({ passId: 'p1' }),
    ).rejects.toMatchObject({
      response: { code: 'TEMPLATE_INVALID' },
    });
  });

  it('names every field it is missing, rather than inventing one', async () => {
    await expect(
      service().createGoogleWalletPass({
        passId: 'p1',
        memberName: 'Asha',
        cardTitle: 'Bean House',
        balance: '0',
      }),
    ).rejects.toThrow(/classSuffix/);
  });

  it('declares real save-link origins instead of an empty list (WAL-8)', () => {
    const prev = process.env.WALLET_SAVE_ORIGINS;
    process.env.WALLET_SAVE_ORIGINS =
      'https://linearcard.vercel.app/dashboard, not-a-url ,';
    try {
      expect((service() as any).saveLinkOrigins()).toEqual([
        'https://linearcard.vercel.app',
      ]);
    } finally {
      if (prev === undefined) delete process.env.WALLET_SAVE_ORIGINS;
      else process.env.WALLET_SAVE_ORIGINS = prev;
    }
  });
});
