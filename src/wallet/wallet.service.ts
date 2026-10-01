import {
  Injectable,
  Logger,
  HttpException,
  HttpStatus,
  ForbiddenException,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { GoogleAuth } from 'google-auth-library';
import { SupabaseService } from '../supabase/supabase.service';
import { NotifyService } from '../notification/notify.service';
import { WhatsappService } from '../notification/whatsapp.service';
import { computeTier } from '../tiers/tier.util';
import { AuditService } from '../audit/audit.service';
import { WebhookService } from '../developers/webhook.service';
import type { Tier, WalletType } from '../types';
import { DEFAULT_PASS_HEX } from '../programs/presets';
import { decryptSecret } from '../env';
import { ServiceError, describeError, walletError } from '../errors';
import {
  hasTokens,
  interpolateTemplateRow,
  type PassContext,
} from './template-interpolator';
import {
  walletResources,
  buildGiftCardClassPayload,
  buildGiftCardObjectPayload,
  buildOfferClassPayload,
  buildOfferObjectPayload,
  buildEventTicketClassPayload,
  buildEventTicketObjectPayload,
  buildLoyaltyClassPayload,
  buildLoyaltyObjectPayload,
} from './wallet-types';

const WALLET_API_BASE = 'https://walletobjects.googleapis.com/walletobjects/v1';

/**
 * Canonical field keys (Phase 1.2, the Passlet pattern).
 *
 * `textModulesData[].id` is the stable binding between a template column and
 * the live Google Wallet object. Updates match on these ids and NEVER on the
 * display header — renaming "Points" to "Stars" in the designer used to
 * silently stop balance updates on every issued pass (WAL-1).
 *
 * The `*_LEGACY` entries are ids written by older code paths, kept so passes
 * issued before this change keep updating.
 */
export const POINTS_FIELD_KEYS = ['points', 'balance'];
export const TIER_FIELD_KEYS = ['tier', 'tier_info'];
export const MEMBER_ID_FIELD_KEY = 'memberId';
export const MEMBER_NAME_FIELD_KEY = 'memberName';

/**
 * Part 4 — the Passmint `applyRaw` escape hatch.
 *
 * Google ships Wallet fields faster than this service models them. Without an
 * escape hatch, wanting one unmodelled field (`notifyPreference`,
 * `linksModuleData`, a `textModulesData` shape we do not build) means editing
 * the builder and redeploying. `applyRaw` deep-merges a caller-supplied object
 * into the payload immediately before the request, so an unmodelled field is a
 * template row rather than a code change.
 *
 * Protected paths are the exception. `id` and `classId` decide *which* class or
 * object gets written — under one shared issuer (D15), letting raw change them
 * turns a template edit into a write against someone else's pass. And
 * `callbackOptions` is the ENV-4 guard: `resolveCallbackUrl()` throws on a
 * localhost URL, which raw could otherwise put back. These stay under the
 * builder's control and a raw attempt to set them is dropped, loudly.
 */
export const RAW_PROTECTED_KEYS = ['id', 'classId', 'callbackOptions'];

/**
 * Recursive merge. Plain objects merge key by key; arrays and scalars replace
 * wholesale, because a half-merged `merchantLocations` or `cardRowTemplateInfos`
 * is never what the caller meant.
 */
/**
 * The brand line shown at the top of every Google Wallet pass and as the
 * class `issuerName`. Combines the tenant's name with the program/template
 * title so two presets under one tenant (e.g. "Bistro Cafe" running both a
 * Coffee Loyalty and a Gift Card program) are distinguishable on the pass —
 * previously this picked the tenant name ALONE whenever it was present,
 * which is always, so the program name was silently dropped (WAL-10).
 */
export function resolveCardTitle(
  tenantName?: string | null,
  templateTitle?: string | null,
): string | undefined {
  if (tenantName && templateTitle) return `${tenantName} · ${templateTitle}`;
  return tenantName || templateTitle || undefined;
}

export function deepMergeRaw(base: any, raw: any): any {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const isPlainObject =
      value !== null && typeof value === 'object' && !Array.isArray(value);
    out[key] =
      isPlainObject &&
      out[key] !== null &&
      typeof out[key] === 'object' &&
      !Array.isArray(out[key])
        ? deepMergeRaw(out[key], value)
        : value;
  }
  return out;
}

/**
 * `deepMergeRaw` with the protected top-level keys stripped first. Returns the
 * merged payload plus the names of any keys that were refused, so the caller
 * can log them rather than letting an override vanish silently — a raw field
 * that does nothing with no explanation is the bug this pattern exists to
 * prevent.
 */
export function applyRaw(
  base: any,
  raw: any,
): { payload: any; refused: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { payload: base, refused: [] };

  const refused: string[] = [];
  const allowed: Record<string, any> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (RAW_PROTECTED_KEYS.includes(key)) refused.push(key);
    else allowed[key] = value;
  }
  return { payload: deepMergeRaw(base, allowed), refused };
}

/**
 * Per-brand loyalty economics (Phase 1.3, WAL-4). These live on
 * `PassTemplate` as the interim home — they move onto `Program` in Phase 3.
 * The defaults are exactly what used to be hardcoded in
 * `processOrderTransaction`, so a template that predates the columns behaves
 * as before.
 */
export interface LoyaltyRules {
  /** Points earned per currency unit spent. 0.1 = 10%. */
  earnRate: number;
  /** Currency discount per point redeemed. 1 = 1 point : ₹1. */
  redeemRate: number;
  /** Max share of an order that points may cover, 0–100. */
  redeemCapPercent: number;
  /** GAP-13 — a visit counter; the scanner locks amount=1 instead of trusting the till. */
  visitMode?: boolean;
  /** GAP-13 — fires a one-time reward notification when balance first reaches this value. */
  rewardThreshold?: number | null;
}

export const DEFAULT_LOYALTY_RULES: LoyaltyRules = {
  earnRate: 0.1,
  redeemRate: 1,
  redeemCapPercent: 50,
  visitMode: false,
  rewardThreshold: null,
};

/** Columns pulled from the embedded PassTemplate rows when scoring a scan. */
// `fieldRows` rides along so a transaction can re-evaluate `{{token}}`
// columns against the new balance/tier without a second template query.
export const PASS_TEMPLATE_RULE_FIELDS =
  'id, status, updatedAt, programId, earnRate, redeemRate, redeemCapPercent, fieldRows';

/**
 * Phase 3.7 (DB-6) — every Google Wallet class suffix derives from the
 * tenant / program / tier it belongs to, never the shared
 * `'linearcard_sandbox_class'` literal that made two brands collide on one
 * class. Each tier gets its own suffix so the tier-driven design swap in
 * `syncPassAfterTransaction` actually swaps classes.
 *
 * The environment prefix is *not* part of this: it is applied at call time
 * by `resolveClassId`, because the suffix is stored in a row shared by all
 * three environments (D13/D15).
 */
