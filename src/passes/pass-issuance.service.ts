import { Injectable, Logger, Optional } from '@nestjs/common';
import * as crypto from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { WalletService } from '../wallet/wallet.service';
import { WhatsappService } from '../notification/whatsapp.service';
import { WebhookService } from '../developers/webhook.service';
import { AuditService } from '../audit/audit.service';
import { resolveImageUrl } from './passes.controller';
import { interpolateRows } from '../wallet/template-interpolator';
import type { EnrollmentField, WalletType } from '../types';

export interface IssuePassResult {
  success: boolean;
  /** True when the member already held a live pass for this program. */
  existing: boolean;
  passId: string | null;
  fullPassId?: string;
  googleWalletUrl?: string;
  token?: string;
  error?: string;
}

/**
 * The one place a Google Wallet pass is minted for a member.
 *
 * Extracted from `verify-otp` in Phase 5 because payment-triggered
 * enrollment (5.2) needs exactly the same sequence — entry tier, program
 * design, existing-pass reuse, Pass row, `member.enrolled` webhook, save
 * link over WhatsApp. Two copies of this would drift the moment one of
 * them learned about a new program kind.
 */
@Injectable()
export class PassIssuanceService {
  private readonly logger = new Logger(PassIssuanceService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly walletService: WalletService,
    private readonly whatsappService: WhatsappService,
    private readonly webhookService: WebhookService,
    /** Analytics only — optional so a caller can construct this without it. */
    @Optional() private readonly auditService?: AuditService,
  ) {}

  /** The program's lowest tier — never a hardcoded 'Bronze' that may not exist. */
  async resolveEntryTier(programId?: string | null): Promise<any | null> {
    if (!programId) return null;
    const { data } = await this.supabaseService.client
      .from('Tier')
      .select('*')
      .eq('programId', programId)
      .order('minPoints', { ascending: true })
      .limit(1)
      .maybeSingle();
    return data ?? null;
  }

