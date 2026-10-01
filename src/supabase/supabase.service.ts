import '../env';
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as jwt from 'jsonwebtoken';

@Injectable()
export class SupabaseService implements OnModuleInit {
  private readonly logger = new Logger(SupabaseService.name);
  private _client: SupabaseClient;
  private _url: string;
  private _anonKey?: string;
  private _jwtSecret?: string;
  /** One client per tenant; a Supabase client is cheap but not free. */
  private readonly _tenantClients = new Map<string, SupabaseClient>();
  private _warnedNoRlsPath = false;

  onModuleInit() {
    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      this.logger.error('Missing Supabase environment variables');
      throw new Error('Missing Supabase environment variables');
    }

    this._url = supabaseUrl;
    this._anonKey =
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      process.env.SUPABASE_ANON_KEY;
    this._jwtSecret = process.env.SUPABASE_JWT_SECRET;

    this._client = createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  /**
   * The service-role client. Bypasses RLS by design — every query made
   * through it must still filter by tenantId itself.
   */
  get client(): SupabaseClient {
    return this._client;
  }

  /** Whether the non-service-role read path is actually available. */
  get hasRlsReadPath(): boolean {
    return !!(this._anonKey && this._jwtSecret);
  }

  /**
   * Phase 7.3 — a read path that is **not** service-role.
   *
   * The client returned here authenticates as the Postgres `authenticated`
   * role carrying a `tenant_id` claim, so the RLS policies added in the
   * Phase 7 migration are what enforces isolation, not the presence of an
   * `.eq('tenantId', …)` the developer might forget. A query that forgets
   * the filter returns this tenant's rows, not every tenant's.
   *
   * Falls back to the service-role client (with one warning) when
   * SUPABASE_ANON_KEY / SUPABASE_JWT_SECRET are unset, so an operator who
   * has not yet configured them gets today's behaviour rather than an
   * outage. Callers must therefore keep their explicit tenantId filters:
   * RLS is the second line of defence, never the only one.
   */
  forTenant(tenantId: string): SupabaseClient {
    if (!this.hasRlsReadPath) {
      if (!this._warnedNoRlsPath) {
        this._warnedNoRlsPath = true;
        this.logger.warn(
          'SUPABASE_ANON_KEY / SUPABASE_JWT_SECRET not set — tenant reads fall back to the service-role client and RLS is not exercised.',
        );
      }
      return this._client;
    }

    const cached = this._tenantClients.get(tenantId);
    if (cached) return cached;

    // 1h: comfortably longer than any request, short enough that a revoked
    // tenant stops being readable without a process restart.
    const token = jwt.sign(
      {
        role: 'authenticated',
        sub: tenantId,
        tenant_id: tenantId,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      this._jwtSecret!,
    );

    const client = createClient(this._url, this._anonKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    this._tenantClients.set(tenantId, client);
    // ponytail: cache never evicts, and the token it holds expires in an
    // hour. Drop the entry just before then rather than tracking expiry.
    setTimeout(
      () => this._tenantClients.delete(tenantId),
      55 * 60_000,
    ).unref?.();
    return client;
  }
}
