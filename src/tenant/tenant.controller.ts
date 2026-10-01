import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Req,
  UseGuards,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { TenantGuard, TenantRequest } from '../auth/tenant.guard';

@Controller('tenant')
export class TenantController {
  constructor(private readonly supabaseService: SupabaseService) {}

  /**
   * Merchant submits business/tax details for the production-approval
   * review. Tenant-guarded so a caller can only edit their own tenant.
   */
  @Post('tenants/:id/business-details')
  @UseGuards(TenantGuard)
  async submitBusinessDetails(
    @Param('id') id: string,
    @Body() body: any,
    @Req() req: TenantRequest,
  ) {
    if (req.tenantId !== id && req.authRole !== 'admin') {
      throw new HttpException(
        { success: false, error: 'Unauthorized for this tenant' },
        HttpStatus.FORBIDDEN,
      );
    }

    const { businessDetails } = body || {};
    if (!businessDetails || typeof businessDetails !== 'object') {
      throw new HttpException(
        { success: false, error: 'businessDetails object is required' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const { error } = await this.supabaseService.client
      .from('Tenant')
      .update({ businessDetails, publishStatus: 'pending' })
      .eq('id', id);
    if (error)
      throw new HttpException(
        { success: false, error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );

    return { success: true };
  }

  /**
   * LinearCard-admin-only: verifies a tenant's submitted business details
   * and promotes it out of demo mode. Reuses the same
   * `authRole === 'admin'` gate already used by other admin-only actions
   * (e.g. PassesController.postsendpromomessage's cross-tenant override).
   */
  @Post('admin/tenants/:id/approve-for-production')
  @UseGuards(TenantGuard)
  async approveForProduction(
    @Param('id') id: string,
    @Req() req: TenantRequest,
  ) {
    if (req.authRole !== 'admin') {
      throw new HttpException(
        { success: false, error: 'Admin authorization required' },
        HttpStatus.FORBIDDEN,
      );
    }

    const { error } = await this.supabaseService.client
      .from('Tenant')
      .update({ publishStatus: 'production' })
      .eq('id', id);
    if (error)
      throw new HttpException(
        { success: false, error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );

    return { success: true, publishStatus: 'production' };
  }

  /**
   * Tenant-switcher list for the (authenticated) admin dashboard. Guarded,
   * and column-whitelisted to the same non-sensitive shape getTenantBySlug
   * returns — `select('*')` here used to leak every tenant's issuerId,
   * googleClientEmail, googlePrivateKeyEncrypted, businessDetails (tax/GST/
   * legal name) and the legacy plaintext `apiKey` column that TenantGuard
   * still accepts as a credential.
   */
  @Get('tenants')
  @UseGuards(TenantGuard)
  async getTenants(@Req() req: TenantRequest) {
    try {
      const { data: tenants, error } = await this.supabaseService.client
        .from('Tenant')
        .select(
          'id, name, brandHexColor, logoUrl, heroUrl, classSuffix, publishStatus, businessCategory',
        )
        .eq('id', req.tenantId)
        .order('name', { ascending: true });

      if (error) {
        throw new Error(`DB Error: ${error.message}`);
      }
      return { success: true, tenants };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new HttpException(
        { success: false, error: 'Failed to fetch tenants', details: errMsg },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get(':slug')
  async getTenantBySlug(@Param('slug') slug: string) {
    try {
      if (slug === 'default' || slug === 'linearcard_demo') {
        const { data: demoTenant } = await this.supabaseService.client
          .from('Tenant')
          .select('*')
          .eq('classSuffix', 'linearcard_demo')
          .single();

        if (demoTenant) {
          return {
            tenantId: demoTenant.id,
            name: demoTenant.name,
            brandHexColor: demoTenant.brandHexColor,
            logoUrl: demoTenant.logoUrl,
            heroUrl: demoTenant.heroUrl,
            classSuffix: demoTenant.classSuffix,
          };
        }

        return {
          tenantId: 'demo-tenant-123',
          name: 'LinearCard Demo Pass',
          brandHexColor: '#F97316',
          logoUrl: '/logo-linearcard.png',
          heroUrl: '/hero-linearcard.png',
          classSuffix: 'linearcard_demo',
        };
      }

      const { data: tenant, error } = await this.supabaseService.client
        .from('Tenant')
        .select('*')
        .eq('classSuffix', slug)
        .single();

      if (error || !tenant) {
        throw new HttpException(
          { error: 'Tenant not found' },
          HttpStatus.NOT_FOUND,
        );
      }

      // Phase 3.6 — the enrollment page needs the tenant's programs so it can
      // resolve /enroll/:tenantSlug/:programSlug, and fall back to the
      // default (oldest) program on the bare /enroll/:tenantSlug URL.
      const { data: programs } = await this.supabaseService.client
        .from('Program')
        .select('id, name, kind, enrollmentSlug, status, enrollmentFields')
        .eq('tenantId', tenant.id)
        .order('createdAt', { ascending: true });

      return {
        tenantId: tenant.id,
        name: tenant.name,
        brandHexColor: tenant.brandHexColor,
        logoUrl: tenant.logoUrl,
        heroUrl: tenant.heroUrl,
        classSuffix: tenant.classSuffix,
        programs: programs || [],
        defaultProgramId: (programs || [])[0]?.id ?? null,
      };
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { error: 'Failed to fetch tenant' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
