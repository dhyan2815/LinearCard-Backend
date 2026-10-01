import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard, TenantRequest } from '../auth/tenant.guard';
import { SupabaseService } from '../supabase/supabase.service';
import { TemplatesService } from '../templates/templates.service';
import { buildClassSuffix, WalletService } from '../wallet/wallet.service';
import { findPreset, presetsForCategory, slugify } from './presets';
import type { ProgramKind } from '../types';

interface ProgramBody {
  presetId?: string;
  name?: string;
  kind?: ProgramKind;
  status?: 'draft' | 'published' | 'archived';
  enrollmentSlug?: string;
  earnRate?: number;
  redeemRate?: number;
  redeemCapPercent?: number;
  eventStartsAt?: string | null;
  eventEndsAt?: string | null;
  venueName?: string | null;
  welcomeMessage?: string | null;
  retentionDays?: number | null;
  storeLocations?: any[];
  whatsappTemplates?: Record<string, string>;
}

interface TierBody {
  name?: string;
  minPoints?: number;
  templateId?: string | null;
}

/**
 * Phase 3.4 — programs are the unit a tenant actually sells (D8: several per
 * tenant). Every route is tenant-scoped through TenantGuard; a `tenantId` in
 * a body or query is never trusted.
 */
@Controller('programs')
@UseGuards(TenantGuard)
export class ProgramsController {
  private readonly logger = new Logger(ProgramsController.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly templatesService: TemplatesService,
    private readonly walletService?: WalletService,
  ) {}

  private bad(message: string): never {
    throw new HttpException(
      { success: false, error: message, message },
      HttpStatus.BAD_REQUEST,
    );
  }

  /** Loads a program the calling tenant owns, or 404s. */
  private async load(id: string, tenantId: string) {
    const { data } = await this.supabaseService.client
      .from('Program')
      .select('*')
      .eq('id', id)
      .eq('tenantId', tenantId)
      .maybeSingle();
    if (!data)
      throw new HttpException(
        { success: false, error: 'Program not found' },
        HttpStatus.NOT_FOUND,
      );
    return data;
  }

  /** Free slug within the tenant: `coffee`, then `coffee_2`, `coffee_3`… */
  private async uniqueSlug(tenantId: string, base: string): Promise<string> {
    const { data } = await this.supabaseService.client
      .from('Program')
      .select('enrollmentSlug')
      .eq('tenantId', tenantId);
    const taken = new Set((data || []).map((r: any) => r.enrollmentSlug));
    const root = slugify(base);
    if (!taken.has(root)) return root;
    for (let i = 2; ; i++) {
      if (!taken.has(`${root}_${i}`)) return `${root}_${i}`;
    }
  }

  /** The presets this tenant's business category allows, for the picker. */
  @Get('presets')
  async presets(@Req() req: TenantRequest) {
    const { data: tenant } = await this.supabaseService.client
      .from('Tenant')
      .select('businessCategory')
      .eq('id', req.tenantId)
      .maybeSingle();
    return {
      success: true,
      presets: presetsForCategory(tenant?.businessCategory),
    };
  }

