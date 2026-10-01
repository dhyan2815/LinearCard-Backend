import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { SupabaseModule } from '../supabase/supabase.module';
import { NotificationModule } from '../notification/notification.module';
import { WalletModule } from '../wallet/wallet.module';
import { PassesModule } from '../passes/passes.module';

@Module({
  imports: [SupabaseModule, NotificationModule, WalletModule, PassesModule],
  controllers: [AuthController],
})
export class AuthModule {}
