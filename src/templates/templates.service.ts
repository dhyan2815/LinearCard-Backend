import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { WalletService, resolveCardTitle } from '../wallet/wallet.service';
import { walletTypeForProgram } from '../wallet/wallet-type.util';
import type { WalletType } from '../types';

/** How many passes are pushed to Google Wallet concurrently. */
const RESYNC_BATCH_SIZE = 10;

/**
 * Publishing a template is the one piece of template logic with a second
 * caller: `POST /programs/:id/publish` publishes every template a program
 * owns (Phase 3.4), and it must do exactly what the designer's Publish
 * button does — same class id bookkeeping, same 409/PATCH fallback check.
 * So it lives here rather than being reimplemented next door.
 */
@Injectable()
export class TemplatesService {
  private readonly logger = new Logger(TemplatesService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly walletService: WalletService,
  ) {}

  /**
   * Phase 7.5 — pushes a template's full current design onto every
   * already-issued, non-deleted pass of the tenant: colour, logo, hero image
   * and field rows. Before this only `hexBackgroundColor` was pushed
   * (WAL-6), so a renamed field or a new logo never reached an issued pass.
   *
   * Phase 7.4 — run from the job queue: a tenant with thousands of passes
   * takes minutes of Google Wallet calls, which is not an HTTP request.
   */
  async resyncPasses(tenantId: string, templateId: string) {
    if (!templateId) throw new Error('templateId missing from job payload');

    const { data: template, error } = await this.supabaseService.client
      .from('PassTemplate')
      .select('*, tenant:Tenant(name)')
      .eq('id', templateId)
      .eq('tenantId', tenantId)
      .single();
    if (error || !template) {
      throw new HttpException(
        { success: false, error: 'Template not found' },
        HttpStatus.NOT_FOUND,
      );
    }

    // Scoped to this template's own program (WAL-11) — without this, resyncing
    // one program's template pushed its colors/logo/fields onto every pass in
    // the tenant, including passes for completely different programs.
    let passesQuery = this.supabaseService.client
      .from('Pass')
      .select('id, fullPassId')
      .eq('tenantId', tenantId)
      .is('deletedAt', null);
    passesQuery = template.programId
      ? passesQuery.eq('programId', template.programId)
      : passesQuery.is('programId', null);
    const { data: passes, error: passesError } = await passesQuery;
    if (passesError) throw passesError;

    const tenantWallet = await this.walletService.forTenant(tenantId);
    const walletType = await walletTypeForProgram(
      this.supabaseService.client,
      tenantId,
      template.programId,
    );
    const all = passes || [];
    let succeeded = 0;
    let failed = 0;

    const t = Date.now();
    const bust = (url?: string) => {
      const r = TemplatesService.resolveImageUrl(url);
      if (!r) return undefined;
      return r.includes('?') ? `${r}&t=${t}` : `${r}?t=${t}`;
    };

    // Batched, not an unbounded fan-out: a tenant with thousands of passes
    // would otherwise open thousands of concurrent Google Wallet requests.
    for (let i = 0; i < all.length; i += RESYNC_BATCH_SIZE) {
      const results = await Promise.allSettled(
        all.slice(i, i + RESYNC_BATCH_SIZE).map((p: any) =>
          // Live values (balance, tier, member name) are preserved inside
          // updateGenericObject; only presentation is overwritten.
          tenantWallet.updateGenericObject(
            p.fullPassId,
            {
              cardTitle: resolveCardTitle(
                template.tenant?.name,
                template.title,
              ),
              hexBackgroundColor: template.hexBackgroundColor,
              logoUrl: bust(template.logoUrl),
              heroImageUrl: bust(template.heroImageUrl),
              rows: template.fieldRows,
              // Force a silent push notification so the phone wakes up and syncs immediately
              pushNotification: 'Pass design updated',
            },
            walletType,
          ),
        ),
      );
      succeeded += results.filter((r) => r.status === 'fulfilled').length;
      failed += results.filter((r) => r.status === 'rejected').length;
    }

    return { total: all.length, succeeded, failed };
  }

