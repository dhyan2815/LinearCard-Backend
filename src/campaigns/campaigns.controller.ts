import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard, TenantRequest } from '../auth/tenant.guard';
import { SupabaseService } from '../supabase/supabase.service';
import { CampaignsService } from './campaigns.service';
import type { AudienceFilter } from '../types';

interface CampaignBody {
  name?: string;
  channel?: 'whatsapp' | 'wallet_push';
  header?: string;
  body?: string;
  audienceFilter?: AudienceFilter;
  programId?: string;
}

/**
 * Campaigns are tenant-scoped end to end: every route is behind TenantGuard
 * and reads `req.tenantId`, never a tenantId from the body.
 */
@Controller('campaigns')
@UseGuards(TenantGuard)
export class CampaignsController {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly campaignsService: CampaignsService,
  ) {}

  /** Validates the shared shape of a preview and a send. */
  private validate(body: CampaignBody) {
    const channel = body.channel;
    if (channel !== 'whatsapp' && channel !== 'wallet_push') {
      throw new HttpException(
        { success: false, error: 'channel must be whatsapp or wallet_push' },
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!body.body?.trim()) {
      throw new HttpException(
        { success: false, error: 'body is required' },
        HttpStatus.BAD_REQUEST,
      );
    }
    // FE-2: Google Wallet's addMessage requires a header. The old composer
    // had no header field at all, so every wallet push went out headerless.
    if (channel === 'wallet_push' && !body.header?.trim()) {
      throw new HttpException(
        { success: false, error: 'header is required for wallet_push' },
        HttpStatus.BAD_REQUEST,
      );
    }
    return {
      channel,
      header: body.header?.trim() || null,
      text: body.body.trim(),
    };
  }

  /** 2.5 — dry run. Count, rendered message, first 5 recipients. */
  @Post('preview')
  async preview(@Req() req: TenantRequest, @Body() body: CampaignBody) {
    const { header, text } = this.validate(body);
    const filter = body.audienceFilter || {};
    const { members, optedOutCount } =
      await this.campaignsService.resolveAudience(req.tenantId!, filter);

    const allRecipients = members.map((m) => ({
      id: m.id,
      name: m.name,
      phone: m.phone,
      tier: m.passes[0]?.tier,
      balance: m.passes[0]?.balance,
    }));

    return {
      success: true,
      recipientCount: members.length,
      optedOutCount,
      renderedHeader: header,
      renderedBody: text,
      sample: allRecipients.slice(0, 5),
      recipients: allRecipients,
    };
  }

  /**
   * Create and send immediately (D10 — send-now only, no scheduling).
   *
   * The send runs synchronously inside this request — Phase 7.4's job queue
   * was removed. A large audience therefore holds the connection open, and a
   * deploy mid-send loses the unreached recipients. Delivery is read back
   * from `GET /campaigns/:id`.
   */
  @Post()
  async send(@Req() req: TenantRequest, @Body() body: CampaignBody) {
    const tenantId = req.tenantId!;
    const { channel, header, text } = this.validate(body);
    const filter = body.audienceFilter || {};

    // Resolved once up front purely to report the recipient count back to
    // the admin who pressed Send. `runCampaign` re-resolves at send time.
    const audience = await this.campaignsService.resolveAudience(
      tenantId,
      filter,
    );

    const { data: campaign, error } = await this.supabaseService.client
      .from('Campaign')
      .insert({
        tenantId,
        programId: body.programId || filter.programId || null,
        name: body.name?.trim() || `${channel} broadcast`,
        channel,
        header,
        body: text,
        audienceFilter: filter,
        status: 'sending',
        recipientCount: audience.members.length,
      })
      .select()
      .single();

    if (error || !campaign) {
      throw new HttpException(
        {
          success: false,
          error: error?.message || 'Failed to create campaign',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const { sent, failed } = await this.campaignsService.runCampaign(
      tenantId,
      campaign.id,
    );

    return {
      success: true,
      campaign,
      queued: false,
      recipientCount: audience.members.length,
      sent: sent || 0,
      failed: failed || 0,
    };
  }

  @Get()
  async list(@Req() req: TenantRequest, @Query('limit') limitQuery?: string) {
    const limit = Number(limitQuery) > 0 ? Number(limitQuery) : 25;
    const { data, error } = await this.supabaseService.client
      .from('Campaign')
      .select('*')
      .eq('tenantId', req.tenantId!)
      .order('createdAt', { ascending: false })
      .limit(limit);

    if (error) {
      throw new HttpException(
        { success: false, error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return { success: true, campaigns: data || [] };
  }

  /** Detail: per-recipient outcomes, with failures grouped by cause (2.5). */
  @Get(':id')
  async detail(@Req() req: TenantRequest, @Param('id') id: string) {
    const { data: campaign } = await this.supabaseService.client
      .from('Campaign')
      .select('*')
      .eq('id', id)
      .eq('tenantId', req.tenantId!)
      .single();

    if (!campaign) {
      throw new HttpException(
        { success: false, error: 'Campaign not found' },
        HttpStatus.NOT_FOUND,
      );
    }

    const { data: logs } = await this.supabaseService.client
      .from('NotificationLog')
      .select('*, member:Member(name, phone)')
      .eq('campaignId', id)
      .order('sentAt', { ascending: false });

    const failures: Record<string, number> = {};
    for (const log of logs || []) {
      if (log.status === 'failed') {
        const cause = log.error || 'Unknown error';
        failures[cause] = (failures[cause] || 0) + 1;
      }
    }

    return { success: true, campaign, logs: logs || [], failures };
  }
}