export function buildClassSuffix(
  tenantSlug: string,
  programSlug: string,
  tierSlug?: string,
): string {
  const clean = (s: string) =>
    (s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  return [clean(tenantSlug) || 'tenant', clean(programSlug) || 'program']
    .concat(tierSlug ? [clean(tierSlug)] : [])
    .join('_');
}

/**
 * Picks the loyalty rules a transaction is scored against: the published
 * template (most recently updated), else any template, else the defaults.
 * Mirrors `resolveTenantPassDesign`'s resolution order so the rules and the
 * design a member sees always come from the same template.
 *
 * `programId` narrows the candidates to that program's templates (Phase 3.3)
 * — without it, a tenant running two programs could score a coffee scan
 * against the gym program's earn rate.
 */
export function resolveLoyaltyRules(
  templates: any,
  programId?: string | null,
): LoyaltyRules {
  const all: any[] = Array.isArray(templates)
    ? templates
    : templates
      ? [templates]
      : [];
  const scoped = programId
    ? all.filter((t) => t?.programId === programId)
    : all;
  const rows = scoped.length ? scoped : programId ? [] : all;
  const published = rows
    .filter((t) => t?.status === 'published')
    .sort((a, b) =>
      String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
    );
  const template = published[0] || rows[0];
  if (!template) return DEFAULT_LOYALTY_RULES;

  const num = (value: any, fallback: number) =>
    value === null || value === undefined || isNaN(Number(value))
      ? fallback
      : Number(value);

  return {
    earnRate: num(template.earnRate, DEFAULT_LOYALTY_RULES.earnRate),
    redeemRate: num(template.redeemRate, DEFAULT_LOYALTY_RULES.redeemRate),
    redeemCapPercent: num(
      template.redeemCapPercent,
      DEFAULT_LOYALTY_RULES.redeemCapPercent,
    ),
    // A template never carries visitMode/rewardThreshold — only the Program
    // row does (rulesForPass reads it there).
    visitMode: false,
    rewardThreshold: null,
  };
}

/**
 * The rules a scan is actually scored against: the Program row owns them
 * (Phase 3.1), falling back to the program's templates, then the defaults.
 *
 * Shared by `processOrderTransaction` and `validate-pass` so the preview the
 * cashier reads on screen and the maths the server does are the same numbers
 * — the scanner used to hardcode 10% / 50% and quietly disagree with every
 * brand whose economics differ (WAL-4).
 */
export function rulesForPass(
  programRow: any,
  templates: any,
  programId?: string | null,
): LoyaltyRules {
  if (programRow && programRow.earnRate !== null) {
    return {
      earnRate: Number(programRow.earnRate),
      redeemRate: Number(programRow.redeemRate ?? 1),
      redeemCapPercent: Number(programRow.redeemCapPercent ?? 50),
      visitMode: !!programRow.visitMode,
      rewardThreshold: programRow.rewardThreshold ?? null,
    };
  }
  return resolveLoyaltyRules(templates, programId);
}

export interface WalletCredentials {
  issuerId: string;
  clientEmail: string;
  privateKey: string;
}

export interface GoogleWalletPassOptions {
  passId: string;
  memberName?: string;
  cardTitle?: string;
  balance?: string;
  tier?: string;
  hexBackgroundColor?: string;
  /** Defaults to 'generic' — every un-migrated caller keeps its old behaviour. */
  walletType?: WalletType;
  // No barcodeValue: the barcode payload is derived from passId (AUTH-4) and is
  // deliberately not caller-supplied, so no call site can put a phone in it.
  barcodeAltText?: string;
  classSuffix?: string;
  logoUrl?: string;
  heroImageUrl?: string;
  rows?: any[];
  programId?: string;
  /** eventTicket only — class-level fields, from the Program row. */
  venueName?: string;
  eventStartsAt?: string;
  eventEndsAt?: string;
  /** Part 4 escape hatch — deep-merged last. See `applyRaw`. */
  rawObject?: Record<string, any>;
}

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  // Set only on an instance returned by forTenant(); a plain injected
  // singleton has this null and resolves credentials from env on every call
  // — this is what keeps every pre-existing call site working unchanged.
  private credentials: WalletCredentials | null = null;

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly notifyService: NotifyService,
    private readonly whatsappService: WhatsappService,
    private readonly auditService: AuditService,
    private readonly webhookService: WebhookService,
  ) {}

  /**
   * Returns a WalletService instance scoped to one tenant's Google Wallet
   * credentials (decrypted from the Tenant row), falling back field-by-field
   * to the shared env vars when the tenant hasn't configured its own yet.
   * Shares this instance's already-injected collaborators (DB/notify/audit/
   * webhook services) — only the credential resolution differs.
   */
  public async forTenant(tenantId: string): Promise<WalletService> {
    const scoped = new WalletService(
      this.supabaseService,
      this.notifyService,
      this.whatsappService,
      this.auditService,
      this.webhookService,
    );
    scoped.credentials = await this.resolveTenantCredentials(tenantId);
    return scoped;
  }

  private async resolveTenantCredentials(
    tenantId: string,
  ): Promise<WalletCredentials> {
    const { data: tenant } = await this.supabaseService.client
      .from('Tenant')
      .select('issuerId, googleClientEmail, googlePrivateKeyEncrypted')
      .eq('id', tenantId)
      .single();

    const issuerId = tenant?.issuerId || process.env.ISSUER_ID;
    const clientEmail =
      tenant?.googleClientEmail || process.env.GOOGLE_CLIENT_EMAIL;
    const rawKey = tenant?.googlePrivateKeyEncrypted
      ? decryptSecret(tenant.googlePrivateKeyEncrypted)
      : process.env.GOOGLE_PRIVATE_KEY;

    if (!issuerId || !clientEmail || !rawKey) {
      throw new ServiceError(
        'WALLET_CREDENTIALS_MISSING',
        `Missing Google Wallet credentials for tenant ${tenantId}. Configure Tenant.issuerId/googleClientEmail/googlePrivateKeyEncrypted or set ISSUER_ID/GOOGLE_CLIENT_EMAIL/GOOGLE_PRIVATE_KEY in .env.`,
      );
    }

    return { issuerId, clientEmail, privateKey: this.formatPrivateKey(rawKey) };
  }

  /**
   * Single source of truth for credential resolution. Collapses what used to
   * be five separate `process.env.ISSUER_ID` reads (three with a hardcoded
   * issuer-string fallback) into one path: prefer credentials set via
   * forTenant(), else resolve straight from env, else throw — never silently
   * produce a broken `"undefined.suffix"` class/object id.
   */
  private getCredentialsOrThrow(): WalletCredentials {
    if (this.credentials) return this.credentials;

    const issuerId = process.env.ISSUER_ID;
    const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
    const rawKey = process.env.GOOGLE_PRIVATE_KEY;

    if (!issuerId || !clientEmail || !rawKey) {
      throw new ServiceError(
        'WALLET_CREDENTIALS_MISSING',
        'Missing Google Wallet credentials. Please ensure ISSUER_ID, GOOGLE_CLIENT_EMAIL, and GOOGLE_PRIVATE_KEY are set in .env',
      );
    }

    return { issuerId, clientEmail, privateKey: this.formatPrivateKey(rawKey) };
  }

  /**
   * Formats private key handling newline escapes and PEM headers
   */
  private formatPrivateKey(rawKey: string): string {
    if (!rawKey) {
      throw new ServiceError(
        'WALLET_CREDENTIALS_MISSING',
        'GOOGLE_PRIVATE_KEY is missing in environment variables',
      );
    }
    let key = rawKey.replace(/\\n/g, '\n').trim();
    // Ensure the private key string contains the necessary PEM headers for JWT signing
    if (
      !key.includes('BEGIN PRIVATE KEY') &&
      !key.includes('BEGIN RSA PRIVATE KEY')
    ) {
      key = `-----BEGIN PRIVATE KEY-----\n${key}\n-----END PRIVATE KEY-----\n`;
    }
    return key;
  }

  public async getGoogleAuthClient() {
    const { clientEmail, privateKey } = this.getCredentialsOrThrow();

    const auth = new GoogleAuth({
      credentials: {
        client_email: clientEmail,
        private_key: privateKey,
      },
      scopes: ['https://www.googleapis.com/auth/wallet_object.issuer'],
    });

    return await auth.getClient();
  }

  /**
   * Single source of truth for a tenant's pass design. Prefers the tenant's
   * published PassTemplate (what the designer shows) and falls back to
   * Tenant.brandHexColor only when no published template exists — avoids the
   * class/object mismatch where issuance stamped the stale tenant colour
   * over a template the designer had already re-coloured.
   *
   * `templateId` optionally pins the design to a specific PassTemplate
   * (e.g. the one a member's new `Tier` points at after a tier change).
   *
   * `programId` scopes the fallback to that program's templates (PRG-2,
   * Phase 3.3). Under D8 a tenant runs several programs, so "the tenant's
   * most recently updated published template" is actively wrong — publishing
   * a gym template would change the design used to issue a coffee pass. The
   * tenant-wide fallback survives only for callers with no program in hand
   * (legacy passes whose `programId` the backfill could not set).
   */
  public async resolveTenantPassDesign(
    tenantId: string,
    templateId?: string,
    programId?: string,
  ): Promise<{
    hexBackgroundColor: string;
    logoUrl?: string;
    heroImageUrl?: string;
    classSuffix?: string;
    cardTitle?: string;
    fieldRows?: any[];
    programId?: string;
  }> {
    const { data: tenant } = await this.supabaseService.client
      .from('Tenant')
      .select('*')
      .eq('id', tenantId)
      .single();

    let template: any = null;
    if (templateId) {
      const { data } = await this.supabaseService.client
        .from('PassTemplate')
        .select('*')
        .eq('id', templateId)
        .eq('tenantId', tenantId)
        .maybeSingle();
      template = data;
    }

    if (!template && programId) {
      const { data } = await this.supabaseService.client
        .from('PassTemplate')
        .select('*')
        .eq('tenantId', tenantId)
        .eq('programId', programId)
        .eq('status', 'published')
        .order('updatedAt', { ascending: false })
        .limit(1)
        .maybeSingle();
      template = data;
    }

    // No program in hand: fall back to the tenant's latest published
    // template. Correct only while a pass has no program attached.
    if (!template && !programId) {
      const { data } = await this.supabaseService.client
        .from('PassTemplate')
        .select('*')
        .eq('tenantId', tenantId)
        .eq('status', 'published')
        .order('updatedAt', { ascending: false })
        .limit(1)
        .maybeSingle();
      template = data;
    }

    if (template) {
      return {
        hexBackgroundColor:
          template.hexBackgroundColor ||
          tenant?.brandHexColor ||
          DEFAULT_PASS_HEX,
        logoUrl: template.logoUrl || tenant?.logoUrl,
        heroImageUrl: template.heroImageUrl || tenant?.heroUrl,
        classSuffix: template.classSuffix || tenant?.classSuffix,
        cardTitle: resolveCardTitle(tenant?.name, template.title),
        fieldRows: template.fieldRows || [],
        programId: template.programId || programId,
      };
    }

    return {
      hexBackgroundColor: tenant?.brandHexColor || DEFAULT_PASS_HEX,
      logoUrl: tenant?.logoUrl,
      heroImageUrl: tenant?.heroUrl,
      classSuffix: tenant?.classSuffix,
      cardTitle: tenant?.name,
      fieldRows: [],
      programId: programId,
    };
  }

  /**
   * Environment prefix for Google Wallet class ids (Phase 0.2).
   *
   * Local, preview and production share one issuer (D15) and one database
   * (D13), so without this every environment resolves to the *same* live
   * class. The prefix is computed at call time and is never persisted onto
   * `PassTemplate.classSuffix` — that row is shared by all three
   * environments, so a stored prefix would be wrong for two of them.
   *
   * Production deliberately resolves to an *empty* prefix so existing live
   * classes (created before this change) keep their ids and already-issued
   * passes keep working.
   */
  public getWalletEnvPrefix(): string {
    const explicit = process.env.WALLET_ENV_PREFIX?.trim();
    if (explicit) return explicit === 'none' ? '' : explicit;

    const vercelEnv =
      process.env.VERCEL_ENV || process.env.NEXT_PUBLIC_VERCEL_ENV;
    if (vercelEnv === 'production') return '';
    if (vercelEnv === 'preview') return 'preview';
    return 'dev';
  }

  /** `${issuerId}.${envPrefix}_${classSuffix}` — the only place class ids are built. */
  public resolveClassId(issuerId: string, classSuffix?: string): string {
    const prefix = this.getWalletEnvPrefix();
    const suffix = classSuffix || 'linearcard_sandbox_class';
    return `${issuerId}.${prefix ? `${prefix}_` : ''}${suffix}`;
  }

  /**
   * Callback URL written into the class (ENV-2, ENV-4).
   *
   * Throws rather than PATCHing when the resolved URL is localhost: a local
   * publish would otherwise repoint *production's* callbacks at a machine
   * that isn't on the internet. Publishing locally requires an explicit
   * public tunnel URL in `PUBLIC_CALLBACK_URL`.
   */
  public resolveCallbackUrl(): string {
    const isDeployed = !!process.env.VERCEL_ENV;
    const base = (
      (!isDeployed && process.env.PUBLIC_CALLBACK_URL) ||
      process.env.NEXT_PUBLIC_API_URL ||
      (process.env.VERCEL_BRANCH_URL
        ? `https://${process.env.VERCEL_BRANCH_URL}`
        : '') ||
      (process.env.NEXT_PUBLIC_VERCEL_BRANCH_URL
        ? `https://${process.env.NEXT_PUBLIC_VERCEL_BRANCH_URL}`
        : '') ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')
    ).replace(/\/$/, '');

    if (!base) {
      throw new ServiceError(
        'WALLET_CALLBACK_UNSAFE',
        'Cannot resolve a Google Wallet callback URL. Set PUBLIC_CALLBACK_URL (a public https URL, e.g. an ngrok tunnel) before publishing.',
      );
    }
    if (/localhost|127\.0\.0\.1/.test(base)) {
      throw new ServiceError(
        'WALLET_CALLBACK_UNSAFE',
        `Refusing to publish a Google Wallet class with a localhost callback URL (${base}). ` +
          'This would repoint live pass holders at a machine that is not on the internet. ' +
          'Set PUBLIC_CALLBACK_URL to a public tunnel URL to publish from a local machine.',
      );
    }

    const secret = process.env.WALLET_WEBHOOK_SECRET;
    return `${base}/passes/webhooks/google-wallet${secret ? `/${secret}` : ''}`;
  }

  /**
   * Geofences for a program. The Program row is the canonical source of truth
   * for locations (shared by all tiers in that program).
   */
  public async storeLocationsForProgram(programId?: string): Promise<any[]> {
    if (!programId) return [];
    try {
      const { data } = await this.supabaseService.client
        .from('Program')
        .select('storeLocations')
        .eq('id', programId)
        .single();
      return data?.storeLocations ?? [];
    } catch {
      return [];
    }
  }

  public async createGenericClass(
    templateData: any,
    walletType: WalletType = 'generic',
  ) {
    const client = await this.getGoogleAuthClient();
    const { issuerId } = this.getCredentialsOrThrow();
    const classId = this.resolveClassId(issuerId, templateData.classSuffix);
    const { classResource } = walletResources(walletType);

    if (walletType === 'giftCard') {
      return this.upsertClass(
        client,
        classResource,
        classId,
        buildGiftCardClassPayload({
          classId,
          merchantName: templateData.cardTitle || 'LinearCard',
          programLogoUrl: templateData.logoUrl,
          heroImageUrl: templateData.heroImageUrl,
          hexBackgroundColor:
            templateData.hexBackgroundColor || DEFAULT_PASS_HEX,
          merchantLocations: templateData.storeLocations,
          callbackUrl: this.resolveCallbackUrl(),
        }),
        !!templateData.isUpdate,
      );
    }

    if (walletType === 'offer') {
      return this.upsertClass(
        client,
        classResource,
        classId,
        buildOfferClassPayload({
          classId,
          title: templateData.cardTitle || 'LinearCard',
          provider:
            templateData.provider || templateData.tenantName || 'LinearCard',
          hexBackgroundColor:
            templateData.hexBackgroundColor || DEFAULT_PASS_HEX,
          titleImageUrl: templateData.heroImageUrl,
          callbackUrl: this.resolveCallbackUrl(),
        }),
        !!templateData.isUpdate,
      );
    }

    if (walletType === 'eventTicket') {
      return this.upsertClass(
        client,
        classResource,
        classId,
        buildEventTicketClassPayload({
          classId,
          eventName: templateData.cardTitle || 'LinearCard',
          issuerName: templateData.tenantName || 'LinearCard',
          venueName: templateData.venueName,
          startDateTime: templateData.eventStartsAt,
          endDateTime: templateData.eventEndsAt,
          logoUrl: templateData.logoUrl,
          heroImageUrl: templateData.heroImageUrl,
          hexBackgroundColor:
            templateData.hexBackgroundColor || DEFAULT_PASS_HEX,
          callbackUrl: this.resolveCallbackUrl(),
        }),
        !!templateData.isUpdate,
      );
    }

    if (walletType === 'loyalty') {
      return this.upsertClass(
        client,
        classResource,
        classId,
        buildLoyaltyClassPayload({
          classId,
          programName: templateData.cardTitle || 'LinearCard',
          issuerName: templateData.tenantName || 'LinearCard',
          programLogoUrl: templateData.logoUrl,
          heroImageUrl: templateData.heroImageUrl,
          hexBackgroundColor:
            templateData.hexBackgroundColor || DEFAULT_PASS_HEX,
          rewardsTierLabel: 'Tier',
          accountIdLabel: 'Member ID',
          callbackUrl: this.resolveCallbackUrl(),
        }),
        !!templateData.isUpdate,
      );
    }

    const cardRowTemplateInfos: any[] = [];
    if (templateData.rows && templateData.rows.length > 0) {
      templateData.rows.forEach((row: any) => {
        const items = row.columns.map((col: any, idx: number) => {
          const fieldId = col.key || `${row.id}_${idx}`;
          return {
            item: {
              fieldSelector: {
                fields: [
                  {
                    fieldPath: `object.textModulesData['${fieldId}']`,
                  },
                ],
              },
            },
          };
        });

        if (items.length === 1)
          cardRowTemplateInfos.push({ oneItem: items[0] });
        else if (items.length === 2)
          cardRowTemplateInfos.push({
            twoItems: { startItem: items[0], endItem: items[1] },
          });
        else if (items.length === 3)
          cardRowTemplateInfos.push({
            threeItems: {
              startItem: items[0],
              middleItem: items[1],
              endItem: items[2],
            },
          });
      });
    }

    const classPayload: any = {
      id: classId,
      issuerName: templateData.cardTitle || 'LinearCard',
      hexBackgroundColor: templateData.hexBackgroundColor || DEFAULT_PASS_HEX,
    };

    // Google Wallet ignores hexBackgroundColor if no logo is provided.
    // To match the frontend preview card's behavior, we generate a fallback initials logo.
    let finalLogoUrl = templateData.logoUrl;
    if (!finalLogoUrl) {
      const initials = (templateData.cardTitle || 'LC')
        .substring(0, 2)
        .toUpperCase();
      finalLogoUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(initials)}&background=f1f5f9&color=94a3b8&size=128&font-size=0.45`;
    }

    if (finalLogoUrl) {
      classPayload.logo = { sourceUri: { uri: finalLogoUrl } };
    }
    if (templateData.heroImageUrl) {
      classPayload.heroImage = {
        sourceUri: { uri: templateData.heroImageUrl },
      };
    }

    if (cardRowTemplateInfos.length > 0) {
      classPayload.classTemplateInfo = {
        cardTemplateOverride: {
          cardRowTemplateInfos,
        },
      };
    }

    // Google Wallet OS-level proximity notifications. Max 10 per class;
    // extras are truncated here rather than relying on Google to do it.
    // Uses the non-deprecated `merchantLocations` field (simple
    // {latitude, longitude} pairs) — NOT the deprecated `locations` /
    // `walletobjects#latLongPoint` shape used by older code.
    if (
      Array.isArray(templateData.storeLocations) &&
      templateData.storeLocations.length > 0
    ) {
      classPayload.merchantLocations = templateData.storeLocations
        .slice(0, 10)
        .map(
          (l: { latitude: number | string; longitude: number | string }) => ({
            latitude: Number(l.latitude),
            longitude: Number(l.longitude),
          }),
        );
    }

    // Throws on a localhost URL rather than poisoning a live class (ENV-4).
    classPayload.callbackOptions = { url: this.resolveCallbackUrl() };

    // Part 4 — applied last, so raw can override anything the builder set
    // above except the protected keys.
    const { payload: finalClassPayload, refused } = applyRaw(
      classPayload,
      templateData.rawClass,
    );
    if (refused.length) {
      this.logger.warn(
        `rawClass tried to set protected ${refused.join(', ')} on ${classId} — ignored.`,
      );
    }

    const url = `https://walletobjects.googleapis.com/walletobjects/v1/genericClass`;

    try {
      if (templateData.isUpdate) {
        this.logger.log(`Class ${classId} exists. Updating directly...`);
        const patchPayload = { ...finalClassPayload };
        const updateRes = await client.request({
          url: `${url}/${classId}`,
          method: 'PATCH',
          data: patchPayload,
        });
        return updateRes.data;
      } else {
        const res = await client.request({
          url,
          method: 'POST',
          data: finalClassPayload,
        });
        return res.data;
      }
    } catch (error: any) {
      if (error.response?.status === 409) {
        this.logger.log(
          `Class ${classId} already exists. Attempting update as fallback...`,
        );
        try {
          const patchPayload = { ...classPayload };
          const updateRes = await client.request({
            url: `${url}/${classId}`,
            method: 'PATCH',
            data: patchPayload,
          });
          return updateRes.data;
        } catch {
          return { id: classId, existing: true, updated: false };
        }
      }
      throw walletError(error, `publishing class ${classId}`);
    }
  }

  /**
   * Create-or-PATCH for a non-generic class resource (Phase 2). `createGenericClass`
   * keeps its own inline create/update/409-fallback logic for `generic` so that
   * path is byte-identical to before this refactor; every other wallet type
   * shares this simpler version instead of duplicating it per type.
   */
  private async upsertClass(
    client: any,
    classResource: string,
    classId: string,
    payload: any,
    isUpdate: boolean,
  ) {
    const url = `${WALLET_API_BASE}/${classResource}`;
    try {
      if (isUpdate) {
        const res = await client.request({
          url: `${url}/${classId}`,
          method: 'PATCH',
          data: payload,
        });
        return res.data;
      }
      const res = await client.request({ url, method: 'POST', data: payload });
      return res.data;
    } catch (error: any) {
      if (error.response?.status === 409) {
        const res = await client.request({
          url: `${url}/${classId}`,
          method: 'PATCH',
          data: payload,
        });
        return res.data;
      }
      throw walletError(error, `publishing class ${classId}`);
    }
  }

  /**
   * Patches ONLY `merchantLocations` directly on an existing Google Wallet class.
   * This bypasses full template reconstruction, logo/image fetching, and callback URL
   * safety assertions so saving locations in the dashboard is fast, robust, and works in
   * all environments (dev, preview, prod).
   */
  public async patchClassLocations(
    classSuffix: string,
    storeLocations: any[],
    walletType: WalletType = 'generic',
  ) {
    const client = await this.getGoogleAuthClient();
    const { issuerId } = this.getCredentialsOrThrow();
    const classId = this.resolveClassId(issuerId, classSuffix);
    const { classResource } = walletResources(walletType);

    const merchantLocations = (
      Array.isArray(storeLocations) ? storeLocations : []
    )
      .slice(0, 10)
      .map((l: any) => ({
        latitude: Number(l.latitude),
        longitude: Number(l.longitude),
      }));

    const url = `${WALLET_API_BASE}/${classResource}/${classId}`;
    const res = await client.request({
      url,
      method: 'PATCH',
      data: { merchantLocations },
    });
    return res.data;
  }

  /**
   * Phase 4.1 — reads a class back from Google as it actually exists there.
   *
   * The designer guesses at what it published; this is the only way to see
   * the live `merchantLocations` (geofences) and `callbackOptions.url`, which
   * is how ENV-4 (a localhost callback baked into a production class by a
   * local publish) is confirmed or ruled out. Returns null on 404.
   */
  public async getGenericClass(
    classSuffix?: string,
    walletType: WalletType = 'generic',
  ) {
    const client = await this.getGoogleAuthClient();
    const { issuerId } = this.getCredentialsOrThrow();
    const classId = this.resolveClassId(issuerId, classSuffix);
    const { classResource } = walletResources(walletType);
    try {
      const res = await client.request({
        url: `${WALLET_API_BASE}/${classResource}/${classId}`,
        method: 'GET',
      });
      return res.data as any;
    } catch (error: any) {
      if (error.response?.status === 404) return null;
      throw walletError(error, `reading class ${classId}`);
    }
  }

  public async getGenericObject(
    passId: string,
    walletType: WalletType = 'generic',
  ) {
    const client = await this.getGoogleAuthClient();
    const { objectResource } = walletResources(walletType);
    const url = `${WALLET_API_BASE}/${objectResource}/${passId}`;
    try {
      const res = await client.request({
        url,
        method: 'GET',
      });
      return res.data as any;
    } catch (error: any) {
      if (error.response?.status === 404) {
        return null;
      }
      throw walletError(error, `reading pass ${passId}`);
    }
  }

  /**
   * Invalidates / expires a pass on Google Wallet when deleted or revoked.
   * Google Wallet API does not support programmatic deletion of GenericObject
   * or GenericClass resources, so setting state to 'EXPIRED' deactivates the pass
   * and moves it out of active cards on user devices.
   */
  public async expireGenericObject(
    passId: string,
    walletType: WalletType = 'generic',
  ): Promise<boolean> {
    const client = await this.getGoogleAuthClient();
    const { objectResource } = walletResources(walletType);
    const url = `${WALLET_API_BASE}/${objectResource}/${passId}`;

    try {
      await client.request({
        url,
        method: 'PATCH',
        data: {
          state: 'EXPIRED',
        },
      });
      return true;
    } catch (error: any) {
      if (error.response?.status === 404) {
        return false;
      }
      this.logger.warn(
        `Failed to expire Google Wallet pass ${passId}: ${error?.message || error}`,
      );
      return false;
    }
  }

  public async updateGenericObject(
    passId: string,
    updateData: any,
    walletType: WalletType = 'generic',
  ) {
    const client = await this.getGoogleAuthClient();

    if (walletType === 'giftCard') {
      return this.updateGiftCardObject(client, passId, updateData);
    }
    if (walletType === 'offer') {
      return this.updateOfferObject(client, passId, updateData);
    }
    if (walletType === 'eventTicket') {
      return this.updateEventTicketObject(client, passId, updateData);
    }
    if (walletType === 'loyalty') {
      return this.updateLoyaltyObject(client, passId, updateData);
    }

    const url = `https://walletobjects.googleapis.com/walletobjects/v1/genericObject/${passId}`;

    try {
      const getRes = await client.request({
        url,
        method: 'GET',
      });
      const genericObject: any = getRes.data;

      const patchPayload: any = {
        notifyPreference: 'notifyOnUpdate',
      };

      const formattedBalance =
        updateData.balance !== undefined
          ? updateData.balance.toString().includes('Pts')
            ? updateData.balance
            : `${updateData.balance} Pts`
          : undefined;

      // WAL-6 / Phase 7.5: a resync used to push hexBackgroundColor and
      // nothing else, so a renamed field row, a new logo or a new hero image
      // never reached a pass that was already issued. `rows` rebuilds the
      // field list from the template while preserving the *live* values —
      // a design change must not reset anyone's balance or tier.
      const liveValueFor = (fieldId: string): string | undefined => {
        const existing = (genericObject.textModulesData || []).find(
          (m: any) => m.id === fieldId,
        );
        return existing?.body;
      };

      // Phase 3 — `{{token}}` columns. The token only survives in the
      // template, never in the already-rendered object body, so re-render
      // from the raw row. Reserved keys are filled by key and ignore this.
      const tokenContext: PassContext = updateData.tokenContext || {};
      const tokenBodyFor = (fieldId: string): string | undefined => {
        for (const row of updateData.templateRows || []) {
          const cols = row?.columns || [];
          for (let idx = 0; idx < cols.length; idx++) {
            const key = cols[idx].key || `${row.id}_${idx}`;
            if (key === fieldId && hasTokens(cols[idx].body)) {
              return interpolateTemplateRow(cols[idx].body, tokenContext);
            }
          }
        }
        return undefined;
      };

      if (Array.isArray(updateData.rows) && updateData.rows.length > 0) {
        patchPayload.textModulesData = [];
        updateData.rows.forEach((row: any) => {
          (row.columns || []).forEach((col: any, idx: number) => {
            const fieldId = col.key || `${row.id}_${idx}`;
            const isLiveField =
              TIER_FIELD_KEYS.includes(fieldId) ||
              POINTS_FIELD_KEYS.includes(fieldId) ||
              fieldId === MEMBER_NAME_FIELD_KEY ||
              fieldId === MEMBER_ID_FIELD_KEY;

            let body = isLiveField
              ? liveValueFor(fieldId)
              : hasTokens(col.body)
                ? interpolateTemplateRow(col.body, tokenContext)
                : col.body;
            if (TIER_FIELD_KEYS.includes(fieldId) && updateData.tier)
              body = updateData.tier;
            if (
              POINTS_FIELD_KEYS.includes(fieldId) &&
              formattedBalance !== undefined
            )
              body = formattedBalance;

            patchPayload.textModulesData.push({
              id: fieldId,
              header: col.header,
              body: body ?? col.body ?? '',
            });
          });
        });
      } else if (genericObject.textModulesData) {
        patchPayload.textModulesData = [];
        genericObject.textModulesData.forEach((mod: any) => {
          let newBody = mod.body;
          // Match on the stable key, never the display header (WAL-1).
          if (TIER_FIELD_KEYS.includes(mod.id) && updateData.tier)
            newBody = updateData.tier;
          if (
            POINTS_FIELD_KEYS.includes(mod.id) &&
            formattedBalance !== undefined
          )
            newBody = formattedBalance;
          // A custom column configured with a token re-renders every
          // transaction; without this it keeps its issuance-time value.
          const interpolated = tokenBodyFor(mod.id);
          if (interpolated !== undefined) newBody = interpolated;

          patchPayload.textModulesData.push({
            id: mod.id,
            header: mod.header,
            body: newBody,
          });
        });
      } else if (formattedBalance !== undefined || updateData.tier) {
        patchPayload.textModulesData = [];
        if (formattedBalance !== undefined) {
          patchPayload.textModulesData.push({
            id: 'balance',
            header: 'Points / Status',
            body: formattedBalance,
          });
        }
        if (updateData.tier) {
          patchPayload.textModulesData.push({
            id: 'tier_info',
            header: 'Tier Level',
            body: updateData.tier,
          });
        }
      }

      if (updateData.tier) {
        patchPayload.subheader = {
          defaultValue: {
            language: 'en-US',
            value: updateData.tier,
          },
        };
      }

      if (updateData.cardTitle) {
        patchPayload.cardTitle = {
          defaultValue: {
            language: 'en-US',
            value: updateData.cardTitle,
          },
        };
      }

      if (
        genericObject.barcode &&
        (formattedBalance !== undefined || updateData.tier)
      ) {
        const currentTier =
          updateData.tier || genericObject.subheader?.defaultValue?.value;

        let displayBalance = formattedBalance;
        if (displayBalance === undefined) {
          if (genericObject.textModulesData) {
            const balMod = genericObject.textModulesData.find((m: any) =>
              POINTS_FIELD_KEYS.includes(m.id),
            );
            if (balMod) displayBalance = balMod.body;
          }
        }

        if (currentTier !== undefined || displayBalance !== undefined) {
          const parts = [];
          if (currentTier) parts.push(currentTier);
          if (displayBalance) parts.push(displayBalance);
          patchPayload.barcode = {
            ...genericObject.barcode,
            alternateText: parts.join(' • '),
          };
        } else {
          patchPayload.barcode = {
            ...genericObject.barcode,
            alternateText: ' ',
          };
        }
      }

      if (updateData.hexBackgroundColor) {
        patchPayload.hexBackgroundColor = updateData.hexBackgroundColor;
      }

      // WAL-6 continued: logo and hero were already being *passed* by
      // syncPassAfterTransaction's tier-design swap and by the resync route —
      // they were silently dropped here. Both callers are fixed by honouring
      // them once, rather than by touching each call site.
      if (updateData.logoUrl) {
        patchPayload.logo = { sourceUri: { uri: updateData.logoUrl } };
      }
      if (updateData.heroImageUrl) {
        patchPayload.heroImage = {
          sourceUri: { uri: updateData.heroImageUrl },
        };
      }
      if (updateData.pushNotification) {
        patchPayload.messages = [
          {
            header: 'LinearCard Update',
            body: updateData.pushNotification,
            id: `msg_${Date.now()}`,
          },
        ];
      }

      const res = await client.request({
        url,
        method: 'PATCH',
        data: patchPayload,
      });
      return res.data;
    } catch (err) {
      throw walletError(err, `updating pass ${passId}`);
    }
  }

  /**
   * giftCardObject balance patch (Phase 2). `balance` is `Money`, never the
   * "X Pts" text `updateGenericObject` writes — a gift card has no points
   * concept, only a spendable rupee balance (D10, plan 4.5).
   */
  private async updateGiftCardObject(
    client: any,
    passId: string,
    updateData: any,
  ) {
    const url = `${WALLET_API_BASE}/giftCardObject/${passId}`;
    const rupees =
      updateData.balanceRupees !== undefined
        ? Number(updateData.balanceRupees)
        : updateData.balance !== undefined
          ? Number(String(updateData.balance).replace(/[^\d.-]/g, ''))
          : undefined;

    const patchPayload: any = {};
    if (rupees !== undefined && !isNaN(rupees)) {
      patchPayload.balance = {
        micros: Math.round(rupees * 1_000_000),
        currencyCode: 'INR',
      };
      patchPayload.balanceUpdateTime = new Date().toISOString();

      // Preserve the existing barcode's type/value — a PATCH carrying only
      // `alternateText` would otherwise clobber them.
      try {
        const getRes = await client.request({ url, method: 'GET' });
        const existing: any = getRes.data;
        if (existing?.barcode) {
          patchPayload.barcode = {
            ...existing.barcode,
            alternateText: `₹${rupees}`,
          };
        }
      } catch {
        // GET failing is not fatal — the balance patch below still applies.
      }
    }
    if (updateData.pushNotification) {
      patchPayload.messages = [
        {
          header: 'LinearCard Update',
          body: updateData.pushNotification,
          id: `msg_${Date.now()}`,
        },
      ];
    }

    try {
      const res = await client.request({
        url,
        method: 'PATCH',
        data: patchPayload,
      });
      return res.data;
    } catch (err) {
      throw walletError(err, `updating gift card pass ${passId}`);
    }
  }

  /**
   * offerObject redemption (Phase 3.1). `balance` reaching 0 (the only way a
   * single-use coupon is redeemed — see `rulesForPass`/`processOrderTransaction`)
   * flips `state` to `COMPLETED`. Never patches it back to `ACTIVE`.
   */
  private async updateOfferObject(
    client: any,
    passId: string,
    updateData: any,
  ) {
    const url = `${WALLET_API_BASE}/offerObject/${passId}`;
    const remaining =
      updateData.balance !== undefined
        ? Number(String(updateData.balance).replace(/[^\d.-]/g, ''))
        : undefined;

    const patchPayload: any = {};
    if (remaining !== undefined && !isNaN(remaining) && remaining <= 0) {
      patchPayload.state = 'COMPLETED';
    }
    if (updateData.pushNotification) {
      patchPayload.messages = [
        {
          header: 'LinearCard Update',
          body: updateData.pushNotification,
          id: `msg_${Date.now()}`,
        },
      ];
    }

    try {
      const res = await client.request({
        url,
        method: 'PATCH',
        data: patchPayload,
      });
      return res.data;
    } catch (err) {
      throw walletError(err, `updating offer pass ${passId}`);
    }
  }

  /**
   * eventTicketObject presentation resync (Phase 3.2). No points/tier
   * concept — `processOrderTransaction` already rejects `ticket`-kind passes
   * before this is ever reached, so this only carries push messages.
   */
  private async updateEventTicketObject(
    client: any,
    passId: string,
    updateData: any,
  ) {
    const url = `${WALLET_API_BASE}/eventTicketObject/${passId}`;
    const patchPayload: any = {};
    if (updateData.pushNotification) {
      patchPayload.messages = [
        {
          header: 'LinearCard Update',
          body: updateData.pushNotification,
          id: `msg_${Date.now()}`,
        },
      ];
    }
    try {
      const res = await client.request({
        url,
        method: 'PATCH',
        data: patchPayload,
      });
      return res.data;
    } catch (err) {
      throw walletError(err, `updating event ticket pass ${passId}`);
    }
  }

  /**
   * loyaltyObject balance/tier patch (Phase 3.3). `loyaltyPoints.balance` is
   * an `int`, never the "X Pts" text `updateGenericObject` writes for
   * generic passes.
   */
  private async updateLoyaltyObject(
    client: any,
    passId: string,
    updateData: any,
  ) {
    const url = `${WALLET_API_BASE}/loyaltyObject/${passId}`;
    const points =
      updateData.balance !== undefined
        ? Number(String(updateData.balance).replace(/[^\d.-]/g, ''))
        : undefined;

    const patchPayload: any = {};
    if (points !== undefined && !isNaN(points)) {
      patchPayload.loyaltyPoints = {
        label: 'Points',
        balance: { int: Math.round(points) },
      };
    }
    if (updateData.tier) {
      patchPayload.textModulesData = [
        { id: 'tier', header: 'Tier', body: updateData.tier },
      ];
    }
    if (updateData.pushNotification) {
      patchPayload.messages = [
        {
          header: 'LinearCard Update',
          body: updateData.pushNotification,
          id: `msg_${Date.now()}`,
        },
      ];
    }

    try {
      const res = await client.request({
        url,
        method: 'PATCH',
        data: patchPayload,
      });
      return res.data;
    } catch (err) {
      throw walletError(err, `updating loyalty pass ${passId}`);
    }
  }

  /**
   * WAL-8 / Phase 7.7 — the `savetowallet` JWT used to be signed with
   * `origins: []`, which tells Google "any page may present this link".
   * Declaring the real origins is what lets Google reject a link lifted off
   * one of our pages and replayed from somewhere else.
   *
   * Empty stays the fallback rather than a hard failure: an unconfigured
   * deployment should still issue passes, and `origins: []` is exactly the
   * behaviour it had before.
   */
  private saveLinkOrigins(): string[] {
    const configured = process.env.WALLET_SAVE_ORIGINS;
    const candidates = configured
      ? configured.split(',')
      : [
          process.env.FRONTEND_URL,
          process.env.NEXT_PUBLIC_BASE_URL,
          process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '',
        ];

    const origins = new Set<string>();
    for (const raw of candidates) {
      const value = raw?.trim();
      if (!value) continue;
      try {
        // Google wants a bare origin (scheme + host), not a full URL.
        origins.add(new URL(value).origin);
      } catch {
        // Not parseable as a URL — skip rather than signing a claim that
        // would make every save link fail validation.
      }
    }
    return [...origins];
  }

  public async createGoogleWalletPass(options: GoogleWalletPassOptions) {
    const {
      passId,
      memberName,
      cardTitle,
      balance,
      tier,
      hexBackgroundColor = DEFAULT_PASS_HEX,
      classSuffix,
      logoUrl = '',
      heroImageUrl = '',
      rows = [],
    } = options;

    // WAL-7 / Phase 7.7: these used to default to demo values — a caller
    // that forgot `memberName` issued a real pass reading "Dhyan Patel",
    // "LinearCard Platinum", "1250 Pts", and a caller that forgot
    // `classSuffix` attached it to a shared sandbox class. A missing
    // required value is a bug in the caller, and must surface as one.
    const missing = [
      !memberName && 'memberName',
      !cardTitle && 'cardTitle',
      !classSuffix && 'classSuffix',
    ].filter(Boolean);
    if (missing.length) {
      throw new ServiceError(
        'TEMPLATE_INVALID',
        `Cannot issue a pass without ${missing.join(', ')}.`,
      );
    }

    // AUTH-4: the barcode is publicly scannable, so it carries the passId and
    // never the member's phone number. The domain comes from the same origin
    // list the save link is signed against rather than a hardcoded host, so a
    // preview deployment does not mint barcodes pointing at production.
    const barcodeBase =
      this.saveLinkOrigins()[0] || 'https://linearcard.vercel.app';
    const barcodeValue = `${barcodeBase}/m/${passId}`;
    const barcodeAltText = options.barcodeAltText || passId;

    const { issuerId, clientEmail, privateKey } = this.getCredentialsOrThrow();

    if (!passId) {
      throw new Error('passId is required to generate a Google Wallet pass.');
    }

    const objectSuffix = passId;
    const fullPassId = `${issuerId}.${objectSuffix}`;
    const classId = this.resolveClassId(issuerId, classSuffix);
    const walletType = options.walletType || 'generic';

    if (walletType === 'giftCard') {
      return this.createGiftCardPass({
        ...options,
        fullPassId,
        classId,
        classSuffix,
        barcodeValue,
        barcodeAltText,
        clientEmail,
        privateKey,
      });
    }

    if (walletType === 'offer') {
      return this.createOfferPass({
        ...options,
        fullPassId,
        classId,
        classSuffix,
        barcodeValue,
        barcodeAltText,
        clientEmail,
        privateKey,
      });
    }

    if (walletType === 'eventTicket') {
      return this.createEventTicketPass({
        ...options,
        fullPassId,
        classId,
        classSuffix,
        barcodeValue,
        barcodeAltText,
        clientEmail,
        privateKey,
      });
    }

    if (walletType === 'loyalty') {
      return this.createLoyaltyPass({
        ...options,
        fullPassId,
        classId,
        classSuffix,
        barcodeValue,
        barcodeAltText,
        clientEmail,
        privateKey,
      });
    }

    const passData = {
      memberName,
      cardTitle,
      balance,
      tier,
      hexBackgroundColor,
      barcodeValue,
      barcodeAltText,
      passId: objectSuffix,
      fullPassId: fullPassId,
      createdAt: new Date().toISOString(),
    };

    const textModulesData: any[] = [];
    if (rows && rows.length > 0) {
      rows.forEach((row: any) => {
        row.columns.forEach((col: any, idx: number) => {
          const fieldId = col.key || `${row.id}_${idx}`;
          // Seed live values by the same stable key that updates match on,
          // so creation and update agree on which module holds what.
          let displayBody = col.body;
          if (TIER_FIELD_KEYS.includes(fieldId)) displayBody = tier;
          if (POINTS_FIELD_KEYS.includes(fieldId)) displayBody = balance;
          if (fieldId === MEMBER_NAME_FIELD_KEY) displayBody = memberName;
          if (fieldId === MEMBER_ID_FIELD_KEY) displayBody = passId;

          textModulesData.push({
            id: fieldId,
            header: col.header,
            body: displayBody,
          });
        });
      });
    } else {
      if (balance !== undefined) {
        textModulesData.push({
          id: 'balance',
          header: 'Points / Status',
          body: balance,
        });
      }
      if (tier !== undefined) {
        textModulesData.push({
          id: 'tier_info',
          header: 'Tier Level',
          body: tier,
        });
      }
    }

    const genericObjectPayload = {
      id: fullPassId,
      classId: classId,
      cardTitle: {
        defaultValue: {
          language: 'en-US',
          value: cardTitle || 'LinearCard',
        },
      },
      header: {
        defaultValue: {
          language: 'en-US',
          value: memberName,
        },
      },
      textModulesData,
      barcode: {
        type: 'QR_CODE',
        value: barcodeValue,
      },
      hexBackgroundColor: hexBackgroundColor || DEFAULT_PASS_HEX,
    } as any;

    if (tier) {
      genericObjectPayload.subheader = {
        defaultValue: {
          language: 'en-US',
          value: tier,
        },
      };
    }

    if (tier || balance !== undefined) {
      const parts = [];
      if (tier) parts.push(tier);
      if (balance !== undefined) parts.push(balance);
      genericObjectPayload.barcode.alternateText = parts.join(' • ');
    } else {
      // For tier-less passes, explicitly set a space so Google Wallet
      // doesn't fall back to displaying the raw barcode URL/value.
      genericObjectPayload.barcode.alternateText = ' ';
    }

    // Google Wallet ignores hexBackgroundColor if no logo is provided.
    // To match the frontend preview card's behavior, we generate a fallback initials logo.
    let finalLogoUrl = logoUrl;
    if (!finalLogoUrl) {
      const initials = (cardTitle || 'LC').substring(0, 2).toUpperCase();
      finalLogoUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(initials)}&background=f1f5f9&color=94a3b8&size=128&font-size=0.45`;
    }

    if (finalLogoUrl) {
      genericObjectPayload.logo = { sourceUri: { uri: finalLogoUrl } };
    }
    if (heroImageUrl) {
      genericObjectPayload.heroImage = { sourceUri: { uri: heroImageUrl } };
    }

    // Part 4 — same escape hatch on the object side. `classId` is protected
    // here too: an object pointing at another tenant's class is exactly the
    // cross-brand write RAW_PROTECTED_KEYS exists to stop.
    const { payload: finalObjectPayload, refused: objectRefused } = applyRaw(
      genericObjectPayload,
      options.rawObject,
    );
    if (objectRefused.length) {
      this.logger.warn(
        `rawObject tried to set protected ${objectRefused.join(', ')} on ${fullPassId} — ignored.`,
      );
    }

    const client = await this.getGoogleAuthClient();
    try {
      await client.request({
        url: 'https://walletobjects.googleapis.com/walletobjects/v1/genericObject',
        method: 'POST',
        data: finalObjectPayload,
      });
    } catch (error: any) {
      this.logger.error(
        'Failed to create generic object in Google Wallet:',
        error.response?.data || error.message,
      );

      try {
        this.logger.log(
          `Attempting to auto-create missing class ${classId}...`,
        );
        // WAL-9: a class born on this fallback path used to carry no
        // geofences at all, because no caller passes storeLocations. Look
        // them up from the template that owns this suffix instead of
        // pushing the burden onto all four call sites.
        await this.createGenericClass({
          classSuffix,
          cardTitle,
          hexBackgroundColor,
          logoUrl,
          heroImageUrl,
          rows,
          storeLocations: await this.storeLocationsForProgram(
            options.programId,
          ),
        });
        await client.request({
          url: 'https://walletobjects.googleapis.com/walletobjects/v1/genericObject',
          method: 'POST',
          data: finalObjectPayload,
        });
      } catch (retryError: any) {
        this.logger.error(
          'Failed to auto-create class and retry object creation:',
          retryError.response?.data || retryError.message,
        );

        throw walletError(
          retryError,
          `issuing pass ${passId} (class ${classId} auto-create retry also failed — verify the class id and image URLs)`,
        );
      }
    }

    const claims = {
      iss: clientEmail,
      aud: 'google',
      typ: 'savetowallet',
      iat: Math.floor(Date.now() / 1000),
      origins: this.saveLinkOrigins(),
      payload: {
        genericObjects: [
          {
            id: fullPassId,
            classId: classId,
          },
        ],
      },
    };

    const token = jwt.sign(claims, privateKey, { algorithm: 'RS256' });
    const googleWalletUrl = `https://pay.google.com/gp/v/save/${token}`;

    return {
      success: true,
      googleWalletUrl,
      passId: objectSuffix,
      fullPassId,
      token,
      passData,
    };
  }

  /**
   * giftCardObject issuance (Phase 2 gift-card builders). Kept separate from
   * `createGoogleWalletPass` because the payload shape is genuinely
   * different — `cardNumber` + `Money` balance, no `cardTitle`/`header`.
   */
  private async createGiftCardPass(
    options: GoogleWalletPassOptions & {
      fullPassId: string;
      classId: string;
      barcodeValue: string;
      barcodeAltText: string;
      clientEmail: string;
      privateKey: string;
    },
  ) {
    const {
      passId,
      balance,
      hexBackgroundColor = DEFAULT_PASS_HEX,
      cardTitle,
      logoUrl,
      heroImageUrl,
      classSuffix,
      fullPassId,
      classId,
      barcodeValue,
      barcodeAltText,
      clientEmail,
      privateKey,
      rows = [],
    } = options;

    const balanceRupees = Number(
      String(balance ?? '0').replace(/[^\d.-]/g, ''),
    );

    const objectPayload = buildGiftCardObjectPayload({
      objectId: fullPassId,
      classId,
      cardNumber: passId,
      balanceRupees: isNaN(balanceRupees) ? 0 : balanceRupees,
      barcodeValue,
      barcodeAltText,
      textModulesData: rows.flatMap((row: any) =>
        (row.columns || [])
          .filter((col: any) => col.key !== 'points' && col.key !== 'balance')
          .map((col: any, idx: number) => ({
            id: col.key || `${row.id}_${idx}`,
            header: col.header,
            body: col.body,
          })),
      ),
    });

    const client = await this.getGoogleAuthClient();
    try {
      await client.request({
        url: `${WALLET_API_BASE}/giftCardObject`,
        method: 'POST',
        data: objectPayload,
      });
    } catch {
      try {
        await this.createGenericClass(
          {
            classSuffix,
            cardTitle,
            hexBackgroundColor,
            logoUrl,
            heroImageUrl,
            storeLocations: await this.storeLocationsForProgram(
              options.programId,
            ),
          },
          'giftCard',
        );
        await client.request({
          url: `${WALLET_API_BASE}/giftCardObject`,
          method: 'POST',
          data: objectPayload,
        });
      } catch (retryError: any) {
        throw walletError(
          retryError,
          `issuing gift card pass ${passId} (class ${classId} auto-create retry also failed)`,
        );
      }
    }

    const claims = {
      iss: clientEmail,
      aud: 'google',
      typ: 'savetowallet',
      iat: Math.floor(Date.now() / 1000),
      origins: this.saveLinkOrigins(),
      payload: {
        giftCardObjects: [{ id: fullPassId, classId }],
      },
    };
    const token = jwt.sign(claims, privateKey, { algorithm: 'RS256' });

    return {
      success: true,
      googleWalletUrl: `https://pay.google.com/gp/v/save/${token}`,
      passId,
      fullPassId,
      token,
      passData: { balance, passId, fullPassId },
    };
  }

  /**
   * offerObject issuance (Phase 3.1). `state` starts `ACTIVE`; redemption
   * flips it to `COMPLETED` via `updateOfferObject` — a coupon is never
   * re-activated once spent.
   */
  private async createOfferPass(
    options: GoogleWalletPassOptions & {
      fullPassId: string;
      classId: string;
      barcodeValue: string;
      barcodeAltText: string;
      clientEmail: string;
      privateKey: string;
    },
  ) {
    const {
      passId,
      cardTitle,
      hexBackgroundColor = DEFAULT_PASS_HEX,
      classSuffix,
      fullPassId,
      classId,
      barcodeValue,
      barcodeAltText,
      clientEmail,
      privateKey,
      rows = [],
    } = options;

    const objectPayload = buildOfferObjectPayload({
      objectId: fullPassId,
      classId,
      barcodeValue,
      barcodeAltText,
      textModulesData: rows.flatMap((row: any) =>
        (row.columns || []).map((col: any, idx: number) => ({
          id: col.key || `${row.id}_${idx}`,
          header: col.header,
          body: col.body,
        })),
      ),
    });

    const client = await this.getGoogleAuthClient();
    try {
      await client.request({
        url: `${WALLET_API_BASE}/offerObject`,
        method: 'POST',
        data: objectPayload,
      });
    } catch {
      try {
        await this.createGenericClass(
          { classSuffix, cardTitle, hexBackgroundColor },
          'offer',
        );
        await client.request({
          url: `${WALLET_API_BASE}/offerObject`,
          method: 'POST',
          data: objectPayload,
        });
      } catch (retryError: any) {
        throw walletError(
          retryError,
          `issuing offer pass ${passId} (class ${classId} auto-create retry also failed)`,
        );
      }
    }

    const claims = {
      iss: clientEmail,
      aud: 'google',
      typ: 'savetowallet',
      iat: Math.floor(Date.now() / 1000),
      origins: this.saveLinkOrigins(),
      payload: { offerObjects: [{ id: fullPassId, classId }] },
    };
    const token = jwt.sign(claims, privateKey, { algorithm: 'RS256' });

    return {
      success: true,
      googleWalletUrl: `https://pay.google.com/gp/v/save/${token}`,
      passId,
      fullPassId,
      token,
      passData: { passId, fullPassId },
    };
  }

  /**
   * eventTicketObject issuance (Phase 3.2). `seatInfo` is pulled from
   * template rows keyed `seat`/`row`/`section`/`gate` — a template that
   * omits one just doesn't print that field, same as any other row.
   */
  private async createEventTicketPass(
    options: GoogleWalletPassOptions & {
      fullPassId: string;
      classId: string;
      barcodeValue: string;
      barcodeAltText: string;
      clientEmail: string;
      privateKey: string;
    },
  ) {
    const {
      passId,
      memberName,
      cardTitle,
      hexBackgroundColor = DEFAULT_PASS_HEX,
      logoUrl,
      heroImageUrl,
      classSuffix,
      fullPassId,
      classId,
      barcodeValue,
      barcodeAltText,
      clientEmail,
      privateKey,
      rows = [],
    } = options;

    const byKey = (key: string) =>
      rows
        .flatMap((row: any) => row.columns || [])
        .find((col: any) => col.key === key)?.body;

    const objectPayload = buildEventTicketObjectPayload({
      objectId: fullPassId,
      classId,
      ticketHolderName: memberName,
      seat: byKey('seat'),
      row: byKey('row'),
      section: byKey('section'),
      gate: byKey('gate'),
      barcodeValue,
      barcodeAltText,
      textModulesData: rows.flatMap((row: any) =>
        (row.columns || [])
          .filter(
            (col: any) => !['seat', 'row', 'section', 'gate'].includes(col.key),
          )
          .map((col: any, idx: number) => ({
            id: col.key || `${row.id}_${idx}`,
            header: col.header,
            body: col.body,
          })),
      ),
    });

    const client = await this.getGoogleAuthClient();
    try {
      await client.request({
        url: `${WALLET_API_BASE}/eventTicketObject`,
        method: 'POST',
        data: objectPayload,
      });
    } catch {
      try {
        await this.createGenericClass(
          {
            classSuffix,
            cardTitle,
            hexBackgroundColor,
            logoUrl,
            heroImageUrl,
            venueName: options.venueName,
            eventStartsAt: options.eventStartsAt,
            eventEndsAt: options.eventEndsAt,
          },
          'eventTicket',
        );
        await client.request({
          url: `${WALLET_API_BASE}/eventTicketObject`,
          method: 'POST',
          data: objectPayload,
        });
      } catch (retryError: any) {
        throw walletError(
          retryError,
          `issuing event ticket pass ${passId} (class ${classId} auto-create retry also failed)`,
        );
      }
    }

    const claims = {
      iss: clientEmail,
      aud: 'google',
      typ: 'savetowallet',
      iat: Math.floor(Date.now() / 1000),
      origins: this.saveLinkOrigins(),
      payload: { eventTicketObjects: [{ id: fullPassId, classId }] },
    };
    const token = jwt.sign(claims, privateKey, { algorithm: 'RS256' });

    return {
      success: true,
      googleWalletUrl: `https://pay.google.com/gp/v/save/${token}`,
      passId,
      fullPassId,
      token,
      passData: { passId, fullPassId },
    };
  }

  /**
   * loyaltyObject issuance (Phase 3.3). `accountId` is the passId (never the
   * phone number), matching the barcode/AUTH-4 rule for every other type.
   */
  private async createLoyaltyPass(
    options: GoogleWalletPassOptions & {
      fullPassId: string;
      classId: string;
      barcodeValue: string;
      barcodeAltText: string;
      clientEmail: string;
      privateKey: string;
    },
  ) {
    const {
      passId,
      memberName,
      cardTitle,
      balance,
      tier,
      hexBackgroundColor = DEFAULT_PASS_HEX,
      logoUrl,
      heroImageUrl,
      classSuffix,
      fullPassId,
      classId,
      barcodeValue,
      barcodeAltText,
      clientEmail,
      privateKey,
      rows = [],
    } = options;

    const pointsBalance = Number(
      String(balance ?? '0').replace(/[^\d.-]/g, ''),
    );

    const objectPayload = buildLoyaltyObjectPayload({
      objectId: fullPassId,
      classId,
      accountName: memberName || 'Member',
      accountId: passId,
      pointsBalance: isNaN(pointsBalance) ? 0 : pointsBalance,
      tier,
      barcodeValue,
      barcodeAltText,
      textModulesData: rows.flatMap((row: any) =>
        (row.columns || [])
          .filter(
            (col: any) =>
              !POINTS_FIELD_KEYS.includes(col.key) && col.key !== 'tier',
          )
          .map((col: any, idx: number) => ({
            id: col.key || `${row.id}_${idx}`,
            header: col.header,
            body: col.body,
          })),
      ),
    });

    const client = await this.getGoogleAuthClient();
    try {
      await client.request({
        url: `${WALLET_API_BASE}/loyaltyObject`,
        method: 'POST',
        data: objectPayload,
      });
    } catch {
      try {
        await this.createGenericClass(
          { classSuffix, cardTitle, hexBackgroundColor, logoUrl, heroImageUrl },
          'loyalty',
        );
        await client.request({
          url: `${WALLET_API_BASE}/loyaltyObject`,
          method: 'POST',
          data: objectPayload,
        });
      } catch (retryError: any) {
        throw walletError(
          retryError,
          `issuing loyalty pass ${passId} (class ${classId} auto-create retry also failed)`,
        );
      }
    }

    const claims = {
      iss: clientEmail,
      aud: 'google',
      typ: 'savetowallet',
      iat: Math.floor(Date.now() / 1000),
      origins: this.saveLinkOrigins(),
      payload: { loyaltyObjects: [{ id: fullPassId, classId }] },
    };
    const token = jwt.sign(claims, privateKey, { algorithm: 'RS256' });

    return {
      success: true,
      googleWalletUrl: `https://pay.google.com/gp/v/save/${token}`,
      passId,
      fullPassId,
      token,
      passData: { balance, tier, passId, fullPassId },
    };
  }

  /**
   * Re-mints the `savetowallet` link for a pass that already exists in Google
   * Wallet. Used when a returning member re-enrolls (AUTH-1): they get their
   * existing pass back, not a new one with a reset balance.
   */
  public buildSaveLink(
    fullPassId: string,
    classSuffix?: string,
    walletType: WalletType = 'generic',
  ) {
    const { issuerId, clientEmail, privateKey } = this.getCredentialsOrThrow();
    const { saveKey } = walletResources(walletType);
    const claims = {
      iss: clientEmail,
      aud: 'google',
      typ: 'savetowallet',
      iat: Math.floor(Date.now() / 1000),
      origins: this.saveLinkOrigins(),
      payload: {
        [saveKey]: [
          {
            id: fullPassId.includes('.')
              ? fullPassId
              : `${issuerId}.${fullPassId}`,
            classId: this.resolveClassId(issuerId, classSuffix),
          },
        ],
      },
    };
    const token = jwt.sign(claims, privateKey, { algorithm: 'RS256' });
    return {
      token,
      googleWalletUrl: `https://pay.google.com/gp/v/save/${token}`,
    };
  }

  public async verifyMarketingConsent(memberId: string): Promise<void> {
    const { data, error } = await this.supabaseService.client
      .from('ConsentLog')
      .select('consentedAt')
      .eq('memberId', memberId)
      .not('consentedAt', 'is', null)
      .limit(1)
      .single();

    if (error || !data?.consentedAt) {
      throw new ForbiddenException(
        'Member has not consented to promotional notifications.',
      );
    }

    // 2.4 — a grant on file is not enough; a later STOP overrides it.
    const { data: member } = await this.supabaseService.client
      .from('Member')
      .select('marketingOptOutAt')
      .eq('id', memberId)
      .single();

    if (member?.marketingOptOutAt) {
      throw new ForbiddenException(
        'Member has opted out of promotional notifications.',
      );
    }
  }

  /** `resolveClassId` with this instance's own issuer already applied. */
  public classIdForSuffix(classSuffix?: string): string {
    return this.resolveClassId(
      this.getCredentialsOrThrow().issuerId,
      classSuffix,
    );
  }

  /**
   * Class-level broadcast (Phase 2.3). One `addMessage` on the class reaches
   * every holder of it, instead of N calls — but it is indiscriminate: there
   * is no way to exclude an opted-out member from a class message. Callers
   * must therefore only use this when the audience is genuinely everyone.
   */
  public async sendClassMessage(
    classId: string,
    messageId: string,
    header: string,
    body: string,
    walletType: WalletType = 'generic',
  ): Promise<void> {
    const client = await this.getGoogleAuthClient();
    const { classResource } = walletResources(walletType);
    await client.request({
      url: `${WALLET_API_BASE}/${classResource}/${classId}/addMessage`,
      method: 'POST',
      data: {
        message: {
          id: messageId,
          header,
          body,
          messageType: 'TEXT_AND_NOTIFY',
        },
      },
    });
    this.logger.log(`Class message sent: ${messageId} to ${classId}`);
  }

  public async sendOfferMessage(
    resourceId: string,
    messageId: string,
    header: string,
    body: string,
    walletType: WalletType = 'generic',
  ): Promise<{ success: boolean; messageId: string; data?: any }> {
    try {
      const client = await this.getGoogleAuthClient();
      const { objectResource } = walletResources(walletType);
      const response = await client.request({
        url: `${WALLET_API_BASE}/${objectResource}/${resourceId}/addMessage`,
        method: 'POST',
        data: {
          message: {
            id: messageId,
            header,
            body,
            messageType: 'TEXT_AND_NOTIFY',
          },
        },
      });

      this.logger.log(`Message sent: ${messageId} to ${resourceId}`);

      return {
        success: true,
        messageId,
        data: response.data,
      };
    } catch (error: any) {
      throw walletError(error, `sending a message to pass ${resourceId}`);
    }
  }

  public async sendPromoMessageWithAudit(
    passId: string,
    memberId: string,
    tenantId: string,
    header: string,
    body: string,
  ): Promise<{ success: boolean; messageId: string }> {
    const messageId = `msg_${Date.now()}`;
    const { issuerId } = this.getCredentialsOrThrow();

    // Support both short ID and full ID formats
    const resourceId = passId.includes('.') ? passId : `${issuerId}.${passId}`;

    try {
      // 1. Check consent
      await this.verifyMarketingConsent(memberId);

      // 2. Send to Google Wallet. There is deliberately no 24h quota check —
      // the stub that used to sit here read as a safeguard and enforced
      // nothing (WAL-2). Removed in Phase 2.4 rather than left lying.
      await this.sendOfferMessage(resourceId, messageId, header, body);

      // 4. Log success
      await this.notifyService.logNotification({
        tenantId,
        memberId,
        type: 'promo_message',
        channel: 'wallet_push',
        status: 'sent',
        header,
        body,
      });

      return {
        success: true,
        messageId,
      };
    } catch (error: any) {
      // 5. Log failure
      await this.notifyService.logNotification({
        tenantId,
        memberId,
        type: 'promo_message',
        channel: 'wallet_push',
        status: 'failed',
        errorReason: describeError(error),
        header,
        body,
      });

      // Re-throw so controller handles it
      throw error;
    }
  }

  /**
   * Dispatches real-time Google Wallet heads-up push notifications (TEXT_AND_NOTIFY)
   * and refreshes the card visual balance. Resilient try/catch ensures downstream delivery
   * issues never roll back or crash the transaction.
   */
  public async sendTransactionNotification(
    pass: {
      id: string;
      fullPassId: string;
      memberId: string;
      tenantId: string;
      phone?: string;
      memberName?: string | null;
      /** Raw template rows, so `{{token}}` columns re-evaluate (Phase 3). */
      templateRows?: any[];
      /** The member's own enrollment answers (Phase 6). */
      customAttributes?: Record<string, string> | null;
    },
    transaction: {
      type: 'award' | 'redeem' | 'load';
      pointsChanged: number;
      newBalance: number;
      orderId?: string;
      orderAmount: number;
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tenantName: string = 'LinearCard',
    tier?: string,
    design?: {
      hexBackgroundColor?: string;
      logoUrl?: string;
      heroImageUrl?: string;
    },
    walletType: WalletType = 'generic',
    /** Gift-card programs carry money, not points, whatever their walletType. */
    isMoneyBalance = false,
  ): Promise<{
    walletPushed: boolean;
    directNotified: boolean;
    warning?: string;
  }> {
    const isAward = transaction.type === 'award';
    // Anything that is not a redemption raises the balance.
    const isCredit = transaction.type !== 'redeem';
    const orderRef = transaction.orderId ? ` #${transaction.orderId}` : '';
    // A gift-card program reads as money in both directions, even while its
    // `walletType` is still 'generic' (native types are gated — see D3).
    const isGiftCard = walletType === 'giftCard' || isMoneyBalance;

    const pushTitle = isGiftCard
      ? isCredit
        ? 'Gift card loaded! 💳'
        : 'Gift card redeemed! 💳'
      : isAward
        ? 'Points Earned! 🎉'
        : 'Points Redeemed! 💳';
    const pushBody = isGiftCard
      ? isCredit
        ? `+₹${transaction.pointsChanged} loaded${orderRef}. Balance: ₹${transaction.newBalance}.`
        : `-₹${transaction.pointsChanged} redeemed on order${orderRef}. Balance: ₹${transaction.newBalance}.`
      : isAward
        ? `+${transaction.pointsChanged} pts earned on order${orderRef}. Balance: ${transaction.newBalance} Pts.`
        : `-${transaction.pointsChanged} pts redeemed on order${orderRef}. Balance: ${transaction.newBalance} Pts.`;

    let walletPushed = false;
    const directNotified = false;
    let warning: string | undefined;

    // 1. Google Wallet Pass Visual Refresh & OS Notification
    try {
      // 1a. Update the pass object's balance and notifyPreference.
      const balanceLabel = `${transaction.newBalance}${isGiftCard ? '' : ' Pts'}`;
      await this.updateGenericObject(
        pass.fullPassId,
        {
          balance: balanceLabel,
          pushNotification: pushBody,
          ...(tier ? { tier } : {}),
          ...(design || {}),
          // Phase 3 — lets `{{token}}` columns re-render against this
          // transaction's balance/tier instead of staying at their
          // issuance-time value.
          templateRows: pass.templateRows,
          tokenContext: {
            balance: balanceLabel,
            tier,
            name: pass.memberName,
            phone: pass.phone,
            memberId: pass.id,
            custom: pass.customAttributes,
          },
        },
        walletType,
      );

      // 1b. Dispatch explicit Google Wallet system tray notification (TEXT_AND_NOTIFY)
      const messageId = `tx_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const { issuerId } = this.getCredentialsOrThrow();
      const resourceId = pass.fullPassId.includes('.')
        ? pass.fullPassId
        : `${issuerId}.${pass.fullPassId}`;

      await this.sendOfferMessage(
        resourceId,
        messageId,
        pushTitle,
        pushBody,
        walletType,
      );
      walletPushed = true;

      await this.notifyService.logNotification({
        tenantId: pass.tenantId,
        memberId: pass.memberId,
        type: isCredit ? 'points_awarded' : 'points_redeemed',
        channel: 'wallet_push',
        status: 'sent',
        header: pushTitle,
        body: pushBody,
      });
    } catch (err: any) {
      this.logger.warn(
        `Google Wallet notification warning for ${pass.fullPassId}: ${err.message}`,
      );
      warning = `Google Wallet notification sync delayed: ${err.message}`;
      await this.notifyService.logNotification({
        tenantId: pass.tenantId,
        memberId: pass.memberId,
        type: isCredit ? 'points_awarded' : 'points_redeemed',
        channel: 'wallet_push',
        status: 'failed',
        errorReason: describeError(err),
        header: pushTitle,
        body: pushBody,
      });
    }

    return { walletPushed, directNotified, warning };
  }

  /**
   * Single post-transaction sync point: recomputes tier from thresholds,
   * pushes the balance/tier to the Google Wallet object, and fires WhatsApp
   * (redemption receipt always; tier-upgrade message only on a tier change).
   * Never throws — a delivery failure on any channel is logged and swallowed
   * so it can never roll back the underlying loyalty transaction.
   */
  public async syncPassAfterTransaction(
    pass: {
      id: string;
      fullPassId: string;
      memberId: string;
      tenantId: string;
      tier?: string;
      phone?: string;
      tiers?: Tier[];
      programId?: string | null;
      memberName?: string | null;
      /** Raw template rows, so `{{token}}` columns re-evaluate (Phase 3). */
      templateRows?: any[];
      /** The member's own enrollment answers (Phase 6). */
      customAttributes?: Record<string, string> | null;
    },
    transaction: {
      type: 'award' | 'redeem' | 'load';
      pointsChanged: number;
      newBalance: number;
      orderId?: string;
      orderAmount: number;
    },
    tenantName: string = 'LinearCard',
  ): Promise<{
    walletPushed: boolean;
    directNotified: boolean;
    warning?: string;
    tier: string;
    tierChanged: boolean;
    isUpgrade?: boolean;
  }> {
    const tiers = pass.tiers || [];
    const previousTier = pass.tier || 'Standard';

    let programName: string | undefined;
    let walletType: WalletType = 'generic';
    let isMoneyBalance = false;
    if (pass.programId) {
      const { data: prog } = await this.supabaseService.client
        .from('Program')
        .select('name, walletType, kind')
        .eq('id', pass.programId)
        .maybeSingle();
      if (prog) {
        programName = prog.name;
        walletType = (prog.walletType as WalletType) || 'generic';
        isMoneyBalance = prog.kind === 'giftcard';
      }
    }
    const balanceLabel = isMoneyBalance
      ? `₹${transaction.newBalance}`
      : `${transaction.newBalance} Pts`;

    // Every Google Wallet call this method fans out to must use the pass's
    // OWN tenant credentials, not whatever instance happened to be injected.
    // Already-scoped instances (from forTenant) are reused as-is; the plain
    // injected singleton resolves the tenant's credentials here, which falls
    // back to env when the tenant has none configured — so behaviour is
    // unchanged for env-backed tenants.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let scoped: WalletService = this;
    if (!this.credentials) {
      try {
        scoped = await this.forTenant(pass.tenantId);
      } catch (err: any) {
        this.logger.warn(
          `Falling back to env wallet credentials for pass ${pass.id}: ${err.message}`,
        );
      }
    }

    // No tiers configured for this tenant: leave the pass's tier field alone.
    // computeTier([]) returns null, which would otherwise silently stomp a
    // manually-set tier (e.g. from the dashboard balance-adjust endpoint) on
    // the very next scan.
    if (tiers.length === 0) {
      const { walletPushed, directNotified, warning } =
        await scoped.sendTransactionNotification(
          pass,
          transaction,
          tenantName,
          undefined,
          undefined,
          walletType,
          isMoneyBalance,
        );

      if (pass.phone) {
        try {
          await this.whatsappService.sendRedemptionReceiptWithLog(
            pass.phone,
            balanceLabel,
            tenantName,
            {
              tenantId: pass.tenantId,
              memberId: pass.memberId,
              programName,
              programId: pass.programId,
            },
          );
        } catch (err: any) {
          this.logger.warn(
            `WhatsApp redemption receipt failed for pass ${pass.id}: ${err.message}`,
          );
        }
      }

      return {
        walletPushed,
        directNotified,
        warning,
        tier: previousTier,
        tierChanged: false,
      };
    }

    const nextTierRow = computeTier(transaction.newBalance, tiers);
    const nextTier = nextTierRow?.name ?? previousTier;
    const tierChanged = nextTier !== previousTier;

    // A tier's rank is its configured `minPoints` — higher minPoints means a
    // higher tier. Missing tiers (e.g. a manually-set tier name with no
    // matching entry) are treated as rank -1 so we never mislabel that
    // transition.
    const rankOf = (name: string): number =>
      tiers.find((t) => t.name === name)?.minPoints ?? -1;
    const isUpgrade = tierChanged && rankOf(nextTier) > rankOf(previousTier);

    // Payoff: a tier change carries its own `templateId`, so the pass design
    // (colour/logo/hero) swaps to match the new tier's template.
    let design:
      | { hexBackgroundColor?: string; logoUrl?: string; heroImageUrl?: string }
      | undefined;
    if (tierChanged && nextTierRow?.templateId) {
      try {
        const resolved = await this.resolveTenantPassDesign(
          pass.tenantId,
          nextTierRow.templateId,
          pass.programId ?? undefined,
        );
        design = {
          hexBackgroundColor: resolved.hexBackgroundColor,
          logoUrl: resolved.logoUrl,
          heroImageUrl: resolved.heroImageUrl,
        };
      } catch (err: any) {
        this.logger.warn(
          `Failed to resolve tier design for pass ${pass.id}: ${err.message}`,
        );
      }
    }

    if (tierChanged) {
      try {
        await this.supabaseService.client
          .from('Pass')
          .update({ tier: nextTier, tierId: nextTierRow?.id ?? null })
          .eq('id', pass.id);
      } catch (err: any) {
        this.logger.warn(
          `Failed to persist tier change for pass ${pass.id}: ${err.message}`,
        );
      }

      this.webhookService
        .dispatch(pass.tenantId, 'tier.changed', {
          passId: pass.id,
          memberId: pass.memberId,
          previousTier,
          tier: nextTier,
          isUpgrade,
        })
        .catch(() => {});
    }

    const { walletPushed, directNotified, warning } =
      await scoped.sendTransactionNotification(
        pass,
        transaction,
        tenantName,
        nextTier,
        design,
        walletType,
        isMoneyBalance,
      );

    if (pass.phone) {
      try {
        await this.whatsappService.sendRedemptionReceiptWithLog(
          pass.phone,
          balanceLabel,
          tenantName,
          {
            tenantId: pass.tenantId,
            memberId: pass.memberId,
            programName,
            programId: pass.programId,
          },
        );
      } catch (err: any) {
        this.logger.warn(
          `WhatsApp redemption receipt failed for pass ${pass.id}: ${err.message}`,
        );
      }

      // Only celebrate actual upgrades — a large redemption can drop a member
      // to a lower tier, and "Congratulations, you've been upgraded" would be
      // wrong (and confusing) in that case.
      if (isUpgrade) {
        try {
          await this.whatsappService.sendTierUpgradeMessage(
            pass.phone,
            nextTier,
            tenantName,
            {
              tenantId: pass.tenantId,
              memberId: pass.memberId,
              programName,
              programId: pass.programId,
            },
          );
        } catch (err: any) {
          this.logger.warn(
            `WhatsApp tier-upgrade message failed for pass ${pass.id}: ${err.message}`,
          );
        }
      }
    }

    return {
      walletPushed,
      directNotified,
      warning,
      tier: nextTier,
      tierChanged,
      isUpgrade,
    };
  }

  /**
   * Processes order-linked loyalty transactions (Award 10% or Redeem max 50% cap).
   * Validates inputs, calculates point changes, updates database balance,
   * records an immutable AuditLog entry, and pushes real-time wallet notifications.
   *
   * `load` (Phase 2) is the gift-card sell/top-up path: the amount is money
   * credited at face value, never multiplied by `earnRate`.
   */
  public async processOrderTransaction(
    passIdentifier: string,
    amountInput: number | string,
    transactionType: 'award' | 'redeem' | 'load',
    source: 'manual' | 'webhook',
    orderId?: string,
    adminId?: string,
    staffTenantId?: string,
    /**
     * Redeem exactly this many points instead of deriving them from the order
     * amount (Phase 4). Ignored on award/load. Does not bypass a zero
     * `redeemCapPercent` — those programs stay non-redeemable.
     */
    pointsToRedeem?: number,
  ): Promise<{
    success: boolean;
    pointsChanged: number;
    newBalance: number;
    discountApplied: number;
    payableAmount: number;
    orderAmount: number;
    orderId: string | null;
    passUpdateStatus: 'pushed_to_wallet' | 'sync_delayed';
    warning?: string;
    tier: string;
    tierChanged: boolean;
    isUpgrade?: boolean;
    transaction: any;
  }> {
    if (!passIdentifier) {
      throw new HttpException(
        'Pass ID is required to process transaction.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const amount = Number(amountInput);
    if (!amount || isNaN(amount) || amount <= 0) {
      throw new HttpException(
        'Order amount must be greater than ₹0.',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!['award', 'redeem', 'load'].includes(transactionType)) {
      throw new HttpException(
        "Invalid transaction type. Must be 'award', 'redeem' or 'load'.",
        HttpStatus.BAD_REQUEST,
      );
    }

    // Resolve Pass
    let pass: any = null;
    const cleanId = passIdentifier.includes('/m/')
      ? passIdentifier.split('/m/')[1]
      : passIdentifier;

    const isUUID =
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        cleanId,
      );

    if (isUUID) {
      const { data } = await this.supabaseService.client
        .from('Pass')
        .select(
          `*, Member(*), Tenant(*, PassTemplate(${PASS_TEMPLATE_RULE_FIELDS}))`,
        )
        .eq('id', cleanId)
        .single();
      pass = data;
    }

    if (!pass) {
      const fullPassId = cleanId.includes('.')
        ? cleanId
        : `${this.getCredentialsOrThrow().issuerId}.${cleanId}`;
      const { data } = await this.supabaseService.client
        .from('Pass')
        .select(
          `*, Member(*), Tenant(*, PassTemplate(${PASS_TEMPLATE_RULE_FIELDS}))`,
        )
        .eq('fullPassId', fullPassId)
        .single();
      pass = data;
    }

    if (!pass) {
      const { data } = await this.supabaseService.client
        .from('Pass')
        .select(
          `*, Member(*), Tenant(*, PassTemplate(${PASS_TEMPLATE_RULE_FIELDS}))`,
        )
        .ilike('fullPassId', `%${cleanId}%`)
        .limit(1)
        .single();
      pass = data;
    }

    if (!pass && (/^\d{8,}$/.test(cleanId) || /^\+\d+$/.test(cleanId))) {
      const { data: phonePasses } = await this.supabaseService.client
        .from('Pass')
        .select(
          `*, Member!inner(*), Tenant(*, PassTemplate(${PASS_TEMPLATE_RULE_FIELDS}))`,
        )
        .ilike('Member.phone', `%${cleanId}%`)
        .order('createdAt', { ascending: false });
      if (phonePasses && phonePasses.length > 0) {
        pass = phonePasses[0];
      }
    }

    if (!pass) {
      throw new HttpException(
        `Pass '${passIdentifier}' was not found. Please verify Pass ID or barcode.`,
        HttpStatus.NOT_FOUND,
      );
    }

    // Cross-tenant security check
    if (staffTenantId && pass.tenantId && pass.tenantId !== staffTenantId) {
      throw new HttpException(
        'Unauthorized: This pass belongs to a different store or brand.',
        HttpStatus.FORBIDDEN,
      );
    }

    // Per-program economics (WAL-4 + Phase 3.1). The Program row owns these
    // now; a program created before the migration (or a pass with no
    // program) falls back to its templates, then to the defaults.
    let activeProgramId = pass.programId;
    if (!activeProgramId && pass.Tenant?.PassTemplate) {
      const templates = Array.isArray(pass.Tenant.PassTemplate)
        ? pass.Tenant.PassTemplate
        : [pass.Tenant.PassTemplate];
      const published = templates
        .filter((t: any) => t?.status === 'published')
        .sort((a: any, b: any) =>
          String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')),
        );
      if (published.length > 0 && published[0].programId) {
        activeProgramId = published[0].programId;
      }
    }

    // The template whose `{{token}}` columns this pass renders — same
    // selection rule the economics use, so face and maths never disagree.
    const templateRows = (() => {
      const raw = pass.Tenant?.PassTemplate;
      if (!raw) return undefined;
      const templates = Array.isArray(raw) ? raw : [raw];
      const scoped = activeProgramId
        ? templates.filter((t: any) => t?.programId === activeProgramId)
        : templates;
      const published = scoped
        .filter((t: any) => t?.status === 'published')
        .sort((a: any, b: any) =>
          String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')),
        );
      return (published[0] || scoped[0])?.fieldRows ?? undefined;
    })();

    const { data: programRow } = activeProgramId
      ? await this.supabaseService.client
          .from('Program')
          .select(
            'id, kind, earnRate, redeemRate, redeemCapPercent, visitMode, rewardThreshold',
          )
          .eq('id', activeProgramId)
          .maybeSingle()
      : { data: null };

    // Ticket and student-ID programs have no points pipeline at all
    // (D9/D14) — awarding or redeeming against one is a caller mistake, not
    // a silent no-op.
    if (programRow?.kind === 'ticket' || programRow?.kind === 'studentid') {
      throw new HttpException(
        `This pass belongs to a ${programRow.kind} program, which has no loyalty points.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    // A gift card is never *earned* on — it is loaded at face value. A caller
    // that says 'award' on one means "sell/top up this card", so route it to
    // the load path rather than rejecting it (Phase 2).
    if (programRow?.kind === 'giftcard' && transactionType === 'award') {
      transactionType = 'load';
    }
    // `load` is money onto a stored-value card; nothing else has that concept.
    if (transactionType === 'load' && programRow?.kind !== 'giftcard') {
      throw new HttpException(
        'Only gift card passes can be loaded with a balance.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const rules: LoyaltyRules = rulesForPass(
      programRow,
      pass.Tenant?.PassTemplate,
      activeProgramId,
    );

    const currentBalance = Number(pass.balance) || 0;
    let pointsChanged = 0;
    let newBalance = currentBalance;
    let discountApplied = 0;
    let payableAmount = amount;

    if (transactionType === 'load') {
      // Face value: ₹500 loaded is ₹500 on the card. `earnRate` is a loyalty
      // concept and must never touch stored value.
      pointsChanged = Math.floor(amount);
      newBalance = currentBalance + pointsChanged;
      discountApplied = 0;
      payableAmount = amount;
    } else if (transactionType === 'award') {
      pointsChanged = Math.floor(amount * rules.earnRate);
      newBalance = currentBalance + pointsChanged;
      discountApplied = 0;
      payableAmount = amount;
    } else {
      if (currentBalance <= 0) {
        throw new HttpException(
          'Customer has 0 points available. Point redemption cannot be applied to this order.',
          HttpStatus.BAD_REQUEST,
        );
      }

      // A zero cap means this program's balance is a status counter, not a
      // wallet — it was never redeemable against a bill. Saying so beats the
      // "order amount too small" the maths used to produce, which sent
      // cashiers hunting for a bigger order that would never work.
      if (rules.redeemCapPercent === 0) {
        throw new HttpException(
          "This program's loyalty balance is not redeemable against a bill.",
          HttpStatus.BAD_REQUEST,
        );
      }

      if (pointsToRedeem !== undefined) {
        // Cashier named the exact points to burn (Phase 4), so the
        // amount→points formula does not apply at all.
        if (!Number.isInteger(pointsToRedeem) || pointsToRedeem <= 0) {
          throw new HttpException(
            'pointsToRedeem must be a positive whole number.',
            HttpStatus.BAD_REQUEST,
          );
        }
        if (pointsToRedeem > currentBalance) {
          throw new HttpException(
            `Customer has only ${currentBalance} points available.`,
            HttpStatus.BAD_REQUEST,
          );
        }
        pointsChanged = pointsToRedeem;
        discountApplied = Math.floor(pointsChanged * rules.redeemRate);
        // Money guard: a discount larger than the bill would hand back cash.
        if (discountApplied > amount) {
          throw new HttpException(
            `${pointsToRedeem} points is a ₹${discountApplied} discount, more than the ₹${amount} order.`,
            HttpStatus.BAD_REQUEST,
          );
        }
      } else {
        // Points redeemable = the capped share of the order, converted back to
        // points at the brand's redeem rate.
        const maxDiscount = Math.floor(amount * (rules.redeemCapPercent / 100));
        const maxDeductible = Math.floor(maxDiscount / rules.redeemRate);
        if (maxDeductible <= 0) {
          throw new HttpException(
            'Order amount is too small for point redemption.',
            HttpStatus.BAD_REQUEST,
          );
        }

        pointsChanged = Math.min(currentBalance, maxDeductible);
        discountApplied = Math.floor(pointsChanged * rules.redeemRate);
      }

      payableAmount = amount - discountApplied;
      newBalance = currentBalance - pointsChanged;
    }

    // 1. Apply the delta atomically in Postgres (WAL-5). A read-modify-write
    // loses one of two concurrent scans; this returns the authoritative
    // balance, which every downstream step (audit, wallet push, tier) uses.
    const delta = transactionType === 'redeem' ? -pointsChanged : pointsChanged;
    const { data: rpcBalance, error: dbError } =
      await this.supabaseService.client.rpc('increment_pass_balance', {
        p_pass_id: pass.id,
        p_delta: delta,
      });

    if (dbError) {
      this.logger.error(
        `Failed to update balance in database for pass ${pass.id}:`,
        dbError,
      );
      throw new HttpException(
        `Database error updating balance: ${dbError.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    if (rpcBalance !== null && rpcBalance !== undefined) {
      newBalance = Number(
        Array.isArray(rpcBalance) ? rpcBalance[0] : rpcBalance,
      );
    }

    // 2. Insert immutable AuditLog entry
    try {
      await this.auditService.record({
        tenantId: pass.tenantId,
        memberId: pass.memberId,
        passId: pass.id,
        actor: adminId || 'system',
        action: 'order_transaction',
        details: {
          transactionType,
          source,
          orderId: orderId || null,
          orderAmount: amount,
          pointsChanged,
          previousBalance: currentBalance,
          newBalance,
          discountApplied,
          payableAmount,
        },
      });
    } catch (auditErr: any) {
      this.logger.warn(
        `AuditLog insertion warning for pass ${pass.id}: ${auditErr.message}`,
      );
    }

    this.webhookService
      .dispatch(
        pass.tenantId,
        transactionType === 'redeem' ? 'points.redeemed' : 'points.awarded',
        {
          passId: pass.id,
          memberId: pass.memberId,
          pointsChanged,
          newBalance,
          orderId: orderId || null,
        },
      )
      .catch(() => {});

    // GAP-13 — a visit program with no tier ladder (stamp_card) still gets a
    // one-time "reward unlocked" moment. Fires only on the crossing, never
    // again on a later scan, and never resets/auto-redeems the balance.
    if (
      rules.rewardThreshold &&
      currentBalance < rules.rewardThreshold &&
      newBalance >= rules.rewardThreshold
    ) {
      this.webhookService
        .dispatch(pass.tenantId, 'reward.unlocked', {
          passId: pass.id,
          memberId: pass.memberId,
          threshold: rules.rewardThreshold,
          newBalance,
        })
        .catch(() => {});
      if (pass.Member?.phone && !pass.Member?.marketingOptOutAt) {
        this.whatsappService
          .sendTextWithLog(
            pass.Member.phone,
            `🎉 Reward unlocked! You've reached ${rules.rewardThreshold} — show this message to staff to claim it.`,
            {
              tenantId: pass.tenantId,
              memberId: pass.memberId,
              type: 'reward_unlocked',
            },
          )
          .catch(() => {});
      }
    }

    // 3. Recompute tier, sync Google Wallet, and dispatch WhatsApp.
    //
    // Tiers come from the pass's OWN program (PRG-1, Phase 3.3). This used to
    // take the tenant's oldest Program, which under D8 — several programs per
    // tenant — scored every transaction against whichever program happened to
    // be created first. A pass with no programId (a legacy row the backfill
    // missed) simply gets no tiers, which leaves its tier field untouched
    // rather than scoring it against a stranger's thresholds.
    const { data: tierRows } = pass.programId
      ? await this.supabaseService.client
          .from('Tier')
          .select('*')
          .eq('programId', pass.programId)
          .order('sortOrder', { ascending: true })
      : { data: [] };
    const tiers: Tier[] = tierRows || [];

    const syncResult = await this.syncPassAfterTransaction(
      {
        id: pass.id,
        fullPassId: pass.fullPassId,
        memberId: pass.memberId,
        tenantId: pass.tenantId,
        tier: pass.tier,
        phone: pass.Member?.phone,
        tiers,
        programId: pass.programId,
        memberName: pass.Member?.name,
        templateRows,
        customAttributes: pass.customAttributes,
      },
      {
        type: transactionType,
        pointsChanged,
        newBalance,
        orderId,
        orderAmount: amount,
      },
      pass.Tenant?.name,
    );

    return {
      success: true,
      pointsChanged,
      newBalance,
      discountApplied,
      payableAmount,
      orderAmount: amount,
      orderId: orderId || null,
      passUpdateStatus: syncResult.walletPushed
        ? 'pushed_to_wallet'
        : 'sync_delayed',
      warning: syncResult.warning,
      tier: syncResult.tier,
      tierChanged: syncResult.tierChanged,
      isUpgrade: syncResult.isUpgrade,
      transaction: {
        passId: pass.id,
        memberId: pass.memberId,
        memberName: pass.Member?.name || 'Member',
        action: transactionType,
        source,
        timestamp: new Date().toISOString(),
      },
    };
  }
}