  /**
   * Phase 3.2 — eventTicketClass fields live on the Program row (venueName,
   * eventStartsAt, eventEndsAt), not the template. Only fetched alongside
   * `walletType` so a non-ticket publish pays no extra query.
   */
  private async eventFieldsForProgram(programId?: string | null): Promise<{
    venueName?: string;
    eventStartsAt?: string;
    eventEndsAt?: string;
  }> {
    if (!programId) return {};
    const { data } = await this.supabaseService.client
      .from('Program')
      .select('venueName, eventStartsAt, eventEndsAt')
      .eq('id', programId)
      .maybeSingle();
    return {
      venueName: data?.venueName ?? undefined,
      eventStartsAt: data?.eventStartsAt ?? undefined,
      eventEndsAt: data?.eventEndsAt ?? undefined,
    };
  }

  /** Localhost/relative image URLs are unusable by Google Wallet. */
  static resolveImageUrl(url?: string): string | undefined {
    if (!url) return undefined;
    if (url.includes('localhost') || url.includes('127.0.0.1')) {
      return 'https://storage.googleapis.com/wallet-lab-tools-codelab-artifacts-public/pass_google_logo.jpg';
    }
    if (url.startsWith('/')) {
      const baseUrl =
        process.env.NEXT_PUBLIC_BASE_URL?.replace(/\/$/, '') ||
        (process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL.replace('-api', '')}`
          : 'http://localhost:3000');
      if (baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1')) {
        return 'https://storage.googleapis.com/wallet-lab-tools-codelab-artifacts-public/pass_google_logo.jpg';
      }
      return `${baseUrl}${url}`;
    }
    return url;
  }

  async publish(id: string, tenantId: string) {
    const { data: template, error: fetchError } =
      await this.supabaseService.client
        .from('PassTemplate')
        .select('*, tenant:Tenant(*)')
        .eq('id', id)
        .eq('tenantId', tenantId)
        .single();
    if (fetchError || !template)
      throw new HttpException(
        { success: false, error: 'Template not found' },
        HttpStatus.NOT_FOUND,
      );

    const logoUrl = TemplatesService.resolveImageUrl(
      template.logoUrl || template.tenant?.logoUrl,
    );
    const heroImageUrl = TemplatesService.resolveImageUrl(
      template.heroImageUrl || template.tenant?.heroUrl,
    );

    const rowsWithKeys = (template.fieldRows || []).map((row: any) => ({
      ...row,
      columns: row.columns.map((col: any, idx: number) => ({
        ...col,
        key: col.key || `${row.id}_${idx}`,
      })),
    }));

    // GAP-16: a ticket whose own template shows a start-date row (event
    // ticket, access pass, travel ticket) must not be published with that
    // date unset — every member's pass would render a decorative "—"
    // instead of an actual date.
    const hasStartsRow = rowsWithKeys.some((row: any) =>
      row.columns.some((col: any) => col.key === 'event_starts'),
    );
    if (hasStartsRow && template.programId) {
      const { data: programForValidation } = await this.supabaseService.client
        .from('Program')
        .select('eventStartsAt')
        .eq('id', template.programId)
        .maybeSingle();
      if (!programForValidation?.eventStartsAt) {
        throw new HttpException(
          { success: false, error: 'Set a start date before publishing.' },
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    const tenantWallet = await this.walletService.forTenant(tenantId);
    const envKey = tenantWallet.getWalletEnvPrefix() || 'prod';
    const resolvedLocations = template.programId
      ? await this.walletService.storeLocationsForProgram(template.programId)
      : (template.storeLocations ?? []);
    const walletType = await walletTypeForProgram(
      this.supabaseService.client,
      tenantId,
      template.programId,
    );
    const eventFields =
      walletType === 'eventTicket'
        ? await this.eventFieldsForProgram(template.programId)
        : {};

    const classData: any = await tenantWallet.createGenericClass(
      {
        classSuffix: template.classSuffix || template.tenant?.classSuffix,
        cardTitle: resolveCardTitle(template.tenant?.name, template.title),
        tenantName: template.tenant?.name,
        ...eventFields,
        hexBackgroundColor:
          template.hexBackgroundColor || template.tenant?.brandHexColor,
        rows: rowsWithKeys,
        logoUrl,
        heroImageUrl,
        storeLocations: resolvedLocations,
        // Each environment tracks whether *its own* class exists (ENV-1):
        // `googleClassId` alone held whichever environment published last.
        isUpdate: !!(template.googleClassIds || {})[envKey],
      },
      walletType,
    );

    // The 409 fallback returns {existing:true, updated:false} when its own
    // PATCH attempt also failed — without this check that silent failure
    // used to still flip status to 'published'.
    if (classData?.updated === false) {
      throw new HttpException(
        {
          success: false,
          error:
            'Failed to publish: Google Wallet class update was rejected. Template left as draft.',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }

    // Phase 4.1 — Google silently accepts a PATCH and still returns a class
    // with no `merchantLocations`. Publishing then "succeeds" with zero live
    // geofences, which is exactly the failure Part 3 chased for weeks. Surface
    // it instead of leaving the admin to guess.
    const sentLocations = resolvedLocations.length;
    const liveLocations = (
      classData?.merchantLocations ??
      classData?.locations ??
      []
    ).length;
    let warning: string | undefined;
    if (sentLocations > 0 && liveLocations === 0) {
      warning =
        `Published, but Google returned no merchantLocations for ${sentLocations} store location(s). ` +
        'Proximity notifications will not fire. Check the live class via GET /templates/:id/wallet-class.';
      this.logger.warn(`${warning} (template ${id})`);
    }

    const { data: updated, error: updateError } =
      await this.supabaseService.client
        .from('PassTemplate')
        .update({
          status: 'published',
          googleClassId: classData.id,
          googleClassIds: {
            ...(template.googleClassIds || {}),
            [envKey]: classData.id,
          },
          updatedAt: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('tenantId', tenantId)
        .select()
        .single();
    if (updateError) throw updateError;

    if (template.programId) {
      await this.syncSiblingClassLocations(
        tenantId,
        template.programId,
        template.id,
        tenantWallet,
        walletType,
      );

      // Publishing any one tier's design is enough to take the whole
      // program live — the DRAFT badge on the gallery/nav tracks this.
      await this.supabaseService.client
        .from('Program')
        .update({ status: 'published', updatedAt: new Date().toISOString() })
        .eq('id', template.programId)
        .eq('tenantId', tenantId)
        .eq('status', 'draft');
    }

    return { classData, template: updated, warning };
  }

  public async syncSiblingClassLocations(
    tenantId: string,
    programId: string,
    excludeTemplateId: string | null = null,
    tenantWallet: any,
    walletType: WalletType = 'generic',
  ) {
    let query = this.supabaseService.client
      .from('PassTemplate')
      .select(
        'id, classSuffix, googleClassIds, title, hexBackgroundColor, logoUrl, heroImageUrl, tenant:Tenant(name, classSuffix, brandHexColor, logoUrl, heroUrl)',
      )
      .eq('programId', programId)
      .eq('tenantId', tenantId)
      .eq('status', 'published');

    if (excludeTemplateId) {
      query = query.neq('id', excludeTemplateId);
    }

    const { data: siblings } = await query;

    if (!siblings || siblings.length === 0) return;

    const envKey = tenantWallet.getWalletEnvPrefix() || 'prod';
    const storeLocations =
      await tenantWallet.storeLocationsForProgram(programId);

    for (const sibling of siblings) {
      if (!(sibling.googleClassIds || {})[envKey]) continue; // Skip if this env doesn't have a class yet

      try {
        await tenantWallet.patchClassLocations(
          sibling.classSuffix || (sibling.tenant as any)?.classSuffix,
          storeLocations,
          walletType,
        );
        this.logger.log(
          `Synced ${storeLocations.length} locations directly to Google Wallet class ${sibling.classSuffix}`,
        );
      } catch (error: any) {
        this.logger.error(
          `Failed to sync locations to sibling class ${sibling.classSuffix}: ${error.message}`,
        );
      }
    }
  }
}
