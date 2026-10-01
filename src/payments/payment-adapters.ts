import { HttpException, HttpStatus } from '@nestjs/common';
import type { NormalizedPayment } from '../types';

/**
 * Phase 5 — one adapter per PSP.
 *
 * Every provider posts a different payload shape; the rest of the system
 * only ever sees `NormalizedPayment`. Adding Razorpay or Cashfree is a new
 * class plus a registry entry, not a rewrite of `payments.service.ts`.
 *
 * The normalized shape is deliberately narrow: phone, amount, merchant
 * reference, time. **No PAN, no VPA, no card token ever enters this system**
 * — anything else on the payload is dropped here and never stored.
 */
export interface PaymentAdapter {
  /** Matches the `provider` on the webhook route. */
  readonly provider: string;
  normalize(body: any): NormalizedPayment;
}

/**
 * Field extraction shared by every adapter whose payload already uses our
 * own names. A PSP with different field names maps them first, then calls
 * this — it is not a base class to inherit.
 */
export function normalizeCommonFields(body: any): NormalizedPayment {
  const phone = String(body?.phone ?? '').replace(/[^\d+]/g, '');
  // Amount is in the currency's minor unit (paise) so no float ever touches
  // money on the wire.
  const amountMinor = Math.round(Number(body?.amountMinor ?? NaN));

  if (!phone || phone.replace(/\D/g, '').length < 8) {
    throw new HttpException(
      'A valid customer phone is required.',
      HttpStatus.BAD_REQUEST,
    );
  }
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
    throw new HttpException(
      'amountMinor must be a positive integer in the minor unit (paise).',
      HttpStatus.BAD_REQUEST,
    );
  }

  return {
    phone,
    amountMinor,
    currency: String(body?.currency || 'INR').toUpperCase(),
    merchantRef: body?.merchantRef ? String(body.merchantRef) : null,
    occurredAt: body?.occurredAt
      ? new Date(body.occurredAt).toISOString()
      : new Date().toISOString(),
    nonce: String(body?.nonce ?? ''),
    timestamp: Number(body?.timestamp ?? NaN),
  };
}

/** The demo simulator, and the shape the docs describe. */
export class MockAdapter implements PaymentAdapter {
  readonly provider = 'mock';

  normalize(body: any): NormalizedPayment {
    return normalizeCommonFields(body);
  }
}

// Razorpay/Cashfree adapters land here once live credentials are available.
// Each one maps its own payload onto `normalizeCommonFields` and registers
// below. Per-provider signature verification belongs on the adapter too —
// today every provider shares the tenant HMAC in `payments.service.ts`.

export const PAYMENT_ADAPTERS: PaymentAdapter[] = [new MockAdapter()];

const REGISTRY = new Map<string, PaymentAdapter>(
  PAYMENT_ADAPTERS.map((adapter) => [adapter.provider, adapter]),
);

export function adapterFor(provider?: string): PaymentAdapter {
  const key = (provider || 'mock').toLowerCase();
  const adapter = REGISTRY.get(key);
  if (!adapter) {
    throw new HttpException(
      `Unsupported payment provider '${key}'. Supported: ${[...REGISTRY.keys()].join(', ')}.`,
      HttpStatus.BAD_REQUEST,
    );
  }
  return adapter;
}
