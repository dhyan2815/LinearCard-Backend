import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import * as crypto from 'crypto';
import { TenantGuard } from '../auth/tenant.guard';
import { PaymentsService, signPaymentPayload } from './payments.service';

@Controller()
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  /**
   * Phase 5.1 — the PSP-facing endpoint. Unauthenticated by design and
   * gated entirely on the HMAC signature of the raw body, because a PSP
   * cannot hold a session.
   */
  @Post('webhooks/payment/:tenantId')
  async paymentWebhook(
    @Param('tenantId') tenantId: string,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    const rawBody = req.rawBody?.toString('utf8');
    if (!rawBody) {
      throw new HttpException('Empty request body.', HttpStatus.BAD_REQUEST);
    }
    const signature =
      (req.headers['x-linearcard-signature'] as string) || undefined;
    const provider =
      (req.headers['x-payment-provider'] as string)?.toLowerCase() || 'mock';

    return this.paymentsService.handleWebhook(
      tenantId,
      rawBody,
      signature,
      provider,
    );
  }

  /** The simulator panel needs the endpoint URL and the signing secret. */
  @UseGuards(TenantGuard)
  @Get('payments/webhook-config')
  async webhookConfig(@Req() req: Request & { tenantId: string }) {
    const secret = await this.paymentsService.getOrCreateSecret(req.tenantId);
    return {
      success: true,
      tenantId: req.tenantId,
      path: `/webhooks/payment/${req.tenantId}`,
      secret,
    };
  }

  /**
   * Phase 5.3 — demo simulator. Signs the payload server-side (the browser
   * never needs the secret) and pushes it through the *same* verification
   * path as a real PSP call, so the demo proves the real endpoint works.
   */
  @UseGuards(TenantGuard)
  @Post('payments/simulate')
  async simulate(
    @Req() req: Request & { tenantId: string },
    @Body() body: { phone?: string; amount?: number; programId?: string },
  ) {
    const phone = String(body?.phone ?? '').replace(/[^\d+]/g, '');
    const amount = Number(body?.amount);
    if (!phone) {
      throw new HttpException('phone is required', HttpStatus.BAD_REQUEST);
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new HttpException(
        'Amount must be greater than ₹0.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const secret = await this.paymentsService.getOrCreateSecret(req.tenantId);
    const payload = JSON.stringify({
      phone,
      amountMinor: Math.round(amount * 100),
      currency: 'INR',
      merchantRef: `sim_${crypto.randomBytes(6).toString('hex')}`,
      occurredAt: new Date().toISOString(),
      nonce: crypto.randomUUID(),
      timestamp: Date.now(),
      programId: body?.programId,
    });

    return this.paymentsService.handleWebhook(
      req.tenantId,
      payload,
      signPaymentPayload(secret, payload),
      'mock',
    );
  }
}
