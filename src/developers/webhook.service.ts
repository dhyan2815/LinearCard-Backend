import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';

const RETRY_DELAYS_MS = [0, 500, 2000]; // attempt 1 immediate, then backoff
const RESPONSE_BODY_TRUNCATE = 2000;
const DELIVERY_TIMEOUT_MS = 5000;

export function signPayload(secret: string, rawBody: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Rejects http(s) URLs pointing at loopback/private/link-local hosts, so a
 * tenant can't point a webhook at our own metadata service or an internal
 * host (SSRF). String-level hostname check only — a hostname that *resolves*
 * to a private IP still gets through; full DNS-resolution pinning is out of
 * scope here.
 */
export function isPublicWebhookUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '::'
  ) {
    return false;
  }
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10). Only applied to
  // actual IPv6 literals, so a hostname like `fd-api.example.com` is fine.
  if (host.includes(':') && /^(f[cd]|fe[89ab])/.test(host)) {
    return false;
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 127) return false;
    if (a === 10) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
  }
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Dispatches tenant webhooks. Never throws — every failure (network,
 * non-2xx, DB) is caught and logged so a webhook delivery can never roll
 * back or block the business transaction that triggered it. Callers should
 * NOT await this in the request path that must succeed regardless; call it
 * fire-and-forget (`this.webhookService.dispatch(...).catch(() => {})`) the
 * same way NotifyService/WhatsappService calls are already handled here.
 *
 * ponytail: retries are sequential in-process `setTimeout` awaits, not a
 * queue. Fine at current volume — move to a real job queue if webhook
 * fan-out ever needs to survive a process restart mid-retry.
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  async dispatch(
    tenantId: string,
    event: string,
    payload: Record<string, any>,
    /** Phase 8 — when set, program hooks for this program also fire. */
    programId?: string | null,
  ): Promise<void> {
    try {
      const { data: endpoints, error } = await this.supabaseService.client
        .from('WebhookEndpoint')
        .select('id, url, secret, events, active, programId')
        .eq('tenantId', tenantId)
        .eq('active', true);
      if (error || !endpoints?.length) return;

      const targets = endpoints.filter(
        (e: any) =>
          (e.events || []).includes(event) &&
          // NULL means tenant-wide and always fires; a program hook fires only
          // for its own program.
          (!e.programId || e.programId === programId),
      );
      await Promise.all(
        targets.map((endpoint: any) =>
          this.deliverWithRetry(endpoint, event, payload),
        ),
      );
    } catch (err: any) {
      this.logger.warn(`Webhook dispatch failed (non-fatal): ${err.message}`);
    }
  }

  /**
   * Sends a synthetic event straight at one endpoint, bypassing its `events`
   * subscription filter — used by the "send test event" button so it always
   * fires regardless of which events the endpoint is configured for.
   */
  async sendTest(tenantId: string, endpointId: string): Promise<boolean> {
    const { data: endpoint } = await this.supabaseService.client
      .from('WebhookEndpoint')
      .select('id, url, secret')
      .eq('id', endpointId)
      .eq('tenantId', tenantId)
      .single();
    if (!endpoint) return false;
    await this.deliverWithRetry(endpoint, 'test.ping', {
      message: 'This is a test event from LinearCard.',
      sentAt: new Date().toISOString(),
    });
    return true;
  }

  private async deliverWithRetry(
    endpoint: { id: string; url: string; secret: string },
    event: string,
    payload: Record<string, any>,
  ): Promise<void> {
    // One timestamp for both the signed body and the header, so they can
    // never disagree.
    const timestamp = Date.now();
    const body = JSON.stringify({ event, payload, timestamp });
    const signature = signPayload(endpoint.secret, body);

    for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (RETRY_DELAYS_MS[attempt - 1] > 0) {
        await sleep(RETRY_DELAYS_MS[attempt - 1]);
      }
      try {
        const res = await fetch(endpoint.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-LinearCard-Signature': signature,
            'X-LinearCard-Event': event,
            'X-LinearCard-Timestamp': String(timestamp),
          },
          body,
          // Built-in timeout: an unresponsive endpoint must not hang the
          // awaited "send test event" request across all retry attempts.
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        });
        const responseBody = (await res.text().catch(() => '')).slice(
          0,
          RESPONSE_BODY_TRUNCATE,
        );
        await this.logDelivery(
          endpoint.id,
          event,
          payload,
          res.status,
          responseBody,
          attempt,
        );
        if (res.ok) return;
      } catch (err: any) {
        await this.logDelivery(
          endpoint.id,
          event,
          payload,
          null,
          String(err.message || err).slice(0, RESPONSE_BODY_TRUNCATE),
          attempt,
        );
      }
    }
  }

  private async logDelivery(
    endpointId: string,
    event: string,
    payload: Record<string, any>,
    statusCode: number | null,
    responseBody: string,
    attempt: number,
  ): Promise<void> {
    try {
      await this.supabaseService.client.from('WebhookDelivery').insert({
        endpointId,
        event,
        payload,
        statusCode,
        responseBody,
        attempt,
      });
    } catch (err: any) {
      this.logger.warn(`WebhookDelivery log insert failed: ${err.message}`);
    }
  }
}
