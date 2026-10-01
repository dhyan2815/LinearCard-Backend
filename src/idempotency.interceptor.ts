import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import {
  Observable,
  from,
  of,
  switchMap,
  tap,
  catchError,
  throwError,
} from 'rxjs';
import * as crypto from 'crypto';
import { SupabaseService } from './supabase/supabase.service';
import { TenantRequest } from './auth/tenant.guard';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Phase 7.1 — idempotency keys on mutating endpoints (PRD §8).
 *
 * This is the real fix behind Phase 0.5, which only stopped the *frontend*
 * from retrying a POST. It did nothing about the two cases that actually
 * lose money: a customer double-tapping "Redeem", and a PSP re-delivering a
 * webhook it never saw acknowledged. Both send the same request twice, and
 * before this the second one awarded the points again.
 *
 * Contract: a client that sends `Idempotency-Key: <opaque string>` on a
 * mutating request is guaranteed that request executes at most once. The
 * first call runs and its response is stored; a replay of the same key,
 * method and path replays that stored response with its original status.
 * A request with no key behaves exactly as it did before — nothing in the
 * existing API breaks, and callers opt in per endpoint.
 *
 * Applied globally rather than endpoint by endpoint: "all mutating
 * endpoints" is the requirement, and an allowlist is a list someone forgets
 * to add the next endpoint to.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly supabaseService: SupabaseService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<TenantRequest>();
    const key = (req.headers['idempotency-key'] ||
      req.headers['x-idempotency-key']) as string | undefined;

    if (!key?.trim() || !MUTATING.has((req.method || '').toUpperCase())) {
      return next.handle();
    }

    const db = this.supabaseService.client;
    const method = req.method.toUpperCase();
    // The route path, not the full URL: a query string is part of the
    // request, and it is already covered by the body hash below for the
    // endpoints that use one.
    const path = (req.path || req.url || '').split('?')[0];
    const bodyHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(req.body ?? null) + '|' + (req.url || ''))
      .digest('hex');

    const { data: existing } = await db
      .from('IdempotencyRecord')
      .select('*')
      .eq('key', key.trim())
      .eq('method', method)
      .eq('path', path)
      .maybeSingle();

    if (existing) {
      if (existing.bodyHash !== bodyHash) {
        throw new HttpException(
          {
            success: false,
            code: 'IDEMPOTENCY_KEY_REUSED',
            error:
              'This Idempotency-Key was already used with a different request body.',
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (!existing.completedAt) {
        // The first request is still in flight. Telling the caller to retry
        // is the only honest answer — returning success would claim a result
        // that does not exist yet.
        throw new HttpException(
          {
            success: false,
            code: 'IDEMPOTENCY_IN_PROGRESS',
            error: 'A request with this Idempotency-Key is still in progress.',
          },
          HttpStatus.CONFLICT,
        );
      }
      const res = context.switchToHttp().getResponse();
      res.status?.(existing.status || 200);
      res.setHeader?.('Idempotent-Replay', 'true');
      return of(existing.response);
    }

    // Insert-then-work. The unique index makes this the claim: if a
    // concurrent duplicate beat us to it, the insert fails and we treat it
    // as an in-flight replay rather than running the handler twice.
    const { data: claimed, error: claimError } = await db
      .from('IdempotencyRecord')
      .insert({
        tenantId: req.tenantId || null,
        key: key.trim(),
        method,
        path,
        bodyHash,
      })
      .select('id')
      .single();

    if (claimError || !claimed) {
      throw new HttpException(
        {
          success: false,
          code: 'IDEMPOTENCY_IN_PROGRESS',
          error: 'A request with this Idempotency-Key is already in progress.',
        },
        HttpStatus.CONFLICT,
      );
    }

    return next.handle().pipe(
      tap((body) => {
        const status =
          context.switchToHttp().getResponse()?.statusCode ?? HttpStatus.OK;
        void db
          .from('IdempotencyRecord')
          .update({
            status,
            response: body ?? null,
            completedAt: new Date().toISOString(),
          })
          .eq('id', claimed.id);
      }),
      catchError((err) => {
        // A failed request is not a completed one: release the key so the
        // caller can legitimately retry it. Leaving the claim behind would
        // wedge that key forever on a transient Google Wallet 503.
        return from(
          db.from('IdempotencyRecord').delete().eq('id', claimed.id),
        ).pipe(switchMap(() => throwError(() => err)));
      }),
    );
  }
}
