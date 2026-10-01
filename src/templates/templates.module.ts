import { Module } from '@nestjs/common';
import { TemplatesController } from './templates.controller';
import { SupabaseModule } from '../supabase/supabase.module';
import { NotificationModule } from '../notification/notification.module';
import { WalletModule } from '../wallet/wallet.module';
import { TenantGuard } from '../auth/tenant.guard';
import { TemplatesService } from './templates.service';

@Module({
  imports: [SupabaseModule, NotificationModule, WalletModule],
  controllers: [TemplatesController],
  providers: [TenantGuard, TemplatesService],
  exports: [TemplatesService],
})
export class TemplatesModule {}
