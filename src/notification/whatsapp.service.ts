import { Injectable, Logger } from '@nestjs/common';
import { NotifyService } from './notify.service';
import { WhatsappProvider, WahaProvider } from './whatsapp.provider';
import { describeError } from '../errors';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  /**
   * D6/Phase 2.6: every outbound message goes through one provider
   * interface. WAHA is the default implementation; a Cloud API provider
   * swaps in here and nowhere else.
   */
  private readonly provider: WhatsappProvider = new WahaProvider();

  constructor(
    private readonly notifyService: NotifyService,
    private readonly supabaseService: SupabaseService,
  ) {}

  private async resolveTemplate(
    templateKey: string,
    defaultMessage: string,
    programId?: string | null,
  ): Promise<string> {
    if (!programId) return defaultMessage;
    const { data } = await this.supabaseService.client
      .from('Program')
      .select('whatsappTemplates')
      .eq('id', programId)
      .maybeSingle();

    if (data?.whatsappTemplates && data.whatsappTemplates[templateKey]) {
      return data.whatsappTemplates[templateKey];
    }
    return defaultMessage;
  }

  private fillTemplate(
    template: string,
    vars: Record<string, string | undefined>,
  ): string {
    return template.replace(/{{(\w+)}}/g, (_, key) => vars[key] || '');
  }

  /**
   * Helper to execute background tasks with a soft timeout.
   * If the provider takes too long (e.g. WAHA queuing), we return early
   * so the caller doesn't timeout the HTTP request.
   */
  private async executeWithSoftTimeout<T>(
    promiseFactory: () => Promise<T>,
    timeoutMs: number,
    description: string,
  ): Promise<T | void> {
    let hasReturned = false;

    const backgroundPromise = promiseFactory().then(
      (res) => {
        if (hasReturned) {
          this.logger.debug(`[${description}] Completed in background.`);
        }
        return res;
      },
      (err) => {
        if (hasReturned) {
          this.logger.error(
            `[${description}] Failed in background: ${err.message}`,
          );
        } else {
          throw err;
        }
      },
    );

    const timeoutPromise = new Promise<string>((resolve) =>
      setTimeout(() => resolve('TIMEOUT_SYMBOL'), timeoutMs),
    );

    const result = await Promise.race([backgroundPromise, timeoutPromise]);

    if (result === 'TIMEOUT_SYMBOL') {
      hasReturned = true;
      this.logger.warn(
        `[${description}] Exceeded ${timeoutMs}ms, proceeding in background...`,
      );
      return;
    }

    hasReturned = true;
    return result as T;
  }

  /**
   * Send-and-log, used by every message type below and by campaigns. Logging
   * both outcomes is the whole reason callers don't talk to the provider
   * directly.
   */
  public async sendTextWithLog(
    phone: string,
    text: string,
    opts: {
      tenantId: string;
      memberId?: string;
      type: string;
      campaignId?: string;
      header?: string;
    },
  ): Promise<void> {
    return this.executeWithSoftTimeout(
      async () => {
        try {
          await this.provider.sendText(phone, text);
          await this.notifyService.logNotification({
            tenantId: opts.tenantId,
            memberId: opts.memberId,
            type: opts.type,
            channel: 'whatsapp',
            status: 'sent',
            campaignId: opts.campaignId,
            header: opts.header,
            body: text,
          });
        } catch (err: any) {
          await this.notifyService.logNotification({
            tenantId: opts.tenantId,
            memberId: opts.memberId,
            type: opts.type,
            channel: 'whatsapp',
            status: 'failed',
            errorReason: describeError(err),
            campaignId: opts.campaignId,
            header: opts.header,
            body: text,
          });
          throw err;
        }
      },
      8000,
      `sendTextWithLog to ${phone}`,
    );
  }

  /** Unlogged send. Campaigns and one-offs that log themselves use this. */
  public async sendText(phone: string, text: string): Promise<any> {
    return this.executeWithSoftTimeout(
      () => this.provider.sendText(phone, text),
      8000,
      `sendText to ${phone}`,
    );
  }

  public async sendOtp(
    phone: string,
    otp: string,
    brandName?: string,
    programName?: string,
    programId?: string,
  ) {
    const brand = brandName || 'LinearCard';
    const identifier = programName ? `${brand} ${programName}` : brand;
    this.logger.log(`[DEV OTP] Target: ${phone} | Code: ${otp}`);

    const defaultTemplate = `🔐 Your {{tenant}} login code is: *{{code}}*\n\nThis code expires in 5 minutes. Do not share it with anyone.`;
    const template = await this.resolveTemplate(
      'otp',
      defaultTemplate,
      programId,
    );
    const message = this.fillTemplate(template, {
      tenant: identifier,
      code: otp,
    });

    return this.executeWithSoftTimeout(
      () => this.provider.sendText(phone, message),
      8000,
      `sendOtp to ${phone}`,
    );
  }

  public async sendPassLink(
    phone: string,
    walletUrl: string,
    memberName: string,
    brandName: string,
    programName?: string,
    programId?: string,
  ) {
    const itemName = programName ? programName.toLowerCase() : 'pass';
    const defaultTemplate = `Welcome to the {{programName}}! We are thrilled to have you onboard.\n\nTap to add it to Google Wallet:\n{{walletUrl}}\n\n_Powered by LinearCard_`;
    const template = await this.resolveTemplate(
      'welcome',
      defaultTemplate,
      programId,
    );
    const message = this.fillTemplate(template, {
      memberName,
      tenant: brandName,
      programName: itemName,
      walletUrl,
    });

    return this.executeWithSoftTimeout(
      () => this.provider.sendText(phone, message),
      8000,
      `sendPassLink to ${phone}`,
    );
  }

  public async sendRedemptionReceipt(
    phone: string,
    newBalance: string,
    brandName: string,
    programName?: string,
    programId?: string,
  ) {
    const itemName = programName ? programName.toLowerCase() : 'pass';
    const defaultTemplate = `✅ *Transaction Confirmed*\n\nYour *{{tenant}}* balance has been updated.\n\nNew Balance: *{{balance}}*\n\n_Your {{programName}} will refresh automatically._`;
    const template = await this.resolveTemplate(
      'receipt',
      defaultTemplate,
      programId,
    );
    const message = this.fillTemplate(template, {
      tenant: brandName,
      balance: newBalance,
      programName: itemName,
    });

    return this.executeWithSoftTimeout(
      () => this.provider.sendText(phone, message),
      8000,
      `sendRedemptionReceipt to ${phone}`,
    );
  }

  // Logged wrappers
  public async sendPassLinkWithLog(
    phone: string,
    walletUrl: string,
    memberName: string,
    brandName: string,
    opts: {
      tenantId: string;
      memberId?: string;
      programName?: string;
      programId?: string;
    },
  ): Promise<void> {
    const itemName = opts.programName ? opts.programName.toLowerCase() : 'pass';
    const defaultTemplate = `Welcome to the {{programName}}! We are thrilled to have you onboard.\n\nTap to add it to Google Wallet:\n{{walletUrl}}\n\n_Powered by LinearCard_`;
    const template = await this.resolveTemplate(
      'welcome',
      defaultTemplate,
      opts.programId,
    );
    const message = this.fillTemplate(template, {
      memberName,
      tenant: brandName,
      programName: itemName,
      walletUrl,
    });

    return this.sendTextWithLog(phone, message, { ...opts, type: 'pass_link' });
  }

  public async sendRedemptionReceiptWithLog(
    phone: string,
    newBalance: string,
    brandName: string,
    opts: {
      tenantId: string;
      memberId?: string;
      programName?: string;
      programId?: string;
    },
  ): Promise<void> {
    const itemName = opts.programName ? opts.programName.toLowerCase() : 'pass';
    const defaultTemplate = `🛒 *Transaction Confirmed*\n\nYour *{{tenant}}* balance has been updated.\n\nNew Balance: *{{balance}}*\n\n_Your {{programName}} will refresh automatically._`;
    const template = await this.resolveTemplate(
      'receipt',
      defaultTemplate,
      opts.programId,
    );
    const message = this.fillTemplate(template, {
      tenant: brandName,
      balance: newBalance,
      programName: itemName,
    });

    return this.sendTextWithLog(phone, message, { ...opts, type: 'receipt' });
  }

  public async sendWalletSaveConfirmationWithLog(
    phone: string,
    brandName: string,
    opts: {
      tenantId: string;
      memberId?: string;
      programName?: string;
      programId?: string;
    },
  ): Promise<void> {
    const itemName = opts.programName ? opts.programName.toLowerCase() : 'pass';
    const defaultTemplate = `🎉 Success! Your *{{tenant}}* {{programName}} has been securely saved to your Google Wallet. You can now access it anytime from your phone.`;
    const template = await this.resolveTemplate(
      'walletSave',
      defaultTemplate,
      opts.programId,
    );
    const message = this.fillTemplate(template, {
      tenant: brandName,
      programName: itemName,
    });

    return this.sendTextWithLog(phone, message, {
      ...opts,
      type: 'wallet_save_confirmation',
    });
  }

  public async sendTierUpgradeMessage(
    phone: string,
    tierName: string,
    brandName: string,
    opts: {
      tenantId: string;
      memberId?: string;
      programName?: string;
      programId?: string;
    },
  ): Promise<void> {
    const itemName = opts.programName ? opts.programName.toLowerCase() : 'pass';
    const defaultTemplate = `🏆 Congratulations! You've been upgraded to *{{tierName}}* tier on your *{{tenant}}* {{programName}}. Enjoy your new perks!`;
    const template = await this.resolveTemplate(
      'tierUpgrade',
      defaultTemplate,
      opts.programId,
    );
    const message = this.fillTemplate(template, {
      tierName,
      tenant: brandName,
      programName: itemName,
    });

    return this.sendTextWithLog(phone, message, {
      ...opts,
      type: 'tier_upgrade',
    });
  }
}
