import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { TenantGuard, TenantRequest } from '../auth/tenant.guard';

const DEFAULT_WINDOW_DAYS = 30;

/**
 * Phase 8 — the program Overview tab.
 *
 * Current state comes from Pass columns, history from AuditLog rows. Install
 * history starts the day event recording shipped: the wallet 'save' callback
 * previously persisted nothing, so `historyStartsAt` is reported rather than
 * implying zero activity before it.
 *
 * ponytail: buckets are computed in JS over the window's rows, not in SQL.
 * Fine at current volume — push to a SQL date_trunc aggregate if a program
 * ever has enough events that pulling the window hurts.
 */
@Controller('programs')
@UseGuards(TenantGuard)
export class ProgramAnalyticsController {
  constructor(private readonly supabaseService: SupabaseService) {}

  private bucketKey(iso: string, groupBy: string): string {
    return groupBy === 'month' ? iso.slice(0, 7) : iso.slice(0, 10);
  }

  @Get(':id/overview')
  async overview(
    @Param('id') id: string,
    @Req() req: TenantRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('groupBy') groupBy: string = 'day',
  ) {
    const { data: program } = await this.supabaseService.client
      .from('Program')
      .select('id')
      .eq('id', id)
      .eq('tenantId', req.tenantId)
      .maybeSingle();
    if (!program)
      throw new HttpException(
        { success: false, error: 'Program not found' },
        HttpStatus.NOT_FOUND,
      );

    const toDate = to ? new Date(to) : new Date();
    const fromDate = from
      ? new Date(from)
      : new Date(toDate.getTime() - DEFAULT_WINDOW_DAYS * 86400_000);

    const [{ data: passes }, { data: allEvents }] = await Promise.all([
      this.supabaseService.client
        .from('Pass')
        .select('id, memberId')
        .eq('tenantId', req.tenantId)
        .eq('programId', id),
      this.supabaseService.client
        .from('AuditLog')
        .select('action, createdAt, details, programId, memberId')
        .eq('tenantId', req.tenantId)
        .gte('createdAt', fromDate.toISOString())
        .lte('createdAt', toDate.toISOString()),
    ]);

    const passIds = new Set((passes || []).map((p: any) => p.id));
    const memberIds = new Set((passes || []).map((p: any) => p.memberId));

    const events = (allEvents || []).filter((e: any) => {
      if (e.programId === id) return true;
      if (e.programId) return false; // Belongs to another program explicitly
      // Legacy fallback for Phase 5 events where programId was not logged
      if (e.details?.passId && passIds.has(e.details.passId)) return true;
      if (e.memberId && memberIds.has(e.memberId)) return true;
      return false;
    });

    const buckets = new Map<
      string,
      {
        bucket: string;
        revenue: number;
        orders: number;
        pointsAwarded: number;
        pointsRedeemed: number;
      }
    >();
    const totals = {
      revenue: 0,
      orders: 0,
      pointsAwarded: 0,
      pointsRedeemed: 0,
    };

    for (const e of events || []) {
      const key = this.bucketKey(e.createdAt, groupBy);
      const bucket = buckets.get(key) || {
        bucket: key,
        revenue: 0,
        orders: 0,
        pointsAwarded: 0,
        pointsRedeemed: 0,
      };

      const details = e.details || {};

      if (e.action === 'order_transaction') {
        const amount = Number(details.orderAmount || 0);
        bucket.revenue += amount;
        totals.revenue += amount;

        bucket.orders++;
        totals.orders++;

        const pointsChanged = Math.abs(Number(details.pointsChanged || 0));
        if (
          details.transactionType === 'award' ||
          details.transactionType === 'earn'
        ) {
          bucket.pointsAwarded += pointsChanged;
          totals.pointsAwarded += pointsChanged;
        } else if (details.transactionType === 'redeem') {
          bucket.pointsRedeemed += pointsChanged;
          totals.pointsRedeemed += pointsChanged;
        } else {
          // Fallback if transactionType is missing
          const rawPoints = Number(details.pointsChanged || 0);
          if (rawPoints > 0) {
            bucket.pointsAwarded += rawPoints;
            totals.pointsAwarded += rawPoints;
          } else if (rawPoints < 0) {
            bucket.pointsRedeemed += Math.abs(rawPoints);
            totals.pointsRedeemed += Math.abs(rawPoints);
          }
        }
      } else if (
        e.action === 'manual_balance_adjustment' ||
        e.action === 'balance_adjusted'
      ) {
        // Fallback for manual adjustments
        const pointsChanged = Number(
          details.pointsChanged || details.adjustment || 0,
        );
        if (pointsChanged > 0) {
          bucket.pointsAwarded += pointsChanged;
          totals.pointsAwarded += pointsChanged;
        } else if (pointsChanged < 0) {
          bucket.pointsRedeemed += Math.abs(pointsChanged);
          totals.pointsRedeemed += Math.abs(pointsChanged);
        }
      }

      buckets.set(key, bucket);
    }

    const { data: firstEvent } = await this.supabaseService.client
      .from('AuditLog')
      .select('createdAt')
      .eq('tenantId', req.tenantId)
      .eq('programId', id)
      .order('createdAt', { ascending: true })
      .limit(1)
      .maybeSingle();

    return {
      success: true,
      overview: {
        totalRevenue: totals.revenue,
        totalOrders: totals.orders,
        pointsAwarded: totals.pointsAwarded,
        pointsRedeemed: totals.pointsRedeemed,
        series: [...buckets.values()].sort((a, b) =>
          a.bucket.localeCompare(b.bucket),
        ),
        historyStartsAt: firstEvent?.createdAt ?? null,
      },
    };
  }
}
