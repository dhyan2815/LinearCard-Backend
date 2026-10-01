import { Module } from '@nestjs/common';
import { ProgramsController } from './programs.controller';
import { ProgramMembersController } from './program-members.controller';
import { ProgramAnalyticsController } from './program-analytics.controller';
import { SupabaseModule } from '../supabase/supabase.module';
import { TemplatesModule } from '../templates/templates.module';
import { WalletModule } from '../wallet/wallet.module';
import { TenantGuard } from '../auth/tenant.guard';

@Module({
  imports: [SupabaseModule, TemplatesModule, WalletModule],
  controllers: [
    ProgramsController,
    ProgramMembersController,
    ProgramAnalyticsController,
  ],
  providers: [TenantGuard],
})
export class ProgramsModule {}
