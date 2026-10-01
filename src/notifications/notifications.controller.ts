import { Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { SupabaseService } from '../supabase/supabase.service';
import { WhatsappService } from '../notification/whatsapp.service';
import { TenantGuard, TenantRequest } from '../auth/tenant.guard';

/** Replies that revoke or restore marketing consent (2.4). */
const STOP_WORDS = ['STOP', 'UNSUBSCRIBE', 'OPTOUT', 'OPT OUT'];
const START_WORDS = ['START', 'SUBSCRIBE', 'RESUME'];

@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly whatsappService: WhatsappService,
  ) {}

  /**
   * Phase 6.1 (FE-3) — offset-paged with a `total`, so the activity ledger
   * can load more instead of always asking for one fixed slab.
   *
   * The tenant comes from the guard; the `?tenantId=` the dashboard still
   * sends is ignored. Before this the route was unauthenticated and read the
   * tenant straight off the query string, so any caller could read any
   * brand's notification history.
   */
  @Get('log')
  @UseGuards(TenantGuard)
  async getnotificationslog(@Req() req: TenantRequest, @Res() res: Response) {
    try {
      const tenantId = req.tenantId;
      const limit = Math.min(
        parseInt((req.query['limit'] as string) || '50', 10) || 50,
        200,
      );
      const offset = Math.max(
        parseInt((req.query['offset'] as string) || '0', 10) || 0,
        0,
      );
      const programId = req.query['programId'] as string | undefined;

      let query = this.supabaseService.client
        .from('NotificationLog')
        .select(
          programId
            ? '*, member:Member!inner(name, phone, passes:Pass!inner(programId))'
            : '*, member:Member(name, phone)',
          { count: 'exact' },
        )
        .eq('tenantId', tenantId);

      if (programId) {
        query = query.eq('member.passes.programId', programId);
      }

      const {
        data: logs,
        error,
        count,
      } = await query
        .order('sentAt', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        throw error;
      }

      return res.status(200).json({
        success: true,
        logs: logs || [],
        total: count ?? 0,
        limit,
        offset,
      });
    } catch (error: any) {
      console.error('API Error fetching notification logs:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Inbound WhatsApp (2.4 / DB-8). DPDP requires withdrawal to be as easy as
   * granting, and the easiest thing a member can do is reply STOP.
   *
   * Opt-out is set on every Member row carrying that phone number — one
   * person, one decision, regardless of how many brands they're enrolled in.
   * Accepts the WAHA `message` webhook shape and a flat `{from, body}`.
   */
  @Post('webhooks/whatsapp-inbound')
  async whatsappInbound(@Req() req: Request, @Res() res: Response) {
    try {
      const payload = req.body?.payload || req.body || {};
      const rawFrom: string = payload.from || payload.chatId || '';
      const text: string = (payload.body || payload.text || '').trim();

      // WAHA sends `919876543210@c.us`; Member.phone is E.164.
      const digits = rawFrom.split('@')[0].replace(/\D/g, '');
      if (!digits || !text) {
        return res.status(200).json({ success: true, ignored: true });
      }
      const phone = `+${digits}`;

      const word = text.toUpperCase();
      const isStop = STOP_WORDS.includes(word);
      const isStart = START_WORDS.includes(word);
      if (!isStop && !isStart) {
        return res.status(200).json({ success: true, ignored: true });
      }

      const { data: members } = await this.supabaseService.client
        .from('Member')
        .update({ marketingOptOutAt: isStop ? new Date().toISOString() : null })
        .eq('phone', phone)
        .select('id, tenantId');

      if (!members?.length) {
        return res.status(200).json({ success: true, matched: 0 });
      }

      const reply = isStop
        ? "You've been unsubscribed. You won't receive promotional messages from us again. Reply START to resume."
        : "You're subscribed again. Reply STOP at any time to unsubscribe.";

      await this.whatsappService
        .sendTextWithLog(phone, reply, {
          tenantId: members[0].tenantId,
          memberId: members[0].id,
          type: isStop ? 'opt_out_confirmation' : 'opt_in_confirmation',
        })
        .catch(() => {});

      // The withdrawal itself is the record DPDP cares about; ConsentLog only
      // ever held grants, so the revocation is written there too.
      await this.supabaseService.client.from('ConsentLog').insert(
        members.map((m: any) => ({
          memberId: m.id,
          phone,
          legalTextVersion: isStop ? 'DPDP_v1_withdrawal' : 'DPDP_v1',
          consentedAt: isStop ? null : new Date().toISOString(),
        })),
      );

      return res
        .status(200)
        .json({ success: true, optedOut: isStop, matched: members.length });
    } catch (error: any) {
      console.error('API Error handling inbound WhatsApp:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
  }
}
