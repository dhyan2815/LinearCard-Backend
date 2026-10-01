import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Req,
  UseGuards,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { TenantGuard, TenantRequest } from '../auth/tenant.guard';
import { SupabaseService } from '../supabase/supabase.service';
import { ApiKeyService } from './api-key.service';
import { WebhookService, isPublicWebhookUrl } from './webhook.service';

export const WEBHOOK_EVENTS = [
  'pass.installed',
  'pass.deleted',
  'points.awarded',
  'points.redeemed',
  'tier.changed',
  'member.enrolled',
  // GAP-13 — fires once when a visit/stamp program crosses its reward threshold.
  'reward.unlocked',
];

@Controller('developers')
@UseGuards(TenantGuard)
export class DevelopersController {
  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly webhookService: WebhookService,
    private readonly supabaseService: SupabaseService,
  ) {}

  // ---- API keys ----

  @Get('api-keys')
  async listKeys(@Req() req: TenantRequest) {
    return {
      success: true,
      keys: await this.apiKeyService.list(req.tenantId!),
    };
  }

  @Post('api-keys')
  async issueKey(@Req() req: TenantRequest, @Body() body: { name?: string }) {
    const tenantId = req.tenantId!;
    const result = await this.apiKeyService.issue(tenantId, body?.name);
    return { success: true, ...result };
  }

  @Delete('api-keys/:id')
  async revokeKey(@Req() req: TenantRequest, @Param('id') id: string) {
    await this.apiKeyService.revoke(req.tenantId!, id);
    return { success: true };
  }

  // ---- Webhook endpoints ----

  @Get('webhooks')
  async listWebhooks(@Req() req: TenantRequest) {
    const { data, error } = await this.supabaseService.client
      .from('WebhookEndpoint')
      .select('id, url, events, active, createdAt')
      .eq('tenantId', req.tenantId)
      .order('createdAt', { ascending: false });
    if (error)
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    return { success: true, webhooks: data || [] };
  }

  @Post('webhooks')
  async createWebhook(
    @Req() req: TenantRequest,
    @Body() body: { url: string; events: string[] },
  ) {
    const tenantId = req.tenantId!;
    const { url, events } = body || ({} as any);
    if (!url || !isPublicWebhookUrl(url)) {
      throw new HttpException(
        'url must be a valid http/https URL with a public (non-loopback, non-private) host',
        HttpStatus.BAD_REQUEST,
      );
    }
    const validEvents = (events || []).filter((e: string) =>
      WEBHOOK_EVENTS.includes(e),
    );
    if (!validEvents.length) {
      throw new HttpException(
        `events must include at least one of: ${WEBHOOK_EVENTS.join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const secret = crypto.randomBytes(24).toString('hex');
    const { data, error } = await this.supabaseService.client
      .from('WebhookEndpoint')
      .insert({ tenantId, url, events: validEvents, secret, active: true })
      .select('id, url, events, active, createdAt, secret')
      .single();
    if (error)
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);

    // Secret is only ever returned in full on creation, like the API key.
    return { success: true, webhook: data };
  }

  @Patch('webhooks/:id')
  async updateWebhook(
    @Req() req: TenantRequest,
    @Param('id') id: string,
    @Body() body: { url?: string; events?: string[]; active?: boolean },
  ) {
    const tenantId = req.tenantId!;
    const patch: Record<string, any> = {};
    if (body?.url !== undefined) {
      if (!isPublicWebhookUrl(body.url)) {
        throw new HttpException(
          'url must be a valid http/https URL with a public (non-loopback, non-private) host',
          HttpStatus.BAD_REQUEST,
        );
      }
      patch.url = body.url;
    }
    if (body?.events !== undefined) {
      const validEvents = body.events.filter((e) => WEBHOOK_EVENTS.includes(e));
      patch.events = validEvents;
    }
    if (body?.active !== undefined) patch.active = body.active;
    if (!Object.keys(patch).length) {
      throw new HttpException(
        'No updateable fields provided',
        HttpStatus.BAD_REQUEST,
      );
    }
    const { error } = await this.supabaseService.client
      .from('WebhookEndpoint')
      .update(patch)
      .eq('id', id)
      .eq('tenantId', tenantId);
    if (error)
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    return { success: true };
  }

  @Delete('webhooks/:id')
  async deleteWebhook(@Req() req: TenantRequest, @Param('id') id: string) {
    const { error } = await this.supabaseService.client
      .from('WebhookEndpoint')
      .delete()
      .eq('id', id)
      .eq('tenantId', req.tenantId);
    if (error)
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    return { success: true };
  }

  @Post('webhooks/:id/test')
  async testWebhook(@Req() req: TenantRequest, @Param('id') id: string) {
    const tenantId = req.tenantId!;
    // Fire-and-forget through the same signing/retry/logging path real
    // events use, so the frontend "send test event" button exercises real code.
    const found = await this.webhookService.sendTest(tenantId, id);
    if (!found)
      throw new HttpException('Webhook not found', HttpStatus.NOT_FOUND);
    return { success: true, message: 'Test event dispatched' };
  }
}
