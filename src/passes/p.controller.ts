import {
  Controller,
  Get,
  Param,
  Res,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { SupabaseService } from '../supabase/supabase.service';
import { WalletService } from '../wallet/wallet.service';
import { resolveImageUrl } from './passes.controller';

@Controller('p')
export class PController {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly walletService: WalletService,
  ) {}

  @Get(':id')
  async redirectPass(@Param('id') id: string, @Res() res: Response) {
    try {
      if (!id)
        throw new HttpException('Missing pass ID', HttpStatus.BAD_REQUEST);

      const { data: pass, error } = await this.supabaseService.client
        .from('Pass')
        .select(
          '*, member:Member(*), tenant:Tenant(*), program:Program(walletType)',
        )
        .eq('id', id)
        .single();

      if (error || !pass) {
        throw new HttpException('Pass not found', HttpStatus.NOT_FOUND);
      }

      const objectSuffixOverride = pass.fullPassId.split('.').pop();
      if (!objectSuffixOverride) {
        throw new HttpException(
          'Invalid pass configuration',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      const passDesign = await this.walletService.resolveTenantPassDesign(
        pass.tenantId,
        undefined,
        pass.programId ?? undefined,
      );

      const tenantWallet = await this.walletService.forTenant(pass.tenantId);
      const passResult = await tenantWallet.createGoogleWalletPass({
        memberName: pass.member.name || pass.member.phone,
        cardTitle: passDesign.cardTitle || pass.tenant.name,
        balance: String(pass.balance),
        tier: pass.tier,
        hexBackgroundColor: passDesign.hexBackgroundColor,
        barcodeAltText: pass.barcodeAlt || undefined,
        classSuffix: passDesign.classSuffix || pass.tenant.classSuffix,
        logoUrl: resolveImageUrl(passDesign.logoUrl),
        heroImageUrl: resolveImageUrl(passDesign.heroImageUrl),
        passId: objectSuffixOverride,
        programId: pass.programId || undefined,
        rows: passDesign.fieldRows,
        walletType: pass.program?.walletType || 'generic',
      });

      if (passResult.success && passResult.googleWalletUrl) {
        return res.redirect(passResult.googleWalletUrl);
      } else {
        throw new HttpException(
          'Failed to generate pass URL',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw new HttpException(
        'Internal Server Error',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
