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
import { SupabaseService } from '../supabase/supabase.service';
import { WalletService, resolveCardTitle } from '../wallet/wallet.service';
import { walletTypeForProgram } from '../wallet/wallet-type.util';
import { TenantGuard, TenantRequest } from '../auth/tenant.guard';
import { TemplatesService } from './templates.service';

@Controller('templates')
export class TemplatesController {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly walletService: WalletService,
    private readonly templatesService: TemplatesService,
  ) {}

  // Tenant comes from the guard, never from `?tenantId=` — the query param
  // is accepted (the dashboard still sends it) but ignored.
  @Get()
  @UseGuards(TenantGuard)
  async getTemplates(@Req() req: TenantRequest) {
    try {
      const { data: templates, error } = await this.supabaseService.client
        .from('PassTemplate')
        .select('*')
        .eq('tenantId', req.tenantId)
        .order('createdAt', { ascending: false });

      if (error) throw error;
      return {
        success: true,
        templates: (templates || []).map((t: any) => ({ ...t, name: t.title })),
      };
    } catch {
      throw new HttpException(
        { success: false, error: 'Failed to fetch templates' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Validates and normalises a hexBackgroundColor value, throwing an
   * HttpException with the same shape/message used across the controller.
   * Returns the uppercased hex string.
   */
  private validateHexColor(value: any): string {
    if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
      throw new HttpException(
        {
          success: false,
          error: 'hexBackgroundColor must be a 6-digit hex code, e.g. #1A365D',
          message:
            'hexBackgroundColor must be a 6-digit hex code, e.g. #1A365D',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    return value.toUpperCase();
  }

  /**
   * Validates one loyalty-economics field (Phase 1.3, WAL-4) against the
   * same bounds as the DB CHECK constraint, so a bad value is a 400 here
   * rather than a 500 from Postgres.
   */
  private validateLoyaltyRule(
    field: 'earnRate' | 'redeemRate' | 'redeemCapPercent',
    value: any,
  ): number {
    const bounds = {
      earnRate: { min: 0, max: 10 },
      redeemRate: { min: 0.0001, max: 1000 },
      redeemCapPercent: { min: 0, max: 100 },
    }[field];
    const num = Number(value);
    if (
      value === null ||
      value === '' ||
      isNaN(num) ||
      num < bounds.min ||
      num > bounds.max
    ) {
      const message = `${field} must be a number between ${bounds.min} and ${bounds.max}`;
      throw new HttpException(
        { success: false, error: message, message },
        HttpStatus.BAD_REQUEST,
      );
    }
    return num;
  }

  /** Copies any provided loyalty-rule fields onto an insert/update payload. */
  private applyLoyaltyRules(body: any, payload: Record<string, any>): void {
    for (const field of [
      'earnRate',
      'redeemRate',
      'redeemCapPercent',
    ] as const) {
      if (body[field] !== undefined) {
        payload[field] = this.validateLoyaltyRule(field, body[field]);
      }
    }
  }

  /**
   * Phase 6.2 — fail fast on a field layout Google cannot render (the
   * Passmint field-count pattern, Part 4).
   *
   * `createGenericClass` builds `cardRowTemplateInfos` with a oneItem /
   * twoItems / threeItems branch and no `else`: a row with four columns
   * matched nothing and vanished from the published class without a word,
   * and Google caps the card at three rows. A 400 here is the difference
   * between "that field is invalid" and "my field silently disappeared".
   */
  private validateFieldRows(value: any): void {
    const bad = (message: string): never => {
      throw new HttpException(
        { success: false, error: message, message },
        HttpStatus.BAD_REQUEST,
      );
    };

    if (!Array.isArray(value)) bad('fieldRows must be an array');
    if (value.length > 3) bad('fieldRows must contain at most 3 rows');

    const seenKeys = new Set<string>();
    for (const row of value) {
      const columns = row?.columns;
      if (!Array.isArray(columns))
        bad('each field row must have a columns array');
      if (columns.length < 1 || columns.length > 3)
        bad('each field row must have between 1 and 3 columns');
      for (const col of columns) {
        const key = col?.key;
        if (key === undefined || key === null || key === '') continue;
        if (typeof key !== 'string') bad('a field key must be a string');
        // The key is the stable binding to the live pass (WAL-1). Two
        // columns sharing one key means one of them never updates.
        if (seenKeys.has(key)) bad(`duplicate field key '${key}'`);
        seenKeys.add(key);
      }
    }
  }

  // Tenant comes from the guard, never from `body.tenantId`.
  @Post()
  @UseGuards(TenantGuard)
  async createTemplate(@Body() body: any, @Req() req: TenantRequest) {
    try {
      let existingId = null;
      const classSuffix = body.classSuffix;
      if (classSuffix) {
        // Find existing template by classSuffix to support upsert behavior
        // if the UI accidentally lost its savedTemplateId state but meant to update.
        const { data: existing } = await this.supabaseService.client
          .from('PassTemplate')
          .select('id')
          .eq('classSuffix', classSuffix)
          .eq('tenantId', req.tenantId)
          .maybeSingle();
        if (existing) {
          existingId = existing.id;
        }
      }

      const upsertPayload: Record<string, any> = {
        tenantId: req.tenantId,
        title: body.name || 'New Template',
        archetype: body.archetype || 'loyalty',
        subtitle: body.name || 'New Template',
        status: 'draft',
        classSuffix,
        // DB-5: a template belongs to a program. Nullable for templates
        // created by callers that predate Phase 3.
        programId: body.programId ?? null,
      };

      if (body.fieldRows !== undefined) {
        this.validateFieldRows(body.fieldRows);
        upsertPayload.fieldRows = body.fieldRows;
      }
      if (body.hexBackgroundColor !== undefined)
        upsertPayload.hexBackgroundColor = this.validateHexColor(
          body.hexBackgroundColor,
        );
      if (body.logoUrl !== undefined) upsertPayload.logoUrl = body.logoUrl;
      if (body.heroImageUrl !== undefined)
        upsertPayload.heroImageUrl = body.heroImageUrl;

      this.applyLoyaltyRules(body, upsertPayload);

      let template;
      let error;

      if (existingId) {
        // The user explicitly requested updating an existing template without sending the ID.
        // Update the template rather than throwing a duplicate key constraint violation.
        const { data, error: updateError } = await this.supabaseService.client
          .from('PassTemplate')
          .update(upsertPayload)
          .eq('id', existingId)
          .select()
          .single();
        template = data;
        error = updateError;
      } else {
        const { data, error: insertError } = await this.supabaseService.client
          .from('PassTemplate')
          .insert(upsertPayload)
          .select()
          .single();
        template = data;
        error = insertError;
      }

      if (error) throw error;

      return { success: true, template: { ...template, name: template.title } };
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get(':id')
  @UseGuards(TenantGuard)
  async getTemplateById(@Param('id') id: string, @Req() req: TenantRequest) {
    try {
      const { data: template, error } = await this.supabaseService.client
        .from('PassTemplate')
        .select('*')
        .eq('id', id)
        .eq('tenantId', req.tenantId)
        .single();
      if (error || !template)
        throw new HttpException(
          { success: false, error: 'Template not found' },
          HttpStatus.NOT_FOUND,
        );
      return { success: true, template: { ...template, name: template.title } };
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete(':id')
  @UseGuards(TenantGuard)
  async deleteTemplate(@Param('id') id: string, @Req() req: TenantRequest) {
    try {
      const { data, error } = await this.supabaseService.client
        .from('PassTemplate')
        .delete()
        .eq('id', id)
        .eq('tenantId', req.tenantId)
        .select();
      if (error) throw error;
      if (!data || !data.length)
        throw new HttpException(
          { success: false, error: 'Template not found' },
          HttpStatus.NOT_FOUND,
        );
      return { success: true };
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post(':id/publish')
  @UseGuards(TenantGuard)
  async publishTemplate(@Param('id') id: string, @Req() req: TenantRequest) {
    try {
      const { classData, template, warning } =
        await this.templatesService.publish(id, req.tenantId!);
      return {
        success: true,
        classData,
        warning,
        template: { ...template, name: template.title },
      };
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Phase 4.1 — read the live Google Wallet class back, raw.
   *
   * The designer can then state what is actually on Google ("Geofences live
   * on Google: 10") instead of assuming the last publish worked. Also
   * surfaces `callbackOptions.url`, which is how ENV-4 (a production class
   * left pointing at someone's localhost) is confirmed or ruled out.
   */
  @Get(':id/wallet-class')
  @UseGuards(TenantGuard)
  async getWalletClass(@Param('id') id: string, @Req() req: TenantRequest) {
    try {
      const { data: template, error } = await this.supabaseService.client
        .from('PassTemplate')
        .select('*, tenant:Tenant(classSuffix)')
        .eq('id', id)
        .eq('tenantId', req.tenantId)
        .single();
      if (error || !template)
        throw new HttpException(
          { success: false, error: 'Template not found' },
          HttpStatus.NOT_FOUND,
        );

      const tenantWallet = await this.walletService.forTenant(req.tenantId!);
      const walletType = await walletTypeForProgram(
        this.supabaseService.client,
        req.tenantId!,
        template.programId,
      );
      const walletClass = await tenantWallet.getGenericClass(
        template.classSuffix || template.tenant?.classSuffix,
        walletType,
      );

      if (!walletClass) {
        return {
          success: true,
          exists: false,
          geofenceCount: 0,
          expectedGeofenceCount: (template.storeLocations ?? []).length,
          callbackUrl: null,
          class: null,
        };
      }

      const callbackUrl = walletClass.callbackOptions?.url ?? null;
      return {
        success: true,
        exists: true,
        classId: walletClass.id,
        geofenceCount: (walletClass.merchantLocations ?? []).length,
        expectedGeofenceCount: (template.storeLocations ?? []).length,
        callbackUrl,
        callbackIsLocalhost: !!(
          callbackUrl && /localhost|127\.0\.0\.1/.test(callbackUrl)
        ),
        class: walletClass,
      };
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, error: error.message },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  /**
   * Phase 1.1 — "Preview on device".
   *
   * Issues a throwaway GenericObject against a dedicated `_preview` class so
   * an admin can scan a QR and see the real pass in their own Wallet before
   * publishing. Deliberately writes **no** `Pass` row: nothing to flag as a
   * preview and nothing that can ever count in member/pass statistics.
   */
  @Post(':id/preview-pass')
  @UseGuards(TenantGuard)
  async previewPass(@Param('id') id: string, @Req() req: TenantRequest) {
    try {
      const { data: template, error: fetchError } =
        await this.supabaseService.client
          .from('PassTemplate')
          .select('*, tenant:Tenant(*)')
          .eq('id', id)
          .eq('tenantId', req.tenantId)
          .single();
      if (fetchError || !template)
        throw new HttpException(
          { success: false, error: 'Template not found' },
          HttpStatus.NOT_FOUND,
        );

      const rowsWithKeys = (template.fieldRows || []).map((row: any) => ({
        ...row,
        columns: row.columns.map((col: any, idx: number) => ({
          ...col,
          key: col.key || `${row.id}_${idx}`,
        })),
      }));

      // Key the preview class per-program so unpublished templates on the same
      // tenant never share (and clobber) each other's Wallet class.
      const previewSuffix = `${template.programId}_preview`;
      const cardTitle = resolveCardTitle(template.tenant?.name, template.title);
      const hexBackgroundColor =
        template.hexBackgroundColor || template.tenant?.brandHexColor;
      const logoUrl = template.logoUrl || template.tenant?.logoUrl;
      const heroImageUrl = template.heroImageUrl || template.tenant?.heroUrl;

      const tenantWallet = await this.walletService.forTenant(req.tenantId!);
      const walletType = await walletTypeForProgram(
        this.supabaseService.client,
        req.tenantId!,
        template.programId,
      );

      // The preview class is disposable: always PATCH/create it so the QR
      // reflects the design as it stands right now, published or not.
      await tenantWallet.createGenericClass(
        {
          classSuffix: previewSuffix,
          cardTitle,
          hexBackgroundColor,
          rows: rowsWithKeys,
          logoUrl,
          heroImageUrl,
          storeLocations: template.storeLocations ?? [],
          isUpdate: false,
        },
        walletType,
      );

      const result = await tenantWallet.createGoogleWalletPass({
        passId: `preview_${id}_${Date.now()}`,
        programId: template.programId || undefined,
        memberName: 'Preview',
        cardTitle,
        balance: '500 Pts',
        tier: 'Preview',
        hexBackgroundColor,
        classSuffix: previewSuffix,
        logoUrl,
        heroImageUrl,
        rows: rowsWithKeys,
        walletType,
      });

      return {
        success: true,
        preview: true,
        googleWalletUrl: result.googleWalletUrl,
        passId: result.passId,
      };
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Pushes the template's current design — colour, logo, hero image and
   * field rows — onto every already-issued, non-deleted Pass of the calling
   * tenant. A design fix on the template only reaches passes issued *after*
   * the fix unless this is run; this patches the ones issued before it.
   *
   * Phase 7.4: queued rather than run inline. A tenant with thousands of
   * passes is minutes of Google Wallet calls, and a browser that gave up
   * waiting used to leave the resync half-applied with nobody tracking it.
   * Poll `GET /campaigns/jobs/:jobId`-style progress via the returned job.
   */
  @Post(':id/resync-passes')
  @UseGuards(TenantGuard)
  async resyncPasses(@Param('id') id: string, @Req() req: TenantRequest) {
    try {
      const { data: template } = await this.supabaseService.client
        .from('PassTemplate')
        .select('id')
        .eq('id', id)
        .eq('tenantId', req.tenantId)
        .maybeSingle();
      if (!template)
        throw new HttpException(
          { success: false, error: 'Template not found' },
          HttpStatus.NOT_FOUND,
        );

      const result = await this.templatesService.resyncPasses(
        req.tenantId!,
        id,
      );
      return { success: true, queued: false, ...result };
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Patch(':id')
  @UseGuards(TenantGuard)
  async updateTemplate(
    @Param('id') id: string,
    @Body() body: any,
    @Req() req: TenantRequest,
  ) {
    try {
      const updatePayload: Record<string, any> = {
        updatedAt: new Date().toISOString(),
      };

      // Selectively apply only the fields provided in the body
      if (body.name !== undefined) updatePayload.title = body.name;
      if (body.programId !== undefined)
        updatePayload.programId = body.programId;
      if (body.archetype !== undefined)
        updatePayload.archetype = body.archetype;
      if (body.fieldRows !== undefined) {
        this.validateFieldRows(body.fieldRows);
        updatePayload.fieldRows = body.fieldRows;
      }
      if (body.hexBackgroundColor !== undefined)
        updatePayload.hexBackgroundColor = this.validateHexColor(
          body.hexBackgroundColor,
        );
      if (body.logoUrl !== undefined) updatePayload.logoUrl = body.logoUrl;
      if (body.heroImageUrl !== undefined)
        updatePayload.heroImageUrl = body.heroImageUrl;

      this.applyLoyaltyRules(body, updatePayload);

      const { data: updated, error } = await this.supabaseService.client
        .from('PassTemplate')
        .update(updatePayload)
        .eq('id', id)
        .eq('tenantId', req.tenantId)
        .select()
        .single();

      if (error) throw error;
      if (!updated) {
        throw new HttpException(
          { success: false, error: 'Template not found' },
          HttpStatus.NOT_FOUND,
        );
      }

      return { success: true, template: { ...updated, name: updated.title } };
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