  async issueForMember(input: {
    tenantId: string;
    member: {
      id: string;
      phone: string;
      name?: string | null;
      isTestAccount?: boolean;
      marketingOptOutAt?: string | null;
    };
    program?: {
      id: string;
      name?: string;
      walletType?: WalletType;
      enrollmentFields?: EnrollmentField[] | null;
    } | null;
    tenant?: { name?: string; classSuffix?: string } | null;
    /** Extra GenericObject fields (memberName, tier, balance, rows…). */
    passData?: Record<string, any>;
    /**
     * Phase 6 — the member's enrollment answers, already validated against
     * the program's `enrollmentFields` by the caller.
     */
    customAttributes?: Record<string, string>;
    /** Send the save link over WhatsApp. Off for silent/system issuance. */
    sendPassLink?: boolean;
  }): Promise<IssuePassResult> {
    const {
      tenantId,
      member,
      program,
      passData = {},
      customAttributes = {},
      sendPassLink = true,
    } = input;

    let tenant = input.tenant;
    if (!tenant) {
      const { data } = await this.supabaseService.client
        .from('Tenant')
        .select('*')
        .eq('id', tenantId)
        .single();
      tenant = data;
    }

    // Demo-status tenants may only issue to registered test members. This is
    // the one chokepoint every issuance path takes (enrollment OTP, payments
    // webhook), so the gate lives here rather than at each call site. Fails
    // OPEN on a missing/unknown status: 'demo' has to be set explicitly, so an
    // unreadable tenant row can never block a live tenant.
    /*
    // Temporarily disabled for PoC: Allow passes to be issued to any number regardless of test account status
    if ((tenant as any)?.publishStatus === 'demo') {
      let isTestAccount = member.isTestAccount;
      if (isTestAccount === undefined) {
        const { data: memberRow } = await this.supabaseService.client
          .from('Member')
          .select('isTestAccount')
          .eq('id', member.id)
          .eq('tenantId', tenantId)
          .maybeSingle();
        isTestAccount = memberRow?.isTestAccount ?? false;
      }
      if (!isTestAccount) {
        return {
          success: false,
          existing: false,
          passId: null,
          error:
            'This tenant is in demo mode: passes can only be issued to registered test accounts until approved for production.',
        };
      }
    }
    */

    const entryTier = await this.resolveEntryTier(program?.id);
    const hasTierConcept = passData.tier !== undefined || entryTier !== null;
    const startingTier = hasTierConcept
      ? passData.tier || entryTier?.name || undefined
      : undefined;
    const startingBalance = hasTierConcept
      ? passData.balance || '0 Pts'
      : undefined;
    // A gift card sold with value on it starts at that value, not at zero.
    // `passData.balance` is a display string ('500 Pts', '₹500'); the Pass
    // column is numeric, so take the number out of whatever was passed.
    const startingBalanceNumber =
      Number(String(startingBalance ?? '').replace(/[^\d.]/g, '')) || 0;

    const passDesign = await this.walletService.resolveTenantPassDesign(
      tenantId,
      entryTier?.templateId,
      program?.id,
    );
    const tenantWallet = await this.walletService.forTenant(tenantId);

    // Already holds a live pass for this program → hand back the same pass
    // (and the same balance) instead of minting a second one. Scoped to the
    // program (D8): a coffee pass must not block enrolling in the gym.
    let existingQuery = this.supabaseService.client
      .from('Pass')
      .select('*')
      .eq('memberId', member.id)
      .eq('tenantId', tenantId)
      .is('deletedAt', null);
    if (program?.id) existingQuery = existingQuery.eq('programId', program.id);
    const { data: existingPass } = await existingQuery
      .order('createdAt', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingPass?.fullPassId) {
      const { token, googleWalletUrl } = tenantWallet.buildSaveLink(
        existingPass.fullPassId,
        passDesign.classSuffix || tenant?.classSuffix,
        program?.walletType,
      );
      return {
        success: true,
        existing: true,
        googleWalletUrl,
        token,
        passId: existingPass.id,
        fullPassId: existingPass.fullPassId,
      };
    }

    const explicitPassId = crypto.randomUUID();
    const passResult = await tenantWallet.createGoogleWalletPass({
      ...passData,
      passId: explicitPassId,
      programId: passDesign.programId,
      tier: startingTier,
      balance: startingBalance,
      barcodeAltText: hasTierConcept
        ? `${startingTier} Tier • ${startingBalance}`
        : undefined,
      cardTitle: passDesign.cardTitle || tenant?.name,
      classSuffix: passDesign.classSuffix || tenant?.classSuffix,
      hexBackgroundColor: passDesign.hexBackgroundColor,
      logoUrl: resolveImageUrl(passDesign.logoUrl),
      heroImageUrl: resolveImageUrl(passDesign.heroImageUrl),
      // The template's Dynamic Field Architecture — without this the object
      // falls back to WalletService's hardcoded balance/tier_info skeleton,
      // ignoring whatever fields the designer actually configured.
      // `{{token}}`s in a custom column resolve here (Phase 3); the reserved
      // keys are filled by key downstream and ignore their configured body.
      rows: interpolateRows(passData.rows ?? passDesign.fieldRows, {
        balance: startingBalance,
        tier: startingTier,
        name: passData.memberName || member.name,
        phone: member.phone,
        memberId: explicitPassId,
        custom: customAttributes,
      }),
      walletType: program?.walletType,
    });

    let passRecordId: string | null = null;
    if (passResult.success && passResult.fullPassId) {
      const { data: insertedPass, error: passError } =
        await this.supabaseService.client
          .from('Pass')
          .insert({
            id: explicitPassId,
            memberId: member.id,
            tenantId,
            programId: program?.id ?? null,
            tierId: entryTier?.id ?? null,
            fullPassId: passResult.fullPassId,
            balance: startingBalanceNumber,
            tier: startingTier ?? null,
            customAttributes,
          })
          .select()
          .single();
      if (!passError && insertedPass) {
        passRecordId = insertedPass.id;
        this.webhookService
          .dispatch(
            tenantId,
            'member.enrolled',
            {
              passId: passRecordId,
              memberId: member.id,
              phone: member.phone,
            },
            program?.id ?? null,
          )
          .catch(() => {});

        // Analytics only — a failed write must never fail issuance.
        this.auditService
          ?.record({
            tenantId,
            memberId: member.id,
            passId: passRecordId,
            programId: program?.id ?? null,
            actor: 'system',
            action: 'pass_created',
          })
          .catch(() => {});
      }
    }

    if (sendPassLink && passResult.googleWalletUrl && passRecordId) {
      this.whatsappService
        .sendPassLinkWithLog(
          member.phone,
          this.shortPassUrl(passRecordId),
          passData.memberName || member.name || member.phone,
          passDesign.cardTitle || tenant?.name || 'LinearCard',
          {
            tenantId,
            memberId: member.id,
            programName: program?.name,
            programId: program?.id,
          },
        )
        .catch((err) =>
          this.logger.warn(`WhatsApp pass link failed (non-fatal): ${err}`),
        );
    }

    // Program-level welcome, after the save link so the pass arrives first.
    // Opt-outs are never a choice — same rule every campaign send follows.
    if (program?.id && passRecordId) {
      const { data: programRow } = await this.supabaseService.client
        .from('Program')
        .select('welcomeMessage')
        .eq('id', program.id)
        .maybeSingle();
      const welcome = (programRow?.welcomeMessage || '').trim();
      if (welcome && !member.marketingOptOutAt) {
        this.whatsappService
          .sendTextWithLog(member.phone, welcome, {
            tenantId,
            memberId: member.id,
            type: 'program_welcome',
          })
          .catch((err: any) =>
            this.logger.warn(`Welcome message failed (non-fatal): ${err}`),
          );
      }
    }

    return {
      success: !!passResult.success,
      existing: false,
      passId: passRecordId,
      ...passResult,
    };
  }

  /** Short link that redirects to a freshly signed save URL (JWTs expire in 3h). */
  shortPassUrl(passRecordId: string): string {
    const baseUrl =
      process.env.NEXT_PUBLIC_BASE_URL?.replace(/\/$/, '') ||
      (process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL.replace('-api', '')}`
        : 'http://localhost:3000');
    return `${baseUrl}/api/p/${passRecordId}`;
  }
}
