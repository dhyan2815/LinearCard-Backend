import { Module } from '@nestjs/common';
import { TenantController } from './tenant.controller';
import { SupabaseModule } from '../supabase/supabase.module';
import { NotificationModule } from '../notification/notification.module';
import { WalletModule } from '../wallet/wallet.module';
import { TenantGuard } from '../auth/tenant.guard';

@Module({
  imports: [SupabaseModule, NotificationModule, WalletModule],
  controllers: [TenantController],
  providers: [TenantGuard],
})
export class TenantModule {}
