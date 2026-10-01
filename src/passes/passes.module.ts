import { Module } from '@nestjs/common';
import { PassesController } from './passes.controller';
import { PassIssuanceService } from './pass-issuance.service';
import { PController } from './p.controller';
import { SupabaseModule } from '../supabase/supabase.module';
import { NotificationModule } from '../notification/notification.module';
import { WalletModule } from '../wallet/wallet.module';
import { TenantGuard } from '../auth/tenant.guard';
import { AuditModule } from '../audit/audit.module';
import { DevelopersModule } from '../developers/developers.module';

@Module({
  imports: [
    SupabaseModule,
    NotificationModule,
    WalletModule,
    AuditModule,
    DevelopersModule,
  ],
  controllers: [PassesController, PController],
  providers: [TenantGuard, PassIssuanceService],
  exports: [PassIssuanceService],
})
export class PassesModule {}
