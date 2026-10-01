import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { NotifyService } from '../notification/notify.service';
import { WhatsappService } from '../notification/whatsapp.service';
import { WalletService } from '../wallet/wallet.service';
import { walletTypeForProgram } from '../wallet/wallet-type.util';
import type { AudienceFilter, WalletType } from '../types';
import { describeError } from '../errors';

export interface AudienceMember {
  id: string;
  name?: string;
  phone: string;
  isTestAccount?: boolean;
  passes: Array<{
    id: string;
    fullPassId: string;
    tier?: string;
    balance?: any;
    programId?: string | null;
  }>;
}

export interface ResolvedAudience {
  members: AudienceMember[];
  /** Excluded purely by marketing opt-out — reported so the number is visible. */
  optedOutCount: number;
}

/** How many recipients are dispatched per batch (2.5). */
export const SEND_CHUNK_SIZE = 25;

@Injectable()
export class CampaignsService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly notifyService: NotifyService,
    private readonly whatsappService: WhatsappService,
    private readonly walletService: WalletService,
  ) {}

  /**
   * The body of a send. Phase 7.4 ran this on a job queue; that queue was
   * removed, so it now runs synchronously inside the HTTP request that
   * created the campaign.
   *
   * Consequence to know about: a send that outlives the request does not
   * resume. A large audience holds the connection open, and a deploy
   * mid-send loses every unreached recipient. The chunking in `dispatch`
   * keeps a normal-sized send inside the timeout, which is what makes this
   * tolerable for now.
   *
   * The audience is still resolved *here* rather than by the caller, so the
   * send goes to the audience as it stands at send time.
   *
   * ponytail: synchronous send, rebuild the queue when a campaign outgrows
   * the request timeout or when D10 scheduling comes back.
   */
  async runCampaign(tenantId: string, campaignId: string) {
    if (!campaignId) throw new Error('campaignId missing');

    const { data: campaign } = await this.supabaseService.client
      .from('Campaign')
      .select('*')
      .eq('id', campaignId)
      .eq('tenantId', tenantId)
      .maybeSingle();

    if (!campaign) throw new Error(`Campaign ${campaignId} not found`);
    // A retry of a send that already finished must not send it again.
    if (campaign.status === 'sent' || campaign.status === 'failed') {
      return { skipped: true, status: campaign.status };
    }

    const audience = await this.resolveAudience(
      tenantId,
      campaign.audienceFilter || {},
    );

    const record = {
      id: campaign.id,
      tenantId,
      channel: campaign.channel,
      header: campaign.header,
      body: campaign.body,
    };

    let sent = 0;
    let failed = 0;
    let status: 'sent' | 'failed' = 'sent';

    try {
      const broadcast =
        campaign.channel === 'wallet_push' &&
        (await this.tryClassBroadcast(
          record,
          audience,
          campaign.audienceFilter || {},
        ));

      if (broadcast) {
        sent = audience.members.length;
      } else {
        ({ sent, failed } = await this.dispatch(record, audience.members));
      }
      if (failed > 0 && sent === 0) status = 'failed';
    } catch (err: any) {
      // A whole-send collapse. Recorded on the campaign and rethrown so the
      // job itself is marked failed and retried.
      await this.supabaseService.client
        .from('Campaign')
        .update({
          status: 'failed',
          sentCount: sent,
          failedCount: audience.members.length - sent,
          sentAt: new Date().toISOString(),
        })
        .eq('id', campaign.id);
      throw err;
    }

    await this.supabaseService.client
      .from('Campaign')
      .update({
        status,
        sentAt: new Date().toISOString(),
        sentCount: sent,
        failedCount: failed,
      })
      .eq('id', campaign.id);

    return { sent, failed, status };
  }

  /**
   * Phase 2.2 — turns an AudienceFilter into the actual member list.
   *
   * Opt-out (2.4) is applied unconditionally and is not part of the filter:
   * a member who replied STOP is never a recipient, whatever the admin picked.
   */
  async resolveAudience(
    tenantId: string,
    filter: AudienceFilter = {},
  ): Promise<ResolvedAudience> {
    let query = this.supabaseService.client
      .from('Member')
      .select(
        'id, name, phone, isTestAccount, marketingOptOutAt, passes:Pass(id, fullPassId, tier, balance, programId, deletedAt)',
      )
      .eq('tenantId', tenantId)
      .order('createdAt', { ascending: false });

    if (filter.testAccountsOnly) {
      query = query.eq('isTestAccount', true);
    }

    const { data, error } = await query;
    if (error) throw error;

    const rows: any[] = data || [];

    // Opt-outs are counted before any other narrowing so the number shown to
    // the admin means "people who told us to stop", not an artefact of the
    // current filter.
    const optedOut = rows.filter((m) => m.marketingOptOutAt);
    let members = rows.filter((m) => !m.marketingOptOutAt);

    if (filter.inactiveForDays && filter.inactiveForDays > 0) {
      const activeIds = await this.recentlyActiveMemberIds(
        tenantId,
        filter.inactiveForDays,
      );
      members = members.filter((m) => !activeIds.has(m.id));
    }

    members = members
      .map((m) => ({
        ...m,
        // A soft-deleted pass is not a pass. Program scoping (D8) reads
        // Pass.programId, which Phase 3.1 populates; until then no caller
        // sets programId and the clause never narrows anything.
        passes: (m.passes || []).filter(
          (p: any) =>
            !p.deletedAt &&
            (!filter.programId || p.programId === filter.programId),
        ),
      }))
      .filter((m) => {
        if (filter.programId && !m.passes.length) return false;
        if (filter.tiers?.length) {
          if (!m.passes.some((p: any) => filter.tiers!.includes(p.tier)))
            return false;
        }
        if (
          filter.balanceMin !== undefined ||
          filter.balanceMax !== undefined
        ) {
          const best = Math.max(
            0,
            ...m.passes.map((p: any) => Number(p.balance) || 0),
          );
          if (filter.balanceMin !== undefined && best < filter.balanceMin)
            return false;
          if (filter.balanceMax !== undefined && best > filter.balanceMax)
            return false;
        }
        return true;
      });

    return {
      members: members as AudienceMember[],
      optedOutCount: optedOut.length,
    };
  }

  /** Member ids with any AuditLog activity inside the window. */
  private async recentlyActiveMemberIds(
    tenantId: string,
    days: number,
  ): Promise<Set<string>> {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const { data, error } = await this.supabaseService.client
      .from('AuditLog')
      .select('memberId')
      .eq('tenantId', tenantId)
      .gte('createdAt', since);
    if (error) throw error;
    return new Set((data || []).map((r: any) => r.memberId).filter(Boolean));
  }

  /**
   * Phase 2.5 — chunked dispatch. A 500-member send neither times out on one
   * request nor fails atomically: each recipient gets its own NotificationLog
   * row tagged with the campaign, and the counts come from those outcomes.
   */
  async dispatch(
    campaign: {
      id: string;
      tenantId: string;
      channel: 'whatsapp' | 'wallet_push';
      header?: string | null;
      body: string;
    },
    members: AudienceMember[],
  ): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;

    for (let i = 0; i < members.length; i += SEND_CHUNK_SIZE) {
      const batch = members.slice(i, i + SEND_CHUNK_SIZE);
      const outcomes = await Promise.all(
        batch.map((member) => this.sendOne(campaign, member)),
      );
      for (const ok of outcomes) {
        if (ok) sent++;
        else failed++;
      }
    }

    return { sent, failed };
  }

  private readonly walletTypeCache = new Map<string, WalletType>();

  private async walletTypeForProgram(
    tenantId: string,
    programId?: string | null,
  ): Promise<WalletType> {
    if (!programId) return 'generic';
    const cached = this.walletTypeCache.get(programId);
    if (cached) return cached;
    const walletType = await walletTypeForProgram(
      this.supabaseService.client,
      tenantId,
      programId,
    );
    this.walletTypeCache.set(programId, walletType);
    return walletType;
  }

  private async sendOne(
    campaign: {
      id: string;
      tenantId: string;
      channel: 'whatsapp' | 'wallet_push';
      header?: string | null;
      body: string;
    },
    member: AudienceMember,
  ): Promise<boolean> {
    const base = {
      tenantId: campaign.tenantId,
      memberId: member.id,
      type: 'campaign',
      campaignId: campaign.id,
      header: campaign.header || undefined,
      body: campaign.body,
    };

    try {
      if (campaign.channel === 'whatsapp') {
        await this.whatsappService.sendText(member.phone, campaign.body);
      } else {
        const passes = member.passes || [];
        if (!passes.length) {
          await this.notifyService.logNotification({
            ...base,
            channel: 'wallet_push',
            status: 'failed',
            errorReason: 'No pass',
          });
          return false;
        }
        // WAL-3: addMessage/TEXT_AND_NOTIFY, never updateGenericObject with a
        // pushNotification — that overwrites the object's `messages` array.
        for (const pass of passes) {
          await this.walletService.sendOfferMessage(
            pass.fullPassId,
            `camp_${campaign.id}_${pass.id}`,
            campaign.header || 'Update',
            campaign.body,
            await this.walletTypeForProgram(campaign.tenantId, pass.programId),
          );
        }
      }

      await this.notifyService.logNotification({
        ...base,
        channel: campaign.channel,
        status: 'sent',
      });
      return true;
    } catch (err: any) {
      await this.notifyService.logNotification({
        ...base,
        channel: campaign.channel,
        status: 'failed',
        errorReason: describeError(err),
      });
      return false;
    }
  }

  /**
   * Phase 2.3 — one `addMessage` on each published class reaches every holder
   * instead of N per-object calls.
   *
   * Only safe when the audience really is everyone: a class message cannot
   * skip an opted-out holder. Returns false when that is not the case, and
   * the caller falls back to the per-pass path.
   */
  async tryClassBroadcast(
    campaign: {
      id: string;
      tenantId: string;
      header?: string | null;
      body: string;
    },
    audience: ResolvedAudience,
    filter: AudienceFilter,
  ): Promise<boolean> {
    const filtered = Object.values(filter).some(
      (v) => v !== undefined && v !== null && v !== false,
    );
    if (filtered || audience.optedOutCount > 0) return false;

    const { data: templates } = await this.supabaseService.client
      .from('PassTemplate')
      .select('classSuffix')
      .eq('tenantId', campaign.tenantId)
      .eq('status', 'published');

    const suffixes = (templates || [])
      .map((t: any) => t.classSuffix)
      .filter(Boolean);
    if (!suffixes.length) return false;

    const scoped = await this.walletService.forTenant(campaign.tenantId);

    for (const suffix of suffixes) {
      await scoped.sendClassMessage(
        scoped.classIdForSuffix(suffix),
        `camp_${campaign.id}_${suffix}`,
        campaign.header || 'Update',
        campaign.body,
      );
    }

    // One roll-up row: a class message has no per-member delivery to record.
    await this.notifyService.logNotification({
      tenantId: campaign.tenantId,
      type: 'campaign',
      channel: 'wallet_push',
      status: 'sent',
      campaignId: campaign.id,
      header: campaign.header || undefined,
      body: campaign.body,
    });

    return true;
  }
}
