import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { WalletService } from '../wallet/wallet.service';
import { TenantGuard, TenantRequest } from '../auth/tenant.guard';

@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly walletService: WalletService,
  ) {}

  @Get('stats')
  @UseGuards(TenantGuard)
  async getstats(@Req() req: TenantRequest) {
    try {
      // Every count is scoped to the caller's tenant — these used to
      // aggregate across ALL tenants on an unguarded route.
      const tenantId = req.tenantId;
      const [
        { count: memberCount },
        { count: passCount },
        { data: passTiers },
      ] = await Promise.all([
        this.supabaseService.client
          .from('Member')
          .select('*', { count: 'exact', head: true })
          .eq('tenantId', tenantId),
        this.supabaseService.client
          .from('Pass')
          .select('*', { count: 'exact', head: true })
          .eq('tenantId', tenantId)
          .is('deletedAt', null),
        this.supabaseService.client
          .from('Pass')
          .select('tier')
          .eq('tenantId', tenantId)
          .is('deletedAt', null),
      ]);

      const tierDistribution: Record<string, number> = {};
      (passTiers || []).forEach((p: any) => {
        const t = p.tier || 'Unknown';
        tierDistribution[t] = (tierDistribution[t] || 0) + 1;
      });

      // Resolves this tenant's own Google Wallet credentials, falling back to
      // the shared env ones — forTenant throws when neither is complete.
      let googleConnected = false;
      try {
        await this.walletService.forTenant(tenantId!);
        googleConnected = true;
      } catch {
        googleConnected = false;
      }

      return {
        success: true,
        memberCount: memberCount || 0,
        passCount: passCount || 0,
        tierDistribution,
        walletStatus: {
          google: googleConnected ? 'connected' : 'not_configured',
          apple: 'not_configured',
          samsung: 'pending_approval',
        },
      };
    } catch {
      return { success: false, error: 'Failed to fetch stats' };
    }
  }
}
