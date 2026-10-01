import { Module } from '@nestjs/common';
import { MembersController } from './members.controller';
import { SupabaseModule } from '../supabase/supabase.module';
import { NotificationModule } from '../notification/notification.module';
import { WalletModule } from '../wallet/wallet.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [SupabaseModule, NotificationModule, WalletModule, AuditModule],
  controllers: [MembersController],
})
export class MembersModule {}
