import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { TenantGuard } from './tenant.guard';
import { JWT_SECRET } from '../env';

function makeContext(req: any): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext;
}

/** A from() mock that resolves every table's chained select/eq/is to `single`. */
function makeSingleTableMock(
  byTable: Record<string, any>,
  fallback: any = { data: null, error: null },
) {
  return jest.fn((table: string) => {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      update: () => chain,
      single: async () => byTable[table] ?? fallback,
    };
    return chain;
  });
}

describe('TenantGuard', () => {
  let supabaseServiceMock: any;
  let guard: TenantGuard;

  beforeEach(() => {
    supabaseServiceMock = {
      client: {
        from: makeSingleTableMock({}),
      },
    };
    guard = new TenantGuard(supabaseServiceMock);
  });

  it('resolves tenantId from a valid Bearer JWT', async () => {
    const token = jwt.sign({ tenantId: 'tenant-1', role: 'staff' }, JWT_SECRET);
    const req: any = { headers: { authorization: `Bearer ${token}` } };

    const ok = await guard.canActivate(makeContext(req));

    expect(ok).toBe(true);
    expect(req.tenantId).toBe('tenant-1');
    expect(req.authRole).toBe('staff');
  });

  it('resolves tenantId from a valid admin_session cookie JWT', async () => {
    const token = jwt.sign({ tenantId: 'tenant-2' }, JWT_SECRET);
    const req: any = {
      headers: {},
      cookies: { admin_session: token },
    };

    const ok = await guard.canActivate(makeContext(req));

    expect(ok).toBe(true);
    expect(req.tenantId).toBe('tenant-2');
  });

  it('falls back to a legacy Tenant.apiKey lookup when no hashed ApiKey row matches', async () => {
    supabaseServiceMock.client.from = makeSingleTableMock({
      ApiKey: { data: null },
      Tenant: { data: { id: 'tenant-3' } },
    });
    const req: any = { headers: { authorization: 'Bearer some-api-key' } };

    const ok = await guard.canActivate(makeContext(req));

    expect(ok).toBe(true);
    expect(req.tenantId).toBe('tenant-3');
    expect(req.authRole).toBeNull();
  });

  it('rejects with 401 when neither a valid JWT nor a matching API key is found', async () => {
    const req: any = { headers: { authorization: 'Bearer garbage' } };

    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects with 401 when no credentials are supplied at all', async () => {
    const req: any = { headers: {} };

    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  describe('resolveTenant (soft resolution)', () => {
    it('returns null instead of throwing when no credentials are present', async () => {
      const req: any = { headers: {} };
      const result = await guard.resolveTenant(req);
      expect(result).toBeNull();
    });
  });
});

describe('TenantGuard.resolveTenant — hashed ApiKey path', () => {
  function makeReq(token: string) {
    return {
      headers: { authorization: `Bearer ${token}` },
      cookies: {},
    } as any;
  }

  it('resolves via the hashed ApiKey table when a live row matches, and touches lastUsedAt', async () => {
    const rawKey = 'lc_live_abc123';
    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const client: any = {
      from: jest.fn((table: string) => {
        if (table === 'ApiKey') {
          return {
            select: () => client.from('ApiKey'),
            eq: () => client.from('ApiKey'),
            is: () => client.from('ApiKey'),
            single: async () => ({
              data: { id: 'k1', tenantId: 'tenant-a', revokedAt: null },
            }),
            update: () => ({ eq: updateEq }),
          };
        }
        // Legacy Tenant.apiKey lookup should never be reached here.
        return {
          select: () => client.from(table),
          eq: () => client.from(table),
          single: async () => ({ data: null }),
        };
      }),
    };

    const guard = new TenantGuard({ client } as any);
    const resolved = await guard.resolveTenant(makeReq(rawKey));

    expect(resolved).toEqual({ tenantId: 'tenant-a', role: null });
    expect(updateEq).toHaveBeenCalledWith('id', 'k1');
  });

  it('hashes the raw token with SHA-256 before looking it up', async () => {
    const rawKey = 'lc_live_xyz';
    const expectedHash = crypto
      .createHash('sha256')
      .update(rawKey)
      .digest('hex');
    let capturedHash: string | undefined;
    const client: any = {
      from: jest.fn((table: string) => {
        if (table === 'ApiKey') {
          return {
            select: () => client.from('ApiKey'),
            eq: (col: string, val: string) => {
              if (col === 'hash') capturedHash = val;
              return client.from('ApiKey');
            },
            is: () => client.from('ApiKey'),
            single: async () => ({ data: null }),
          };
        }
        return {
          select: () => client.from(table),
          eq: () => client.from(table),
          single: async () => ({ data: null }),
        };
      }),
    };

    const guard = new TenantGuard({ client } as any);
    await guard.resolveTenant(makeReq(rawKey));

    expect(capturedHash).toBe(expectedHash);
  });

  it('a revoked key (no unrevoked row) falls through to legacy and finds no tenant', async () => {
    const rawKey = 'revoked-key';
    const client: any = {
      from: jest.fn((table: string) => ({
        select: () => client.from(table),
        eq: () => client.from(table),
        is: () => client.from(table),
        single: async () => ({ data: null }), // .is('revokedAt', null) excludes it; legacy Tenant lookup also empty
      })),
    };

    const guard = new TenantGuard({ client } as any);
    const resolved = await guard.resolveTenant(makeReq(rawKey));

    expect(resolved).toBeNull();
  });
});
