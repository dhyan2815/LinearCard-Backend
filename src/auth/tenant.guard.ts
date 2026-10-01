import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { JWT_SECRET } from '../env';

export interface ResolvedTenant {
  tenantId: string;
  role: string | null;
}

export type TenantRequest = Request & {
  tenantId?: string;
  authRole?: string | null;
};

function extractToken(req: Request): string | null {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  if (req.cookies?.admin_session) {
    const c = req.cookies.admin_session;
    return typeof c === 'object' && c?.value ? c.value : c;
  }
  const rawCookie = req.headers['cookie'];
  if (rawCookie) {
    const match = rawCookie.match(/(?:^|;\s*)admin_session=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

/**
 * Single tenant-resolution path: JWT (bearer/cookie) first, falling back to
 * a Tenant.apiKey lookup. Used both as a hard guard (canActivate) and, via
 * resolveTenant(), as a soft/optional resolver for routes that allow
 * anonymous callers but still want to identify a tenant when possible.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly supabaseService: SupabaseService) {}

  async resolveTenant(req: Request): Promise<ResolvedTenant | null> {
    const token = extractToken(req);
    if (!token) return null;

    try {
      const decoded: any = jwt.verify(token, JWT_SECRET);
      if (decoded?.tenantId) {
        let finalTenantId = decoded.tenantId;
        if (decoded.role === 'admin') {
          const requestedTenant = req.query.tenantId || req.body.tenantId;
          if (requestedTenant && typeof requestedTenant === 'string') {
            finalTenantId = requestedTenant;
          }
        }
        return { tenantId: finalTenantId, role: decoded.role ?? null };
      }
    } catch {
      // Not a JWT (or expired) — fall through to the API-key lookup.
    }

    // Hashed ApiKey table first (current path for keys issued via
    // POST /developers/api-keys). Falls back to the legacy plaintext
    // Tenant.apiKey column only when no hashed row matches, so existing
    // tenants' keys keep working during the migration window — new keys
    // are never written there again.
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const { data: apiKey } = await this.supabaseService.client
      .from('ApiKey')
      .select('id, tenantId, revokedAt')
      .eq('hash', hash)
      .is('revokedAt', null)
      .single();

    if (apiKey) {
      // Best-effort; must never block/fail auth on a logging write.
      Promise.resolve(
        this.supabaseService.client
          .from('ApiKey')
          .update({ lastUsedAt: new Date().toISOString() })
          .eq('id', apiKey.id),
      ).catch(() => {});
      return { tenantId: apiKey.tenantId, role: null };
    }

    const { data: tenant } = await this.supabaseService.client
      .from('Tenant')
      .select('id')
      .eq('apiKey', token)
      .single();

    if (tenant) return { tenantId: tenant.id, role: null };

    return null;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<TenantRequest>();

    const resolved = await this.resolveTenant(req);
    if (!resolved) {
      throw new UnauthorizedException(
        'Unauthorized: Missing or invalid authentication',
      );
    }
    req.tenantId = resolved.tenantId;
    req.authRole = resolved.role;
    return true;
  }
}
