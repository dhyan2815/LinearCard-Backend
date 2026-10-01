import { NotificationsModule } from './notifications/notifications.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { SettingsModule } from './settings/settings.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { PassesModule } from './passes/passes.module';
import { PaymentsModule } from './payments/payments.module';
import { MembersModule } from './members/members.module';
import { TemplatesModule } from './templates/templates.module';
import { ProgramsModule } from './programs/programs.module';
import { TenantModule } from './tenant/tenant.module';
import { AuthModule } from './auth/auth.module';
import { DevelopersModule } from './developers/developers.module';
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { SupabaseModule } from './supabase/supabase.module';
import { WalletModule } from './wallet/wallet.module';
import { NotificationModule } from './notification/notification.module';

@Module({
  imports: [
    SupabaseModule,
    WalletModule,
    NotificationModule,
    AuthModule,
    TenantModule,
    TemplatesModule,
    ProgramsModule,
    MembersModule,
    PassesModule,
    DashboardModule,
    SettingsModule,
    NotificationsModule,
    CampaignsModule,
    DevelopersModule,
    PaymentsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Phase 7.1 — global rather than per-route: "all mutating endpoints" is
    // the requirement, and an allowlist is a list someone forgets to add the
    // next endpoint to. Requests without an Idempotency-Key are untouched.
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule {}
