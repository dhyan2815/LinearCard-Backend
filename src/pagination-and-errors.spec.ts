/**
 * Phase 6 — "Admin & frontline experience".
 * One assertion per thing the phase promises.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ServiceError, walletError, describeError } from './errors';
import { rulesForPass, DEFAULT_LOYALTY_RULES } from './wallet/wallet.service';

const read = (rel: string) =>
  fs.readFileSync(path.resolve(__dirname, rel), 'utf8');

describe('6.1 — pagination (FE-3)', () => {
  it('members are counted, so a caller can page instead of slicing locally', () => {
    // Phase 8 extracted the query itself into members/member-query.ts, which
    // the program-scoped list shares; the controller still returns the count.
    const src = read('members/members.controller.ts');
    const query = read('members/member-query.ts');
    expect(query).toContain("{ count: 'exact' }");
    expect(src).toContain('total: count ?? 0');
    expect(query).toContain(
      '.range(opts.offset, opts.offset + opts.limit - 1)',
    );
  });

  it('the notification log is offset-paged and tenant-guarded', () => {
    const src = read('notifications/notifications.controller.ts');
    expect(src).toContain('@UseGuards(TenantGuard)');
    // The tenant comes from the guard, never from ?tenantId=.
    expect(src).toContain('const tenantId = req.tenantId;');
    expect(src).toContain('offset');
    expect(src).toContain("{ count: 'exact' }");
  });

  it('the members page asks the server for one page, not the whole table', () => {
    // Phase 8 moved this view under its program; /dashboard/members is now a
    // redirect stub. The paging assertion follows the page that does the work.
    const src = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../web/app/dashboard/programs/[id]/members/page.tsx',
      ),
      'utf8',
    );
    expect(src).toContain('offset: String(offset)');
    // The old client-side slice is gone.
    expect(src).not.toContain('sortedMembers.slice');
  });
});

describe('6.2 — typed error taxonomy', () => {
  it('maps a Google 403 to a stable code, not a raw HTTP message', () => {
    const err = walletError(
      {
        response: { status: 403 },
        message: 'Request failed with status code 403',
      },
      'publishing class X',
    );
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.code).toBe('WALLET_PERMISSION_DENIED');
    expect(err.getStatus()).toBe(502);
  });

  it('maps a transport failure with no HTTP status to WALLET_UNAVAILABLE', () => {
    expect(walletError(new Error('ECONNREFUSED'), 'x').code).toBe(
      'WALLET_UNAVAILABLE',
    );
  });

  it('never re-wraps an already typed error', () => {
    const original = new ServiceError('WALLET_CALLBACK_UNSAFE', 'nope');
    expect(walletError(original, 'x')).toBe(original);
  });

  it('logs a cause a delivery report can group by', () => {
    expect(
      describeError(new ServiceError('WHATSAPP_SEND_FAILED', 'boom')),
    ).toBe('WHATSAPP_SEND_FAILED: boom');
    expect(describeError(new Error('boom'))).toBe('UNKNOWN: boom');
  });

  it('rejects a field layout Google would silently drop (Passmint §C)', () => {
    const src = read('templates/templates.controller.ts');
    expect(src).toContain('validateFieldRows');
    expect(src).toContain('at most 3 rows');
    expect(src).toContain('between 1 and 3 columns');
    expect(src).toContain('duplicate field key');
  });
});

describe('6.3 — the scanner shows the economics the server will apply', () => {
  it('prefers the program row over the template fallback', () => {
    const rules = rulesForPass(
      { earnRate: 0.25, redeemRate: 2, redeemCapPercent: 30 },
      [{ status: 'published', earnRate: 0.1 }],
      null,
    );
    expect(rules).toEqual({
      earnRate: 0.25,
      redeemRate: 2,
      redeemCapPercent: 30,
      visitMode: false,
      rewardThreshold: null,
    });
  });

  it('falls back to the templates, then the defaults', () => {
    expect(rulesForPass(null, [], null)).toEqual(DEFAULT_LOYALTY_RULES);
    expect(
      rulesForPass(null, [{ status: 'published', earnRate: 0.05 }], null)
        .earnRate,
    ).toBe(0.05);
  });

  it('validate-pass hands the scanner the rules and the program kind', () => {
    const src = read('passes/passes.controller.ts');
    expect(src).toContain('rules: rulesForPass(');
    expect(src).toContain('programKind');
  });

  it('the scan page no longer hardcodes 10% / 50%', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../web/app/scan/page.tsx'),
      'utf8',
    );
    expect(src).toContain('parsedAmount * rules.earnRate');
    expect(src).not.toContain('parsedAmount * 0.10');
    expect(src).not.toContain('parsedAmount * 0.50');
  });
});

describe('6.4 — debug logging is gone from the auth path (SEC-7, FE-6)', () => {
  it('TenantGuard logs neither tokens nor resolved tenant ids', () => {
    expect(read('auth/tenant.guard.ts')).not.toContain('console.log');
  });

  it('the tenant controller and admin login are quiet too', () => {
    expect(read('tenant/tenant.controller.ts')).not.toContain('console.log');
    expect(read('auth/auth.controller.ts')).not.toContain(
      'admin_session cookie set',
    );
  });

  it('the API client no longer narrates every response', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../web/lib/api-client.ts'),
      'utf8',
    );
    expect(src).not.toContain('console.debug');
  });
});

describe('6.5 — demo:reset is allowlist-scoped (0.2b, D13)', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../scripts/demo-reset.ts'),
    'utf8',
  );

  it('refuses to run without an explicit tenant allowlist and --yes', () => {
    expect(src).toContain('No tenant allowlist');
    expect(src).toContain('Refusing to run without --yes');
  });

  it('never truncates and never deletes by negation', () => {
    // A bare `.delete()` with no tenant filter, or a delete by negation,
    // would take out every tenant's rows.
    expect(src).not.toMatch(/truncate\s+table/i);
    expect(src).not.toMatch(/\.delete\(\)\s*$/m);
    expect(src).not.toMatch(/\.neq\(\s*'tenantId'/);
    // Every clearing delete is pinned to an allowlisted tenant id.
    expect(src).toContain(".delete().eq('tenantId', tenantId)");
  });
});

describe('6.6 — enrollment defaults to +91 (FE-5)', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../web/app/enroll/EnrollFlow.tsx'),
    'utf8',
  );

  it('opens on India and uses a native picker', () => {
    expect(src).toContain("useState('+91')");
    expect(src.indexOf("code: '+91'")).toBeLessThan(src.indexOf("code: '+1'"));
    expect(src).toContain('<select');
  });

  it('drops the hand-rolled text-match dropdown', () => {
    expect(src).not.toContain('filteredCountries');
    expect(src).not.toContain('isDropdownOpen');
  });
});