  @Get()
  async list(@Req() req: TenantRequest) {
    const { data, error } = await this.supabaseService.client
      .from('Program')
      .select('*, tiers:Tier(id), templates:PassTemplate(id, updatedAt)')
      .eq('tenantId', req.tenantId)
      .order('createdAt', { ascending: true });
    if (error)
      throw new HttpException(
        { success: false, error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    return {
      success: true,
      programs: (data || []).map((p: any) => ({
        ...p,
        tierCount: (p.tiers || []).length,
        templateCount: (p.templates || []).length,
      })),
    };
  }

  /**
   * Create from a preset (Phase 3.5): Program + Tiers + one PassTemplate per
   * tier in one call. Per-tier templates are what make the tier-driven design
   * swap real — each tier's template owns its own Google Wallet class
   * (Phase 3.7), so reaching Gold changes the card, not just a text field.
   *
   * ponytail: not a DB transaction — Supabase's REST client has no
   * multi-statement transaction. A failure part-way leaves a draft program
   * the admin can delete; wrap in an RPC if partial creates ever hurt.
   */
  @Post()
  async create(@Body() body: ProgramBody, @Req() req: TenantRequest) {
    const preset = findPreset(body.presetId);
    if (!preset) this.bad('presetId must be one of the known program presets');

    const name = (body.name || preset.name).trim();
    if (!name) this.bad('name is required');

    const { data: tenant } = await this.supabaseService.client
      .from('Tenant')
      .select(
        'id, name, classSuffix, brandHexColor, logoUrl, heroUrl, businessCategory',
      )
      .eq('id', req.tenantId)
      .single();

    // Category comes from the DB row, never the body. Existing programs
    // outside the category are grandfathered; this only blocks new ones.
    if (
      !presetsForCategory(tenant?.businessCategory).some(
        (p) => p.id === preset.id,
      )
    )
      throw new ForbiddenException({
        success: false,
        error: `The ${preset.name} preset is not available for your business category.`,
      });

    const enrollmentSlug = await this.uniqueSlug(
      req.tenantId!,
      body.enrollmentSlug || name,
    );

    const { data: program, error } = await this.supabaseService.client
      .from('Program')
      .insert({
        tenantId: req.tenantId,
        name,
        kind: preset.kind,
        walletType: preset.walletType,
        archetype: preset.archetype,
        status: 'draft',
        enrollmentSlug,
        earnRate: preset.loyalty?.earnRate ?? null,
        redeemRate: preset.loyalty?.redeemRate ?? null,
        redeemCapPercent: preset.loyalty?.redeemCapPercent ?? null,
        eventStartsAt: body.eventStartsAt ?? null,
        eventEndsAt: body.eventEndsAt ?? null,
        venueName: body.venueName ?? null,
        // Phase 6 — comes from the preset, never from the request body: it
        // decides which self-service values the enrollment page may submit.
        enrollmentFields: preset.enrollmentFields ?? null,
        // GAP-13 — visit-counter programs (gym_membership, stamp_card).
        visitMode: preset.visitMode ?? false,
        rewardThreshold: preset.rewardThreshold ?? null,
      })
      .select()
      .single();
    if (error || !program)
      throw new HttpException(
        { success: false, error: error?.message || 'Failed to create program' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );

    const tenantSlug = tenant?.classSuffix || slugify(tenant?.name || 'tenant');
    const baseTemplate = {
      tenantId: req.tenantId,
      programId: program.id,
      archetype: preset.archetype,
      status: 'draft',
      fieldRows: preset.fieldRows,
      hexBackgroundColor: preset.hexBackgroundColor,
      logoUrl: preset.logoUrl ?? tenant?.logoUrl ?? null,
      heroImageUrl: preset.heroUrl ?? tenant?.heroUrl ?? null,
      // Kept in sync with the program for templates that predate the move.
      earnRate: preset.loyalty?.earnRate ?? 0.1,
      redeemRate: preset.loyalty?.redeemRate ?? 1,
      redeemCapPercent: preset.loyalty?.redeemCapPercent ?? 50,
    };

    // A ticket program has no tiers, so it gets exactly one template.
    const specs = preset.tiers.length
      ? preset.tiers.map((t) => ({ tier: t, suffixTier: t.name }))
      : [{ tier: null as null, suffixTier: undefined }];

    const { data: templates, error: templateError } =
      await this.supabaseService.client
        .from('PassTemplate')
        .insert(
          specs.map((s) => ({
            ...baseTemplate,
            title: s.tier ? `${name} — ${s.tier.name}` : name,
            subtitle: name,
            classSuffix: buildClassSuffix(
              tenantSlug,
              enrollmentSlug,
              s.suffixTier,
            ),
          })),
        )
        .select();
    if (templateError)
      throw new HttpException(
        { success: false, error: templateError.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );

    let tiers: any[] = [];
    if (preset.tiers.length) {
      const { data: inserted, error: tierError } =
        await this.supabaseService.client
          .from('Tier')
          .insert(
            preset.tiers.map((t, idx) => ({
              programId: program.id,
              name: t.name,
              minPoints: t.minPoints,
              templateId: (templates || [])[idx]?.id ?? null,
              sortOrder: idx,
            })),
          )
          .select();
      if (tierError)
        throw new HttpException(
          { success: false, error: tierError.message },
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      tiers = inserted || [];
    }

    return { success: true, program, templates: templates || [], tiers };
  }

  @Get(':id')
  async getOne(@Param('id') id: string, @Req() req: TenantRequest) {
    const program = await this.load(id, req.tenantId!);
    const [{ data: tiers }, { data: templates }] = await Promise.all([
      this.supabaseService.client
        .from('Tier')
        .select('*')
        .eq('programId', id)
        .order('sortOrder', { ascending: true }),
      this.supabaseService.client
        .from('PassTemplate')
        .select('*')
        .eq('programId', id)
        .order('createdAt', { ascending: true }),
    ]);
    return {
      success: true,
      program,
      tiers: tiers || [],
      templates: (templates || []).map((t: any) => ({ ...t, name: t.title })),
    };
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: ProgramBody,
    @Req() req: TenantRequest,
  ) {
    const program = await this.load(id, req.tenantId!);

    const payload: Record<string, any> = {
      updatedAt: new Date().toISOString(),
    };
    if (body.name !== undefined) {
      if (!body.name.trim()) this.bad('name cannot be empty');
      payload.name = body.name.trim();
    }
    if (body.status !== undefined) {
      if (!['draft', 'published', 'archived'].includes(body.status))
        this.bad('status must be draft, published or archived');
      payload.status = body.status;
    }
    if (body.enrollmentSlug !== undefined)
      payload.enrollmentSlug = await this.uniqueSlug(
        req.tenantId!,
        body.enrollmentSlug,
      );

    // Loyalty economics only mean anything where points move; accepting
    // them on a ticket program would store numbers nothing ever reads.
    for (const field of ['earnRate', 'redeemRate', 'redeemCapPercent'] as const)
      if (body[field] !== undefined) {
        if (program.kind !== 'loyalty' && program.kind !== 'giftcard')
          this.bad(`${field} is only valid on a loyalty or gift card program`);
        const bounds = {
          earnRate: { min: 0, max: 10 },
          redeemRate: { min: 0.0001, max: 1000 },
          redeemCapPercent: { min: 0, max: 100 },
        }[field];
        const num = Number(body[field]);
        if (isNaN(num) || num < bounds.min || num > bounds.max)
          this.bad(
            `${field} must be a number between ${bounds.min} and ${bounds.max}`,
          );
        payload[field] = num;
      }

    for (const field of ['eventStartsAt', 'eventEndsAt', 'venueName'] as const)
      if (body[field] !== undefined) {
        if (program.kind !== 'ticket')
          this.bad(`${field} is only valid on a ticket program`);
        payload[field] = body[field];
      }

    // Phase 8 — Settings tab. Both apply to every program kind.
    if (body.welcomeMessage !== undefined)
      payload.welcomeMessage = (body.welcomeMessage || '').trim() || null;
    if (body.retentionDays !== undefined) {
      if (body.retentionDays === null || body.retentionDays === ('' as any)) {
        payload.retentionDays = null;
      } else {
        const days = Number(body.retentionDays);
        if (isNaN(days) || days < 1)
          this.bad('retentionDays must be a positive number of days');
        payload.retentionDays = Math.floor(days);
      }
    }

    if (body.storeLocations !== undefined) {
      if (!Array.isArray(body.storeLocations)) {
        this.bad('storeLocations must be an array');
      }
      if (body.storeLocations.length > 10) {
        this.bad('storeLocations must contain at most 10 entries');
      }
      for (const loc of body.storeLocations) {
        if (!loc.latitude || !loc.longitude)
          this.bad('Each store location must have latitude and longitude');
        const lat = parseFloat(loc.latitude);
        const lng = parseFloat(loc.longitude);
        if (isNaN(lat) || lat < -90 || lat > 90)
          this.bad(`Invalid latitude: ${loc.latitude}`);
        if (isNaN(lng) || lng < -180 || lng > 180)
          this.bad(`Invalid longitude: ${loc.longitude}`);
      }
      payload.storeLocations = body.storeLocations;
    }

    if (body.whatsappTemplates !== undefined) {
      if (
        typeof body.whatsappTemplates !== 'object' ||
        Array.isArray(body.whatsappTemplates)
      ) {
        this.bad('whatsappTemplates must be an object');
      }
      payload.whatsappTemplates = body.whatsappTemplates;
    }

    const { data, error } = await this.supabaseService.client
      .from('Program')
      .update(payload)
      .eq('id', id)
      .eq('tenantId', req.tenantId)
      .select()
      .single();
    if (error)
      throw new HttpException(
        { success: false, error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );

    // Keep templates in sync so legacy passes without a programId fall back to the updated rules
    const templateUpdates: any = {};
    if (payload.earnRate !== undefined)
      templateUpdates.earnRate = payload.earnRate;
    if (payload.redeemRate !== undefined)
      templateUpdates.redeemRate = payload.redeemRate;
    if (payload.redeemCapPercent !== undefined)
      templateUpdates.redeemCapPercent = payload.redeemCapPercent;

    if (Object.keys(templateUpdates).length > 0) {
      // Only the published template actually serves passes; a draft under
      // the same program is mid-edit and must keep its own rates until
      // published, not get silently overwritten by a program-level change.
      await this.supabaseService.client
        .from('PassTemplate')
        .update(templateUpdates)
        .eq('programId', id)
        .eq('tenantId', req.tenantId)
        .eq('status', 'published');
    }

    let warning: string | undefined;
    if (body.storeLocations !== undefined && this.walletService) {
      try {
        const tenantWallet = await this.walletService.forTenant(req.tenantId!);
        const walletType = (data.walletType as any) || 'generic';
        await this.templatesService.syncSiblingClassLocations(
          req.tenantId!,
          id,
          null,
          tenantWallet,
          walletType,
        );
      } catch (err: any) {
        this.logger.warn(
          `Could not sync store locations to live Google Wallet classes: ${err.message}`,
        );
        warning = `Locations saved locally, but Google Wallet sync failed: ${err.message}`;
      }
    }

    return { success: true, program: data, ...(warning ? { warning } : {}) };
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Req() req: TenantRequest,
    @Body() body?: { confirmName?: string },
  ) {
    const program = await this.load(id, req.tenantId!);

    // This expires every issued pass in Google Wallet and hard-deletes the
    // Pass rows. The UI asks for the name; the check lives here so a stray
    // curl cannot skip the dialog.
    if ((body?.confirmName || '').trim() !== program.name) {
      this.bad(
        `To delete this program, send confirmName exactly matching "${program.name}".`,
      );
    }

    // 1. Find all passes associated with this program
    const { data: passes } = await this.supabaseService.client
      .from('Pass')
      .select('id, fullPassId')
      .eq('programId', id)
      .eq('tenantId', req.tenantId);

    // 2. Invalidate / expire any issued passes in Google Wallet
    let expiredCount = 0;
    if (passes && passes.length > 0 && this.walletService) {
      try {
        const tenantWallet = await this.walletService.forTenant(req.tenantId!);
        const expirePromises = passes
          .filter((p: any) => p.fullPassId)
          .map(async (p: any) => {
            const success = await tenantWallet.expireGenericObject(
              p.fullPassId,
              (program as any).walletType || 'generic',
            );
            if (success) expiredCount++;
          });
        await Promise.allSettled(expirePromises);
      } catch (err: any) {
        // Log wallet error but proceed with database cleanup
        console.warn(
          `[ProgramsController] Failed to expire Google Wallet passes for program ${id}: ${err?.message}`,
        );
      }
    }

    // 3. Dissociate Campaign references to avoid foreign key errors
    await this.supabaseService.client
      .from('Campaign')
      .update({ programId: null })
      .eq('programId', id)
      .eq('tenantId', req.tenantId);

    // 4. Delete passes for this program from DB
    const { error: passErr } = await this.supabaseService.client
      .from('Pass')
      .delete()
      .eq('programId', id)
      .eq('tenantId', req.tenantId);
    if (passErr) {
      throw new HttpException(
        {
          success: false,
          error: `Failed to delete passes: ${passErr.message}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    // 5. Delete tiers for this program from DB
    const { error: tierErr } = await this.supabaseService.client
      .from('Tier')
      .delete()
      .eq('programId', id);
    if (tierErr) {
      throw new HttpException(
        { success: false, error: `Failed to delete tiers: ${tierErr.message}` },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    // 6. Delete pass templates for this program from DB
    const { error: tplErr } = await this.supabaseService.client
      .from('PassTemplate')
      .delete()
      .eq('programId', id)
      .eq('tenantId', req.tenantId);
    if (tplErr) {
      throw new HttpException(
        {
          success: false,
          error: `Failed to delete templates: ${tplErr.message}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    // 7. Delete the program row itself
    const { error } = await this.supabaseService.client
      .from('Program')
      .delete()
      .eq('id', id)
      .eq('tenantId', req.tenantId);
    if (error)
      throw new HttpException(
        { success: false, error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );

    return { success: true, expiredPassesCount: expiredCount };
  }

  /**
   * Publishes every template the program owns — one Google Wallet class per
   * tier — and then marks the program published. The program only flips once
   * all of its classes exist, so a half-published program never advertises
   * an enrollment URL that would issue against a missing class.
   */
  @Post(':id/publish')
  async publish(@Param('id') id: string, @Req() req: TenantRequest) {
    await this.load(id, req.tenantId!);

    const { data: templates } = await this.supabaseService.client
      .from('PassTemplate')
      .select('id')
      .eq('programId', id)
      .eq('tenantId', req.tenantId);

    if (!templates?.length)
      this.bad('This program has no pass template to publish.');

    const published: string[] = [];
    for (const t of templates) {
      const { template } = await this.templatesService.publish(
        t.id,
        req.tenantId!,
      );
      published.push(template.id);
    }

    const { data: program, error } = await this.supabaseService.client
      .from('Program')
      .update({ status: 'published', updatedAt: new Date().toISOString() })
      .eq('id', id)
      .eq('tenantId', req.tenantId)
      .select()
      .single();
    if (error)
      throw new HttpException(
        { success: false, error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );

    return { success: true, program, publishedTemplateIds: published };
  }

  @Get(':id/tiers')
  async getTiers(@Param('id') id: string, @Req() req: TenantRequest) {
    await this.load(id, req.tenantId!);
    const { data } = await this.supabaseService.client
      .from('Tier')
      .select('*')
      .eq('programId', id)
      .order('sortOrder', { ascending: true });
    return { success: true, tiers: data || [] };
  }

  /**
   * Phase 3.2 (DB-9) — the single tier source of truth. The designer used to
   * write a `tierThresholds` JSONB blob that the scan pipeline ignored
   * entirely; this writes the `Tier` rows `computeTier` actually reads, so
   * editing a tier here changes what the next scan computes.
   *
   * Replaces the whole set: the editor always sends the full list.
   */
  @Patch(':id/tiers')
  async setTiers(
    @Param('id') id: string,
    @Body() body: { tiers?: TierBody[] },
    @Req() req: TenantRequest,
  ) {
    const program = await this.load(id, req.tenantId!);
    if (program.kind !== 'loyalty')
      this.bad(`${program.kind} programs have no tiers.`);

    const tiers = body?.tiers;
    if (!Array.isArray(tiers)) this.bad('tiers must be an array');

    const seen = new Set<number>();
    for (const t of tiers) {
      if (!t?.name?.trim()) this.bad('each tier requires a non-empty name');
      const min = Number(t.minPoints);
      if (isNaN(min) || min < 0) this.bad('minPoints must be a number >= 0');
      if (seen.has(min)) this.bad('tiers must have distinct minPoints values');
      seen.add(min);
    }

    // Templates this program owns, so a tier can never point at another
    // program's (or another tenant's) design.
    const { data: owned } = await this.supabaseService.client
      .from('PassTemplate')
      .select('id')
      .eq('programId', id)
      .eq('tenantId', req.tenantId);
    const ownedIds = new Set((owned || []).map((t: any) => t.id));
    const fallbackTemplateId = (owned || [])[0]?.id ?? null;
    for (const t of tiers)
      if (t.templateId && !ownedIds.has(t.templateId))
        this.bad('templateId must belong to this program');

    await this.supabaseService.client.from('Tier').delete().eq('programId', id);

    if (!tiers.length) return { success: true, tiers: [] };

    const ordered = [...tiers].sort(
      (a, b) => Number(a.minPoints) - Number(b.minPoints),
    );
    const { data, error } = await this.supabaseService.client
      .from('Tier')
      .insert(
        ordered.map((t, idx) => ({
          programId: id,
          name: t.name!.trim(),
          minPoints: Number(t.minPoints),
          templateId: t.templateId ?? fallbackTemplateId,
          sortOrder: idx,
        })),
      )
      .select();
    if (error)
      throw new HttpException(
        { success: false, error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );

    return { success: true, tiers: data || [] };
  }

  /**
   * Sync store locations from the live Google Wallet class (via any template)
   * into the Program's local storeLocations array.
   */
  @Post(':id/sync-locations')
  async syncLocations(@Param('id') id: string, @Req() req: TenantRequest) {
    if (!this.walletService)
      this.bad('Google Wallet is disabled in this environment');
    const program = await this.load(id, req.tenantId!);

    // Find all templates for this program to gather possible class suffixes
    const { data: templates } = await this.supabaseService.client
      .from('PassTemplate')
      .select('classSuffix, tenant:Tenant(classSuffix)')
      .eq('programId', id)
      .eq('tenantId', req.tenantId);

    const tenantWallet = await this.walletService.forTenant(req.tenantId!);

    // Collect all possible suffixes to check (most specific first)
    const suffixesToCheck = new Set<string>();

    // 1. Explicit classSuffix from templates
    for (const t of templates || []) {
      if (t.classSuffix) {
        suffixesToCheck.add(t.classSuffix);
      }
    }

    // 2. Dynamically generated standard program classSuffix
    const { data: tenantData } = await this.supabaseService.client
      .from('Tenant')
      .select('slug')
      .eq('id', req.tenantId)
      .single();
    if (tenantData?.slug && program.enrollmentSlug) {
      suffixesToCheck.add(
        buildClassSuffix(tenantData.slug, program.enrollmentSlug),
      );
    }

    // 3. Fallback to tenant's default classSuffix
    for (const t of templates || []) {
      const tenantClassSuffix = Array.isArray(t.tenant)
        ? (t.tenant as any)[0]?.classSuffix
        : (t.tenant as any)?.classSuffix;
      if (tenantClassSuffix) {
        suffixesToCheck.add(tenantClassSuffix);
      }
    }

    let walletClass = null;

    // Try each suffix until we find one that is actually live on Google Wallet
    for (const suffix of suffixesToCheck) {
      const cls = await tenantWallet.getGenericClass(
        suffix,
        (program as any).walletType || 'generic',
      );
      if (cls) {
        walletClass = cls;
        break;
      }
    }

    if (!walletClass) {
      return {
        success: false,
        error:
          'No live wallet class found for this program on Google. Publish a template first.',
      };
    }

    // Map Google's merchantLocations { latitude, longitude } back to our local schema
    const liveLocations = walletClass.merchantLocations ?? [];
    const storeLocations = liveLocations.map((loc: any) => ({
      latitude: String(loc.latitude),
      longitude: String(loc.longitude),
      label: '', // Google does not store our labels
    }));

    // Update the database
    const { error: updateError } = await this.supabaseService.client
      .from('Program')
      .update({ storeLocations })
      .eq('id', id);

    if (updateError) {
      throw new HttpException(
        {
          success: false,
          error: 'Failed to save synced locations to database',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return { success: true, storeLocations };
  }
}
