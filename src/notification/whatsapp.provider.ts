import { Logger } from '@nestjs/common';
import { ServiceError } from '../errors';

/**
 * The one seam every WhatsApp call goes through (D6 — the provider is fluid:
 * WAHA today, Cloud API later). Swapping provider is a new implementation of
 * this interface and nothing else; no call site knows what WAHA is.
 */
export interface WhatsappProvider {
  /** `phone` is E.164 (`+919876543210`). */
  sendText(phone: string, text: string): Promise<any>;
}

/** WAHA (self-hosted WhatsApp HTTP API). The only implementation today. */
export class WahaProvider implements WhatsappProvider {
  private readonly logger = new Logger(WahaProvider.name);

  /** E.164 (+919876543210) -> WAHA chat id (919876543210@c.us). */
  private toChatId(phone: string): string {
    return `${phone.replace(/^\+/, '')}@c.us`;
  }

  async sendText(phone: string, text: string): Promise<any> {
    return this.post('/api/sendText', { chatId: this.toChatId(phone), text });
  }

  private async post(endpoint: string, body: object) {
    const baseUrl = process.env.WAHA_BASE_URL;
    const apiKey = process.env.WAHA_API_KEY;
    const session = process.env.WAHA_SESSION;

    // Gracefully handle a missing base URL so the app still runs offline.
    if (!baseUrl) {
      this.logger.warn(
        'WAHA_BASE_URL not set in .env. Skipping WhatsApp message.',
      );
      return;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (apiKey) headers['X-Api-Key'] = apiKey;

    const url = `${baseUrl.replace(/\/$/, '')}${endpoint}`;
    const maxRetries = 2;

    for (let attempt = 0; ; attempt++) {
      try {
        const controller = new AbortController();
        // 60-second hard TCP timeout to prevent indefinite hangs
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ session, ...body }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
          const detail = await res.text();
          if (detail.includes('no LID found')) {
            throw new ServiceError(
              'WHATSAPP_NUMBER_INVALID',
              'The phone number is not registered on WhatsApp. Please verify the number and try again.',
            );
          }
          throw new ServiceError(
            'WHATSAPP_SEND_FAILED',
            `WhatsApp provider rejected the send (HTTP ${res.status}): ${detail.slice(0, 300)}`,
          );
        }

        return await res.json();
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        // No HTTP status at all — the WAHA host is down, or (observed in prod) a
        // Cloudflare edge IP for the WAHA hostname is unreachable from this network.
        // A retry re-resolves DNS and usually lands on a working edge IP.
        if (attempt < maxRetries) {
          this.logger.warn(
            `WAHA unreachable (attempt ${attempt + 1}/${maxRetries + 1}), retrying: ${error instanceof Error ? error.message : String(error)}`,
          );
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw new ServiceError(
          'WHATSAPP_SEND_FAILED',
          `Could not reach the WhatsApp provider at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }
    }
  }
}
