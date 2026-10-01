import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { SupabaseService } from '../supabase/supabase.service';
import { WhatsappService } from '../notification/whatsapp.service';
import {
  WalletService,
  PASS_TEMPLATE_RULE_FIELDS,
  rulesForPass,
} from '../wallet/wallet.service';
import { interpolateRows } from '../wallet/template-interpolator';
import { sanitizeEnrollmentFields } from '../programs/enrollment-fields';
import { NotifyService } from '../notification/notify.service';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../env';
import { TenantGuard, TenantRequest } from '../auth/tenant.guard';
import { AuditService } from '../audit/audit.service';
import { WebhookService } from '../developers/webhook.service';
import { describeError } from '../errors';
import { verifyWalletCallback } from '../wallet/google-jws';
import { computeTier } from '../tiers/tier.util';

/** Parses a raw body string, returning undefined rather than throwing. */
function safeJson(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function resolveImageUrl(url?: string): string | undefined {
  if (!url) return undefined;
  if (url.includes('localhost') || url.includes('127.0.0.1')) {
    return 'https://storage.googleapis.com/wallet-lab-tools-codelab-artifacts-public/pass_google_logo.jpg';
  }
  if (url.startsWith('/')) {
    const baseUrl =
      process.env.NEXT_PUBLIC_BASE_URL ||
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

@Controller('passes')
export class PassesController {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly whatsappService: WhatsappService,
    private readonly walletService: WalletService,
    private readonly notifyService: NotifyService,
    private readonly tenantGuard: TenantGuard,
    private readonly auditService: AuditService,
    private readonly webhookService: WebhookService,
  ) {}

  @Post('generate-pass')
  async postgeneratepass(@Req() req: Request, @Res() res: Response) {
    try {
      const body = req.body;

      let targetTenantId = body.tenantId;
      // Default to the first available tenant in the database if no tenant ID is explicitly provided
      if (!targetTenantId) {
        const { data: firstTenant } = await this.supabaseService.client
          .from('Tenant')
          .select('id')
          .limit(1)
          .single();
        if (firstTenant) targetTenantId = firstTenant.id;
      }

      if (!targetTenantId) {
        throw new Error('No tenant found to associate with the pass.');
      }

      const phone = body.phone || body.barcodeAltText || '0000000000';

      // 1. Find or create the Member record first
      let { data: member } = await this.supabaseService.client
        .from('Member')
        .select('*')
        .eq('phone', phone)
        .eq('tenantId', targetTenantId)
        .limit(1)
        .maybeSingle();

      // If the member does not exist in the database, create a new record for them
      if (!member) {
        // Admin Exclusivity Validation
        const { data: adminExists } = await this.supabaseService.client
          .from('Admin')
          .select('id')
          .eq('tenantId', targetTenantId)
          .eq('phone', phone)
          .maybeSingle();

        if (adminExists) {
          throw new Error('Phone number is reserved for admin use.');
        }

        const { data: newMember } = await this.supabaseService.client
          .from('Member')
          .insert({
            phone,
            name: body.memberName || 'Unknown Member',
            tenantId: targetTenantId,
          })
          .select()
          .single();
        member = newMember;
      }

      if (!member) {
        throw new Error('Failed to resolve Member record.');
      }

      // 2. Generate the definitive, explicit Pass ID (UUID)
      const explicitPassId = crypto.randomUUID();

      // 3. Fall back to the tenant's published design when the caller
      // doesn't explicitly override a field — keeps this endpoint's
      // "whatever the caller sends" flexibility while still defaulting to
      // the single source of truth instead of a stale/undefined colour.
      // Phase 3.3 — scope the design fallback to the program the caller is
      // issuing against; without it, a tenant running two programs could get
      // the other program's published design (PRG-2).
      const passDesign = await this.walletService.resolveTenantPassDesign(
        targetTenantId,
        undefined,
        body.programId,
      );

      // Demo-status tenants may only issue passes to registered test members.
      // This route mints directly rather than through PassIssuanceService, so
      // it carries its own copy of the gate in
      // `PassIssuanceService.issueForMember` — change both together.
      // Fails OPEN on a missing/unknown status: 'demo' has to be set
      // explicitly (the column defaults to 'production'), so an unreadable
      // tenant row can never silently block a live tenant's issuance.
      const { data: tenantRow } = await this.supabaseService.client
        .from('Tenant')
        .select('publishStatus')
        .eq('id', targetTenantId)
        .single();
      if (tenantRow?.publishStatus === 'demo' && !member.isTestAccount) {
        throw new Error(
          'This tenant is in demo mode: passes can only be issued to registered test accounts until approved for production.',
        );
      }

      const tenantWallet = await this.walletService.forTenant(targetTenantId);

      // 4. Create the Google Wallet Pass using the explicit Pass ID
      const result = await tenantWallet.createGoogleWalletPass({
        passId: explicitPassId,
        programId: passDesign.programId,
        memberName: body.memberName,
        cardTitle: body.cardTitle ?? passDesign.cardTitle,
        balance: body.balance ?? body.issueBalance,
        tier: body.tier ?? body.issueTier,
        hexBackgroundColor:
          body.hexBackgroundColor ?? passDesign.hexBackgroundColor,
        barcodeAltText: body.barcodeAltText, // will fallback to passId if not provided
        classSuffix: body.classSuffix ?? passDesign.classSuffix,
        logoUrl: resolveImageUrl(body.logoUrl ?? passDesign.logoUrl),
        heroImageUrl: resolveImageUrl(
          body.heroImageUrl ?? passDesign.heroImageUrl,
        ),
        rows: body.rows ?? passDesign.fieldRows,
      });

      // 4. Record the newly generated pass in the database, linked to the member and tenant
      let passRecordId = null;
      if (result.success && result.fullPassId) {
        const { data: insertedPass, error: passError } =
          await this.supabaseService.client
            .from('Pass')
            .insert({
              id: explicitPassId, // Enforcing Pass ID as the primary key
              fullPassId: result.fullPassId,
              memberId: member.id,
              tenantId: targetTenantId,
              programId: body.programId ?? null,
              balance:
                parseInt(body.balance ?? body.issueBalance ?? '0', 10) || 0,
              tier: body.tier ?? body.issueTier ?? 'Standard',
              barcodeAlt: body.barcodeAltText || explicitPassId,
            })
            .select()
            .single();

        if (passError) {
          console.error('Error inserting Pass into database:', passError);
        } else if (insertedPass) {
          passRecordId = insertedPass.id;
        }

        // 5. Trigger WhatsApp delivery if reqed
        if (body.deliverWhatsapp && body.phone && passRecordId) {
          const baseUrl =
            process.env.NEXT_PUBLIC_BASE_URL?.replace(/\/$/, '') ||
            (process.env.VERCEL_URL
              ? `https://${process.env.VERCEL_URL.replace('-api', '')}`
              : 'http://localhost:3000');
          const shortUrl = `${baseUrl}/api/p/${passRecordId}`;

          let programNameForMessage: string | undefined;
          if (body.programId) {
            const { data: p } = await this.supabaseService.client
              .from('Program')
              .select('name')
              .eq('id', body.programId)
              .maybeSingle();
            if (p) programNameForMessage = p.name;
          }

          this.whatsappService
            .sendPassLinkWithLog(
              body.phone,
              shortUrl,
              body.memberName || 'Member',
              body.cardTitle || passDesign.cardTitle || 'LinearCard',
              {
                tenantId: targetTenantId,
                memberId: member.id,
                programName: programNameForMessage,
                programId: body.programId,
              },
            )
            .catch((e) => console.error('WAHA delivery error:', e)); // Log delivery errors without failing the overall req
        }
      }

      return res.status(200).json(result);
    } catch (error: any) {
      console.error('API Error generating Google Wallet pass:', error);
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to generate pass',
      });
    }
  }

  // SEC-1: authenticated and tenant-scoped. This endpoint returns member
  // name, phone, balance and tier — unauthenticated it was a cross-brand
  // member enumeration API. Every lookup below is pinned to req.tenantId.
  @Post('validate-pass')
  @UseGuards(TenantGuard)
  async postvalidatepass(@Req() req: TenantRequest, @Res() res: Response) {
    try {
      const { passId } = req.body;
      if (!passId) {
        return res
          .status(400)
          .json({ success: false, error: 'passId is required' });
      }

      const tenantId = req.tenantId;
      if (!tenantId) {
        return res
          .status(403)
          .json({ valid: false, error: 'No tenant context on this session' });
      }

      let pass: any = null;
      // Phase 6.3 — the same columns processOrderTransaction scores with, so
      // the scanner's on-screen preview can use the real rates instead of a
      // hardcoded 10% / 50%.
      const PASS_SELECT = `*, Member!inner(*), Tenant(name, PassTemplate(${PASS_TEMPLATE_RULE_FIELDS})), Program(id, name)`;

      // 1. Phone number lookup — exact phone, this tenant only.
      if (/^\d{8,}$/.test(passId) || /^\+\d+$/.test(passId)) {
        const { data: phonePasses } = await this.supabaseService.client
          .from('Pass')
          .select(PASS_SELECT)
          .eq('tenantId', tenantId)
          .ilike('Member.phone', '%' + passId)
          .order('createdAt', { ascending: false });

        pass = phonePasses?.[0] || null;
      }

      // 2. Exact match check using fullPassId
      if (!pass) {
        const fullPassId = passId.includes('.')
          ? passId
          : `${process.env.ISSUER_ID}.${passId}`;
        const { data: exactPass } = await this.supabaseService.client
          .from('Pass')
          .select(PASS_SELECT)
          .eq('tenantId', tenantId)
          .eq('fullPassId', fullPassId)
          .maybeSingle();

        pass = exactPass;
      }

      // 3. Suffix match on the object id — still tenant-scoped.
      if (!pass) {
        const { data: fallbackPass } = await this.supabaseService.client
          .from('Pass')
          .select(PASS_SELECT)
          .eq('tenantId', tenantId)
          .ilike('fullPassId', `%.${passId}`)
          .order('createdAt', { ascending: false })
          .limit(1)
          .maybeSingle();
        pass = fallbackPass;
      }

      if (!pass) {
        return res
          .status(200)
          .json({ valid: false, error: 'Pass not found or invalid' });
      }

      const member = pass.Member;

      let activeProgramId = pass.programId;
      if (!activeProgramId && pass.Tenant?.PassTemplate) {
        // Fallback: find the programId from the most recently published template
        const templates = Array.isArray(pass.Tenant.PassTemplate)
          ? pass.Tenant.PassTemplate
          : [pass.Tenant.PassTemplate];
        const published = templates
          .filter((t: any) => t?.status === 'published')
          .sort((a: any, b: any) =>
            String(b?.updatedAt || '').localeCompare(
              String(a?.updatedAt || ''),
            ),
          );
        if (published.length > 0 && published[0].programId) {
          activeProgramId = published[0].programId;
        }
      }

      const { data: programRow } = activeProgramId
        ? await this.supabaseService.client
            .from('Program')
            .select(
              'id, name, kind, archetype, earnRate, redeemRate, redeemCapPercent, visitMode, rewardThreshold, eventStartsAt, eventEndsAt',
            )
            .eq('id', activeProgramId)
            .maybeSingle()
        : { data: null };

      // GAP-7/GAP-14 — a real event ticket is single-use and dated. Other
      // `ticket`-kind archetypes (access_pass, travel_ticket, student_id)
      // are recurring-access credentials by design and stay untouched here.
      if (programRow?.archetype === 'event_ticket') {
        if (pass.usedAt) {
          return res.status(200).json({
            valid: false,
            error: `Ticket already used at ${pass.usedAt}.`,
            usedAt: pass.usedAt,
          });
        }
        const endsAt = programRow.eventEndsAt || programRow.eventStartsAt;
        if (endsAt && new Date(endsAt).getTime() < Date.now()) {
          return res.status(200).json({
            valid: false,
            error: 'This event has ended.',
          });
        }
        // The scan IS the check-in for a single-use ticket — there is no
        // separate admit action in the scanner UI for a ticket pass.
        await this.supabaseService.client
          .from('Pass')
          .update({ usedAt: new Date().toISOString() })
          .eq('id', pass.id);
        this.auditService
          .record({
            tenantId,
            memberId: member?.id,
            passId: pass.id,
            programId: activeProgramId ?? null,
            actor: 'scan',
            action: 'ticket_checked_in',
          })
          .catch(() => {});
      }

      return res.status(200).json({
        valid: true,
        memberName: member?.name || 'Unknown Member',
        balance: (pass.balance ?? 0).toString(),
        tier: pass.tier,
        fullPassId: pass.fullPassId,
        phone: member?.phone,
        tenantName: pass.Tenant?.name || member?.Tenant?.name || null,
        programName: programRow?.name || pass.Program?.name || null,
        // A ticket pass has no points pipeline (D9/D14) — process-order
        // rejects it, so the scanner must not offer award/redeem at all.
        programKind: programRow?.kind ?? 'loyalty',
        checkedInNow: programRow?.archetype === 'event_ticket',
        rules: rulesForPass(
          programRow,
          pass.Tenant?.PassTemplate,
          activeProgramId,
        ),
      });
    } catch (error: any) {
      console.error('API Error validating pass:', error);
      return res.status(500).json({
        valid: false,
        error: `Internal Server Error: ${error.message}`,
      });
    }
  }

  @Post('update-pass')
  @UseGuards(TenantGuard)
  async postupdatepass(@Req() req: TenantRequest, @Res() res: Response) {
    try {
      const body = req.body;

      const { passId, balance, tier, pushNotification, phone, brandName } =
        body;
      if (!passId) {
        return res
          .status(400)
          .json({ success: false, error: 'passId is required' });
      }

      const authenticatedTenantId = req.tenantId;
      const authenticatedRole = req.authRole;

      const isUUID =
        /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
          passId,
        );
      let pass = null;

      // 1. Strict Match: Try matching by the explicit Pass ID (database UUID)
      if (isUUID) {
        const { data } = await this.supabaseService.client
          .from('Pass')
          .select('*, Member(*), Tenant(*), Program(walletType)')
          .eq('id', passId)
          .eq('tenantId', authenticatedTenantId!)
          .single();
        pass = data;
      }

      // 2. Legacy Fallback: Try matching by fullPassId or objectSuffix
      if (!pass) {
        const fullPassId = passId.includes('.')
          ? passId
          : `${process.env.ISSUER_ID}.${passId}`;
        const { data } = await this.supabaseService.client
          .from('Pass')
          .select('*, Member(*), Tenant(*), Program(walletType)')
          .eq('fullPassId', fullPassId)
          .eq('tenantId', authenticatedTenantId!)
          .single();
        pass = data;
      }

      if (!pass) {
        return res
          .status(404)
          .json({ success: false, error: 'Pass not found in database.' });
      }

      // Security check: retained as defense-in-depth even though the lookups
      // above already scope by tenantId — `admin` role may query cross-tenant.
      if (
        authenticatedRole !== 'admin' &&
        authenticatedTenantId &&
        pass.tenantId !== authenticatedTenantId
      ) {
        return res
          .status(403)
          .json({ success: false, error: 'Unauthorized to modify this pass' });
      }

      const newBalance = parseInt(balance, 10);

      let finalTier = tier || pass.tier;

      // Auto-promotion: only kicks in when the caller doesn't specify a tier at
      // all. The Live Activity form always sends the pass's current tier, so
      // treating "tier === pass.tier" as "not specified" silently overrode an
      // admin who deliberately resubmitted the same tier.
      if (!tier) {
        if (pass.programId) {
          const { data: tiers } = await this.supabaseService.client
            .from('Tier')
            .select('*')
            .eq('programId', pass.programId);

          if (tiers && tiers.length > 0) {
            const computedTierRow = computeTier(newBalance, tiers);
            if (computedTierRow) {
              finalTier = computedTierRow.name;
            }
          }
        }
      }

      // Duplicate check: if the balance and tier are the same, just return success early.
      if (pass.balance === newBalance && pass.tier === finalTier) {
        return res.status(200).json({
          success: true,
          updatedData: { skipped: true, reason: 'Duplicate' },
        });
      }

      // Write to DB first
      await this.supabaseService.client
        .from('Pass')
        .update({
          balance: newBalance,
          tier: finalTier,
        })
        .eq('id', pass.id);

      // Async follow-ups (Google PATCH + WAHA with logging)
      const tenantWallet = await this.walletService.forTenant(pass.tenantId);
      const walletType = pass.Program?.walletType || 'generic';
      Promise.all([
        tenantWallet
          .updateGenericObject(
            pass.fullPassId,
            {
              balance: (balance ?? 0).toString(),
              tier: finalTier,
              pushNotification,
            },
            walletType,
          )
          .then(() =>
            this.notifyService.logNotification({
              tenantId: pass.tenantId,
              memberId: pass.memberId as string,
              type: 'balance_update',
              channel: 'wallet_push',
              status: 'sent',
            }),
          )
          .catch((err) =>
            this.notifyService.logNotification({
              tenantId: pass.tenantId,
              memberId: pass.memberId as string,
              type: 'balance_update',
              channel: 'wallet_push',
              status: 'failed',
              errorReason: describeError(err),
            }),
          ),
        pass.Member?.phone || phone
          ? this.whatsappService
              .sendRedemptionReceiptWithLog(
                pass.Member?.phone || phone,
                (balance ?? 0).toString(),
                pass.Tenant?.name || brandName || 'LinearCard',
                {
                  tenantId: pass.tenantId,
                  memberId: pass.memberId,
                  programName: pass.Program?.name,
                },
              )
              .catch((err) =>
                console.error('WhatsApp receipt failed (non-fatal):', err),
              )
          : Promise.resolve(),
      ]).catch((err) => {
        console.error('Async follow-up failed (non-fatal):', err);
      });

      return res.status(200).json({ success: true, tier: finalTier });
    } catch (error: any) {
      console.error('API Error updating pass:', error);
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to update pass',
      });
    }
  }

  // SEC-3: authenticated, and the class suffix comes from a template the
  // caller's tenant owns — never from the request body, which let any caller
  // overwrite any tenant's live class design.
  @Post('create-class')
  @UseGuards(TenantGuard)
  async postcreateclass(@Req() req: TenantRequest, @Res() res: Response) {
    try {
      const body = req.body;

      const { data: template } = await this.supabaseService.client
        .from('PassTemplate')
        .select('*, tenant:Tenant(*)')
        .eq('id', body.templateId)
        .eq('tenantId', req.tenantId)
        .maybeSingle();

      if (!template) {
        return res.status(404).json({
          success: false,
          error:
            'templateId is required and must reference a template this tenant owns.',
        });
      }

      // Google Wallet strictly requires absolute URLs for images; convert relative paths
      body.logoUrl = resolveImageUrl(body.logoUrl);
      body.heroImageUrl = resolveImageUrl(body.heroImageUrl);

      const tenantWallet = await this.walletService.forTenant(req.tenantId!);
      let walletType: any = 'generic';
      if (template.programId) {
        const { data: program } = await this.supabaseService.client
          .from('Program')
          .select('walletType')
          .eq('id', template.programId)
          .eq('tenantId', req.tenantId!)
          .maybeSingle();
        walletType = program?.walletType || 'generic';
      }
      const result = await tenantWallet.createGenericClass(
        {
          ...body,
          classSuffix: template.classSuffix || template.tenant?.classSuffix,
        },
        walletType,
      );

      return res.status(200).json({ success: true, classData: result });
    } catch (error: any) {
      console.error('API Error creating Google Wallet class:', error);
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to create generic class',
      });
    }
  }

  @Get('check-class')
  async getcheckclass(@Req() req: Request, @Res() res: Response) {
    try {
      const classSuffix = req.query['classSuffix'] as string;

      if (!classSuffix) {
        return res
          .status(400)
          .json({ success: false, error: 'classSuffix is required' });
      }

      // No tenant context on this legacy diagnostic endpoint — falls back to
      // the shared env issuer (no more hardcoded literal fallback).
      const issuerId =
        process.env.GOOGLE_WALLET_ISSUER_ID || process.env.ISSUER_ID;
      if (!issuerId) {
        return res.status(500).json({
          success: false,
          error: 'Missing ISSUER_ID / GOOGLE_WALLET_ISSUER_ID in environment.',
        });
      }
      const classId = `${issuerId}.${classSuffix}`;

      const client = await this.walletService.getGoogleAuthClient();
      try {
        await client.request({
          url: `https://walletobjects.googleapis.com/walletobjects/v1/genericClass/${classId}`,
          method: 'GET',
        });
        return res.status(200).json({ success: true, exists: true });
      } catch (err: any) {
        if (err.response && err.response.status === 404) {
          return res.status(200).json({ success: true, exists: false });
        }
        throw err;
      }
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  @Post('send-promo-message')
  @UseGuards(TenantGuard)
  async postsendpromomessage(@Req() req: TenantRequest, @Res() res: Response) {
    try {
      const { passId, header, body } = req.body;

      if (!passId || !header || !body) {
        return res.status(400).json({
          success: false,
          error: 'passId, header, and body are required',
        });
      }

      const authenticatedTenantId = req.tenantId;
      const authenticatedRole = req.authRole;

      // Lookup Pass
      const isUUID =
        /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
          passId,
        );
      let pass = null;

      if (isUUID) {
        const { data } = await this.supabaseService.client
          .from('Pass')
          .select('*')
          .eq('id', passId)
          .single();
        pass = data;
      }

      if (!pass) {
        const fullPassId = passId.includes('.')
          ? passId
          : `${process.env.ISSUER_ID}.${passId}`;
        const { data } = await this.supabaseService.client
          .from('Pass')
          .select('*')
          .eq('fullPassId', fullPassId)
          .single();
        pass = data;
      }

      if (!pass) {
        return res
          .status(404)
          .json({ success: false, error: 'Pass not found in database.' });
      }

      // Security check
      if (
        authenticatedRole !== 'admin' &&
        pass.tenantId !== authenticatedTenantId
      ) {
        return res.status(403).json({
          success: false,
          error: 'Unauthorized to send message to this pass',
        });
      }

      const tenantWallet = await this.walletService.forTenant(pass.tenantId);
      const result = await tenantWallet.sendPromoMessageWithAudit(
        pass.id, // we can use pass.id or fullPassId here, service handles it
        pass.memberId,
        pass.tenantId,
        header,
        body,
      );

      return res.status(200).json({
        success: true,
        statusCode: 200,
        message: 'Promotional message sent',
        messageId: result.messageId,
      });
    } catch (error: any) {
      console.error('API Error sending promo message:', error);

      const statusCode = error.status || 500;
      return res.status(statusCode).json({
        success: false,
        statusCode,
        error: error.message || 'Failed to send promotional message',
      });
    }
  }

  @Get('scan-history')
  @UseGuards(TenantGuard)
  async getScanHistory(@Req() req: TenantRequest, @Res() res: Response) {
    try {
      const authenticatedTenantId = req.tenantId;

      const { timeFilter } = req.query; // 'today', 'this_week', 'this_month', 'last_month', 'all'

      let query = this.supabaseService.client
        .from('AuditLog')
        .select('*, Member(name, phone)')
        .eq('action', 'order_transaction')
        .eq('tenantId', authenticatedTenantId)
        .order('createdAt', { ascending: false })
        .limit(100);

      const now = new Date();
      if (timeFilter && timeFilter !== 'all') {
        let startDate: Date;
        let endDate = new Date(now);

        switch (timeFilter) {
          case 'today':
            startDate = new Date(
              now.getFullYear(),
              now.getMonth(),
              now.getDate(),
            );
            break;
          case 'this_week':
            startDate = new Date(now);
            startDate.setDate(now.getDate() - now.getDay()); // Sunday as start of week
            startDate.setHours(0, 0, 0, 0);
            break;
          case 'this_month':
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            break;
          case 'last_month':
            startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            endDate = new Date(
              now.getFullYear(),
              now.getMonth(),
              0,
              23,
              59,
              59,
              999,
            );
            break;
          default:
            startDate = null; // 'all' or unknown falls back to no filter
        }

        if (startDate) {
          query = query.gte('createdAt', startDate.toISOString());
          if (timeFilter === 'last_month') {
            query = query.lte('createdAt', endDate.toISOString());
          }
        }
      }

      const { data, error } = await query;

      if (error) {
        throw error;
      }

      return res.status(200).json({
        success: true,
        data,
      });
    } catch (error: any) {
      console.error('API Error fetching scan history:', error);
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to fetch scan history',
      });
    }
  }

  /**
   * Phase 6 — the staff correction valve for self-service enrollment.
   *
   * A member types their own seat or roll number, so a wrong (or deliberately
   * fake) value has to be fixable without re-issuing the pass and losing the
   * member's saved card. Same validation as enrollment: only keys the program
   * declared are accepted.
   */
  @Patch(':id/custom-attributes')
  @UseGuards(TenantGuard)
  async patchCustomAttributes(
    @Param('id') passId: string,
    @Body() body: { customAttributes?: Record<string, string> },
    @Req() req: TenantRequest,
  ) {
    const { data: pass } = await this.supabaseService.client
      .from('Pass')
      .select(
        '*, Member(name, phone), Program(id, walletType, enrollmentFields)',
      )
      .eq('id', passId)
      .eq('tenantId', req.tenantId!)
      .maybeSingle();

    if (!pass) {
      throw new HttpException(
        { success: false, error: 'Pass not found' },
        HttpStatus.NOT_FOUND,
      );
    }

    const declared = (pass as any).Program?.enrollmentFields;
    if (!declared?.length) {
      throw new HttpException(
        {
          success: false,
          error: 'This program captures no enrollment fields.',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const customAttributes = sanitizeEnrollmentFields(
      declared,
      body?.customAttributes,
    );

    const { error: updateError } = await this.supabaseService.client
      .from('Pass')
      .update({ customAttributes })
      .eq('id', passId)
      .eq('tenantId', req.tenantId!);
    if (updateError) {
      throw new HttpException(
        { success: false, error: updateError.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    await this.auditService.record({
      tenantId: req.tenantId!,
      memberId: pass.memberId,
      passId,
      actor: 'admin',
      action: 'custom_attributes_updated',
      details: {
        previous: pass.customAttributes ?? {},
        next: customAttributes,
      },
    });

    // Best-effort, like every other wallet push: the DB is already correct.
    const templateRows = await this.templateRowsForProgram(
      req.tenantId!,
      (pass as any).Program?.id,
    );
    if (templateRows) {
      const tenantWallet = await this.walletService.forTenant(req.tenantId!);
      tenantWallet
        .updateGenericObject(
          pass.fullPassId,
          {
            rows: interpolateRows(templateRows, {
              balance: pass.balance,
              tier: pass.tier,
              name: (pass as any).Member?.name,
              phone: (pass as any).Member?.phone,
              memberId: pass.id,
              custom: customAttributes,
            }),
            pushNotification: 'Your pass details were updated',
          },
          (pass as any).Program?.walletType || 'generic',
        )
        .catch((err) =>
          console.error('Wallet push failed (non-fatal):', describeError(err)),
        );
    }

    return { success: true, customAttributes };
  }

  /** The published template rows a program's passes render from. */
  private async templateRowsForProgram(
    tenantId: string,
    programId?: string,
  ): Promise<any[] | undefined> {
    if (!programId) return undefined;
    const { data } = await this.supabaseService.client
      .from('PassTemplate')
      .select('fieldRows')
      .eq('tenantId', tenantId)
      .eq('programId', programId)
      .eq('status', 'published')
      .order('updatedAt', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data?.fieldRows ?? undefined;
  }

  @Post('process-order')
  @UseGuards(TenantGuard)
  async postProcessOrder(@Req() req: Request, @Res() res: Response) {
    try {
      const { passId, amount, action, orderId, pointsToRedeem } = req.body;

      if (!passId) {
        return res.status(400).json({
          success: false,
          error: 'Pass ID is required to process transaction.',
        });
      }
      if (
        amount === undefined ||
        amount === null ||
        isNaN(Number(amount)) ||
        Number(amount) <= 0
      ) {
        return res.status(400).json({
          success: false,
          error: 'Order amount must be greater than ₹0.',
        });
      }
      if (!['award', 'redeem', 'load'].includes(action)) {
        return res.status(400).json({
          success: false,
          error: "Invalid action. Must be 'award', 'redeem' or 'load'.",
        });
      }

      // Admin authentication (soft — this endpoint allows unauthenticated
      // POS callers, but identifies the tenant/role when credentials exist)
      const resolved = await this.tenantGuard.resolveTenant(req);
      const authenticatedTenantId = resolved?.tenantId || null;
      const authenticatedRole = resolved?.role || null;
      let authenticatedAdminId = 'system';
      if (resolved) {
        const rawToken = req.headers['authorization']?.startsWith('Bearer ')
          ? req.headers['authorization'].substring(7)
          : null;
        if (rawToken) {
          try {
            const decoded: any = jwt.verify(rawToken, JWT_SECRET);
            authenticatedAdminId = decoded.sub || decoded.adminId || 'admin';
          } catch {
            // Not a JWT (likely an API key) — keep default admin id.
          }
        }
      }

      const staffTenantId =
        authenticatedRole === 'admin'
          ? undefined
          : authenticatedTenantId || undefined;

      const result = await this.walletService.processOrderTransaction(
        passId,
        amount,
        action,
        'manual',
        orderId,
        authenticatedAdminId,
        staffTenantId,
        pointsToRedeem === undefined || pointsToRedeem === null
          ? undefined
          : Number(pointsToRedeem),
      );

      // The WhatsApp receipt is sent by `syncPassAfterTransaction`, the single
      // post-transaction fan-out point every caller of processOrderTransaction
      // goes through. Sending one here too delivered the member two receipts.

      return res.status(200).json(result);
    } catch (error: any) {
      console.error('API Error processing order transaction:', error);
      const statusCode =
        error.status ||
        (typeof error.getStatus === 'function' ? error.getStatus() : 500);
      return res.status(statusCode).json({
        success: false,
        error: error.message || 'Failed to process order transaction',
      });
    }
  }

  @Post('webhooks/external-order')
  @UseGuards(TenantGuard)
  async postExternalOrderWebhook(
    @Req() req: TenantRequest,
    @Res() res: Response,
  ) {
    try {
      const { phone, amount, action, orderId } = req.body;
      // GAP-11: tenant comes from the caller's own API key/session, never
      // from the body — a forged tenantId can no longer move another
      // tenant's pass through this endpoint.
      const tenantId = req.tenantId;

      if (!phone) {
        return res
          .status(400)
          .json({ success: false, error: 'phone is required' });
      }
      if (
        amount === undefined ||
        amount === null ||
        isNaN(Number(amount)) ||
        Number(amount) <= 0
      ) {
        return res.status(400).json({
          success: false,
          error: 'Order amount must be greater than ₹0.',
        });
      }
      if (!['award', 'redeem', 'load'].includes(action)) {
        return res.status(400).json({
          success: false,
          error: "Action must be 'award', 'redeem' or 'load'.",
        });
      }

      // 1. Find the member and their pass using the phone and the
      // authenticated tenant.
      const { data: pass } = await this.supabaseService.client
        .from('Pass')
        .select('id, Member!inner(phone)')
        .eq('tenantId', tenantId)
        .ilike('Member.phone', '%' + phone)
        .single();

      if (!pass) {
        return res.status(404).json({
          success: false,
          error: 'No active pass found for this phone number and tenant.',
        });
      }

      // 2. Process the transaction
      const result = await this.walletService.processOrderTransaction(
        pass.id,
        amount,
        action,
        'webhook',
        orderId,
        'pos-external',
        tenantId,
      );

      // 3. The WhatsApp receipt is sent by `syncPassAfterTransaction` inside
      // processOrderTransaction — the one fan-out point every caller shares.

      return res.status(200).json(result);
    } catch (error: any) {
      console.error('API Error processing external POS webhook:', error);
      const statusCode =
        error.status ||
        (typeof error.getStatus === 'function' ? error.getStatus() : 500);
      return res.status(statusCode).json({
        success: false,
        error: error.message || 'Failed to process external POS webhook',
      });
    }
  }

  /**
   * Phase 7.2 — the callback is now verified end to end against Google's
   * published root signing keys (ECv2SigningOnly), replacing the Phase 0.3
   * shared-secret stopgap. An unverifiable callback is rejected outright,
   * so a forged `del` can no longer soft-delete a pass and a forged `save`
   * can no longer fire WhatsApp at a real member (SEC-2).
   *
   * The `:secret?` segment is kept only so the URLs already published into
   * live Google Wallet classes keep resolving; it no longer authorises
   * anything.
   */
  @Post('webhooks/google-wallet/:secret?')
  async postGoogleWalletWebhook(@Req() req: Request, @Res() res: Response) {
    try {
      const envelope =
        typeof req.body === 'string' ? safeJson(req.body) : req.body;
      const raw = envelope?.signedMessage;
      if (!raw) {
        return res.status(400).send('Missing signedMessage');
      }

      let decoded: any;
      try {
        decoded = await verifyWalletCallback(
          envelope,
          process.env.ISSUER_ID || process.env.GOOGLE_ISSUER_ID || '',
        );
      } catch (sigErr: any) {
        // 401, deliberately — a rejected callback is not something Google
        // should retry, and a 200 here would hide a forgery attempt behind
        // a success in the logs.
        console.warn(
          `Rejected unverified Google Wallet callback: ${sigErr.message}`,
        );
        return res.status(401).send('Signature verification failed');
      }

      const { classId, objectId, eventType, nonce } = decoded || {};
      const typeStr = (eventType || '').toLowerCase();

      if (!objectId) {
        return res.status(400).send('Missing objectId');
      }

      // Look up the pass by fullPassId (objectId in Google Wallet)
      const { data: pass } = await this.supabaseService.client
        .from('Pass')
        .select('*, Member(*), Tenant(*), Program(*)')
        .eq('fullPassId', objectId)
        .single();

      if (!pass) {
        // No tenant/member to attribute this to — a NotificationLog insert
        // here could never succeed (tenantId/memberId are NOT NULL FKs), so
        // this is surfaced in the server log instead.
        console.warn(
          `Google Wallet callback for unrecognized objectId: ${objectId} (eventType=${eventType}, classId=${classId})`,
        );
        return res.status(200).send('Unknown objectId');
      }

      if (typeStr === 'del') {
        // No secret gate any more: the signature above is the authorisation.
        await this.supabaseService.client
          .from('Pass')
          .update({ deletedAt: new Date().toISOString() })
          .eq('id', pass.id);

        try {
          await this.auditService.record({
            tenantId: pass.tenantId,
            memberId: pass.memberId,
            passId: pass.id,
            programId: pass.programId ?? null,
            actor: 'google-wallet-webhook',
            action: 'pass_deleted',
            details: { objectId, classId, nonce },
          });
        } catch (auditErr: any) {
          console.error(
            `AuditLog insertion warning for pass ${pass.id}:`,
            auditErr.message,
          );
        }

        this.webhookService
          .dispatch(
            pass.tenantId,
            'pass.deleted',
            {
              passId: pass.id,
              objectId,
              memberId: pass.memberId,
            },
            pass.programId ?? null,
          )
          .catch(() => {});

        return res.status(200).send('OK');
      }

      // Process only save events ('save', 'SAVE', or sometimes 'add'/'ADD')
      if (typeStr !== 'save' && typeStr !== 'add') {
        await this.notifyService.logNotification({
          tenantId: pass.tenantId,
          memberId: pass.memberId,
          type: 'wallet_callback',
          channel: 'google_wallet',
          status: 'failed',
          errorReason: `Unhandled eventType: ${eventType}`,
        });
        return res.status(200).send('Ignored event type');
      }

      // A pass removed from the wallet and re-added via the same link must
      // come back out of the soft-deleted state the 'del' branch put it in.
      if (pass.deletedAt) {
        await this.supabaseService.client
          .from('Pass')
          .update({ deletedAt: null })
          .eq('id', pass.id);
      }

      // First install wins: this is the timestamp the Overview tab counts, and
      // re-adding a removed pass must not move it.
      if (!pass.installedAt) {
        await this.supabaseService.client
          .from('Pass')
          .update({ installedAt: new Date().toISOString() })
          .eq('id', pass.id);
      }

      this.auditService
        .record({
          tenantId: pass.tenantId,
          memberId: pass.memberId,
          passId: pass.id,
          programId: pass.programId ?? null,
          actor: 'google-wallet-webhook',
          action: 'pass_installed',
        })
        .catch(() => {});

      if (pass.Member?.phone) {
        await this.whatsappService
          .sendWalletSaveConfirmationWithLog(
            pass.Member.phone,
            pass.Tenant?.name || 'LinearCard',
            {
              tenantId: pass.tenantId,
              memberId: pass.memberId,
              programName: pass.Program?.name,
            },
          )
          .catch((err) =>
            console.error(
              'WhatsApp save confirmation failed (non-fatal):',
              err,
            ),
          );
      }

      this.webhookService
        .dispatch(
          pass.tenantId,
          'pass.installed',
          {
            passId: pass.id,
            objectId,
            memberId: pass.memberId,
          },
          pass.programId ?? null,
        )
        .catch(() => {});

      return res.status(200).send('OK');
    } catch (error: any) {
      console.error('API Error processing google wallet webhook:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
  }
}
