import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
  UseGuards,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { NotifyService } from '../notification/notify.service';
import { WalletService } from '../wallet/wallet.service';
import { TenantGuard, TenantRequest } from '../auth/tenant.guard';
import { AuditService } from '../audit/audit.service';
import { describeError } from '../errors';
import { buildMemberQuery } from './member-query';
import { computeTier } from '../tiers/tier.util';
import { MAX_ENROLLMENT_VALUE_LENGTH } from '../programs/enrollment-fields';

@Controller('members')
export class MembersController {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly notifyService: NotifyService,
    private readonly walletService: WalletService,
    private readonly auditService: AuditService,
  ) {}

  @Get()
  @UseGuards(TenantGuard)
  async getMembers(
    @Req() req: TenantRequest,
    @Query('limit') limitQuery?: string,
    @Query('offset') offsetQuery?: string,
    @Query('q') q?: string,
    @Query('dir') dir?: string,
    @Query('programId') programId?: string,
  ) {
    try {
      // Phase 6.1 (FE-3) — `total` is what lets the caller page instead of
      // fetching the whole table and slicing it client-side.
      const limit = Math.min(
        Number(limitQuery) > 0 ? Number(limitQuery) : 50,
        200,
      );
      const offset = Number(offsetQuery) >= 0 ? Number(offsetQuery) : 0;

      const {
        data: members,
        error,
        count,
      } = await buildMemberQuery(this.supabaseService.client, {
        tenantId: req.tenantId!,
        limit,
        offset,
        q,
        dir,
        programId,
      });

      if (error) {
        throw error;
      }
      return { success: true, members, total: count ?? 0, limit, offset };
    } catch {
      throw new HttpException(
        { success: false, error: 'Failed to fetch members' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get(':id')
  @UseGuards(TenantGuard)
  async getMemberById(@Param('id') id: string, @Req() req: TenantRequest) {
    try {
      const { data: member, error } = await this.supabaseService.client
        .from('Member')
        .select('*, Tenant(name)')
        .eq('id', id)
        .eq('tenantId', req.tenantId!)
        .single();
      if (error || !member)
        throw new HttpException(
          { success: false, error: 'Member not found' },
          HttpStatus.NOT_FOUND,
        );

      const [passesResult, auditLogResult, consentLogResult, paymentsResult] =
        await Promise.all([
          // The joined Program is what the dashboard shows as "programs this
          // member belongs to" — a member holds one pass per program.
          this.supabaseService.client
            .from('Pass')
            .select(
              '*, Program(id, name, kind, status, enrollmentSlug, walletType, enrollmentFields)',
            )
            .eq('memberId', id)
            .order('createdAt', { ascending: false }),
          this.supabaseService.client
            .from('AuditLog')
            .select('*')
            .eq('memberId', id)
            .order('createdAt', { ascending: false })
            .limit(50),
          this.supabaseService.client
            .from('ConsentLog')
            .select('*')
            .eq('memberId', id)
            .order('consentedAt', { ascending: false }),
          // PaymentEvent is keyed by phone, not memberId (Phase 5.1): the
          // payment arrives before the member exists. Scoped to the member's
          // own tenant so one phone number in two tenants can't leak across.
          this.supabaseService.client
            .from('PaymentEvent')
            .select('*')
            .eq('tenantId', member.tenantId)
            .eq('phone', member.phone)
            .order('occurredAt', { ascending: false })
            .limit(50),
        ]);
      let passes = passesResult.data;
      const auditLog = auditLogResult.data;
      const consentLog = consentLogResult.data;
      const payments = paymentsResult.data;

      // Check Google Wallet synchronization
      if (passes && passes.length > 0) {
        let deletedPassesCount = 0;
        const passesToKeep = [];

        for (const pass of passes) {
          if (pass.fullPassId) {
            try {
              const googlePass = await this.walletService.getGenericObject(
                pass.fullPassId,
                (pass as any).Program?.walletType || 'generic',
              );
              if (googlePass && googlePass.hasUsers === false) {
                // Pass was deleted from wallet app
                await this.supabaseService.client
                  .from('Pass')
                  .delete()
                  .eq('id', pass.id);
                deletedPassesCount++;
                continue;
              }
            } catch {
              // Ignore errors and assume pass is active if wallet API fails
            }
          }
          passesToKeep.push(pass);
        }

        if (deletedPassesCount > 0 && passesToKeep.length === 0) {
          // All passes were deleted, eliminate member completely
          await this.deleteMemberData(id);
          throw new HttpException(
            {
              success: false,
              error:
                'Member has deleted their pass from Google Wallet and was removed from the system',
            },
            HttpStatus.NOT_FOUND,
          );
        }
        passes = passesToKeep;
      }

      const formattedAuditLog = (auditLog || []).map((entry: any) => ({
        ...entry,
        ...(entry.details && typeof entry.details === 'object'
          ? entry.details
          : {}),
      }));

      return {
        success: true,
        member: {
          ...member,
          passes: passes || [],
          auditLog: formattedAuditLog,
          consentLog: consentLog || [],
          payments: payments || [],
        },
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
   * Phase 1.5 — marks a member as a test account (§1.7). While the tenant's
   * `publishStatus` is 'demo', only test accounts may be issued passes; until
   * now that flag was settable only by a direct DB edit.
   */
  @Patch(':id/test-account')
  @UseGuards(TenantGuard)
  async setTestAccount(
    @Param('id') id: string,
    @Body() body: { isTestAccount: boolean },
    @Req() req: TenantRequest,
  ) {
    try {
      if (typeof body?.isTestAccount !== 'boolean') {
        throw new HttpException(
          { success: false, error: 'isTestAccount must be a boolean' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const { data, error } = await this.supabaseService.client
        .from('Member')
        .update({ isTestAccount: body.isTestAccount })
        .eq('id', id)
        .eq('tenantId', req.tenantId)
        .select('id, isTestAccount')
        .maybeSingle();

      if (error) throw error;
      if (!data)
        throw new HttpException(
          { success: false, error: 'Member not found' },
          HttpStatus.NOT_FOUND,
        );

      await this.auditService.record({
        tenantId: req.tenantId!,
        memberId: id,
        actor: 'admin',
        action: 'test_account_updated',
        details: { isTestAccount: body.isTestAccount },
      });

      return { success: true, member: data };
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Phase 7.6 — DPDP §11 data-subject access: everything this platform holds
   * about one data principal, in one machine-readable response.
   *
   * Tenant-guarded and tenant-scoped: an operator can export their own
   * member and nobody else's. The phone number is the identifier the member
   * gave us, so it is part of the export rather than redacted out of it.
   */
  @Get(':id/export')
  @UseGuards(TenantGuard)
  async exportMemberData(@Param('id') id: string, @Req() req: TenantRequest) {
    try {
      const member = await this.memberInTenant(id, req.tenantId!);

      const [passes, auditLogs, consentLogs, notificationLogs, payments] =
        await Promise.all([
          this.rowsFor('Pass', id),
          this.rowsFor('AuditLog', id),
          this.rowsFor('ConsentLog', id),
          this.rowsFor('NotificationLog', id),
          // PaymentEvent is keyed by phone, not memberId (Phase 5.1): the
          // payment arrives before the member exists.
          this.supabaseService.client
            .from('PaymentEvent')
            .select('*')
            .eq('tenantId', req.tenantId!)
            .eq('phone', member.phone)
            .then((r) => r.data || []),
        ]);

      await this.auditService.record({
        tenantId: req.tenantId!,
        memberId: id,
        actor: 'dashboard',
        action: 'data_export',
        details: { legalBasis: 'DPDP_access_request' },
      });

      return {
        success: true,
        exportedAt: new Date().toISOString(),
        member,
        passes,
        auditLogs,
        consentLogs,
        notificationLogs,
        payments,
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
   * Phase 7.6 — DPDP §12 erasure.
   *
   * Now tenant-guarded: this route used to accept any member id from any
   * caller and hard-delete across every table, which is a cross-tenant
   * erasure primitive sitting on an unauthenticated route.
   *
   * `?mode=erase` (the DPDP default) anonymises in place and keeps the audit
   * trail; `?mode=purge` is the old hard delete, kept for a test member an
   * operator wants gone entirely. Erasure is the default because a hard
   * delete destroys the consent record that proves the erasure was lawful.
   */
  @Delete(':id')
  @UseGuards(TenantGuard)
  async deleteMember(
    @Param('id') id: string,
    @Req() req: TenantRequest,
    @Query('mode') mode?: string,
  ) {
    try {
      await this.memberInTenant(id, req.tenantId!);

      if (mode === 'purge') {
        await this.deleteMemberData(id);
        return { success: true, mode: 'purge' };
      }

      await this.eraseMemberData(id, req.tenantId!);
      return { success: true, mode: 'erase' };
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /** Loads a member, refusing one that belongs to another tenant. */
  private async memberInTenant(memberId: string, tenantId: string) {
    const { data: member } = await this.supabaseService.client
      .from('Member')
      .select('*')
      .eq('id', memberId)
      .eq('tenantId', tenantId)
      .maybeSingle();
    if (!member) {
      throw new HttpException(
        { success: false, error: 'Member not found' },
        HttpStatus.NOT_FOUND,
      );
    }
    return member;
  }

  private async rowsFor(table: string, memberId: string) {
    const { data } = await this.supabaseService.client
      .from(table)
      .select('*')
      .eq('memberId', memberId);
    return data || [];
  }

  /**
   * Anonymise rather than delete: the personal data is gone, the rows that
   * make the loyalty ledger and the audit trail add up are not. Passes are
   * soft-deleted so an erased member's card stops being updated.
   */
  private async eraseMemberData(memberId: string, tenantId: string) {
    const db = this.supabaseService.client;
    const now = new Date().toISOString();
    // Keeps the NOT NULL/unique phone column satisfied without holding a
    // real number, and stays obviously non-personal to anyone reading it.
    const tombstone = `erased-${memberId}`;

    await db
      .from('Pass')
      .update({ deletedAt: now })
      .eq('memberId', memberId)
      .is('deletedAt', null);

    const { error } = await db
      .from('Member')
      .update({
        name: 'Erased member',
        phone: tombstone,
        erasedAt: now,
        marketingOptOutAt: now,
      })
      .eq('id', memberId)
      .eq('tenantId', tenantId);
    if (error) throw error;

    await this.auditService.record({
      tenantId,
      memberId,
      actor: 'dashboard',
      action: 'data_erased',
      details: { legalBasis: 'DPDP_erasure_request' },
    });
  }

  private async deleteMemberData(memberId: string) {
    // Delete related records manually to ensure they're removed if no CASCADE is set
    await this.supabaseService.client
      .from('Pass')
      .delete()
      .eq('memberId', memberId);
    await this.supabaseService.client
      .from('AuditLog')
      .delete()
      .eq('memberId', memberId);
    await this.supabaseService.client
      .from('ConsentLog')
      .delete()
      .eq('memberId', memberId);
    await this.supabaseService.client
      .from('NotificationLog')
      .delete()
      .eq('memberId', memberId);

    const { error } = await this.supabaseService.client
      .from('Member')
      .delete()
      .eq('id', memberId);

    if (error) throw error;
  }

  @Post(':id/adjust-balance')
  @UseGuards(TenantGuard)
  async adjustBalance(
    @Param('id') memberId: string,
    @Body() body: any,
    @Req() req: TenantRequest,
  ) {
    try {
      const {
        newBalance: newBalanceRaw,
        newTier,
        note,
        passId,
        adminId,
        // GAP-1/GAP-2 — the admin pass-edit surface. `customAttributes` sets
        // per-member values for fields the template declares as `{{token}}`s
        // (role, membership_expires, …) that enrollment never asked the
        // member for. A gift-card/membership "sale" is just `newBalance`
        // here with no payment behind it, now that this route is guarded.
        customAttributes: customAttributesInput,
      } = body;
      const { data: pass, error: passError } = await this.supabaseService.client
        .from('Pass')
        .select('*, Program(walletType)')
        .eq('id', passId)
        .eq('tenantId', req.tenantId!)
        .single();
      if (passError || !pass)
        throw new HttpException(
          { success: false, error: 'Pass not found' },
          HttpStatus.BAD_REQUEST,
        );

      const changingBalance = newBalanceRaw !== undefined;
      const newBalance = changingBalance ? Number(newBalanceRaw) : pass.balance;
      if (changingBalance && (!Number.isFinite(newBalance) || newBalance < 0))
        throw new HttpException(
          { success: false, error: 'newBalance must be a non-negative number' },
          HttpStatus.BAD_REQUEST,
        );

      let finalTier = pass.tier;
      if (newTier) {
        finalTier = newTier;
      } else if (changingBalance && pass.programId) {
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

      // Only accept keys the pass's own published template actually
      // declares a `{{token}}` for — an admin can't write an arbitrary
      // field onto the pass, only the ones the design already renders.
      let templateRows: any[] | undefined;
      let finalCustomAttributes = pass.customAttributes || {};
      if (customAttributesInput && typeof customAttributesInput === 'object') {
        const { data: template } = await this.supabaseService.client
          .from('PassTemplate')
          .select('fieldRows')
          .eq('tenantId', req.tenantId!)
          .eq('programId', pass.programId)
          .eq('status', 'published')
          .order('updatedAt', { ascending: false })
          .limit(1)
          .maybeSingle();
        templateRows = template?.fieldRows ?? undefined;
        const declaredKeys = new Set(
          (templateRows || []).flatMap((row: any) =>
            row.columns.map((col: any) => col.key),
          ),
        );
        const merged = { ...finalCustomAttributes };
        for (const [key, value] of Object.entries(customAttributesInput)) {
          if (!declaredKeys.has(key)) continue;
          const text =
            value === undefined || value === null ? '' : String(value).trim();
          if (text.length > MAX_ENROLLMENT_VALUE_LENGTH)
            throw new HttpException(
              {
                success: false,
                error: `${key} must be ${MAX_ENROLLMENT_VALUE_LENGTH} characters or fewer.`,
              },
              HttpStatus.BAD_REQUEST,
            );
          merged[key] = text;
        }
        finalCustomAttributes = merged;
      }

      const { error: updateError } = await this.supabaseService.client
        .from('Pass')
        .update({
          balance: newBalance,
          tier: finalTier,
          customAttributes: finalCustomAttributes,
        })
        .eq('id', passId);
      if (updateError) throw updateError;

      await this.auditService.record({
        tenantId: req.tenantId!,
        memberId,
        passId,
        actor: adminId || 'unknown-admin',
        action: 'balance_adjusted',
        details: {
          note,
          previousBalance: pass.balance,
          newBalance,
          customAttributes: customAttributesInput,
        },
      });

      this.walletService
        .updateGenericObject(
          pass.fullPassId,
          {
            balance: String(newBalance),
            tier: finalTier,
            pushNotification: `Balance updated: ${newBalance} Pts.${note ? ` (${note})` : ''}`,
            ...(templateRows
              ? {
                  templateRows,
                  tokenContext: {
                    balance: String(newBalance),
                    tier: finalTier,
                    name: (pass as any).memberName,
                    phone: (pass as any).phone,
                    memberId: pass.id,
                    custom: finalCustomAttributes,
                  },
                }
              : {}),
          },
          (pass as any).Program?.walletType || 'generic',
        )
        .then(() =>
          this.notifyService.logNotification({
            tenantId: pass.tenantId,
            memberId,
            type: 'balance_update',
            channel: 'wallet_push',
            status: 'sent',
          }),
        )
        .catch((err) =>
          this.notifyService.logNotification({
            tenantId: pass.tenantId,
            memberId,
            type: 'balance_update',
            channel: 'wallet_push',
            status: 'failed',
            errorReason: describeError(err),
          }),
        );

      return {
        success: true,
        newBalance,
        customAttributes: finalCustomAttributes,
      };
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
