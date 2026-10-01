import { Module } from '@nestjs/common';
import { DevelopersController } from './developers.controller';
import { ApiKeyService } from './api-key.service';
import { WebhookService } from './webhook.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { TenantGuard } from '../auth/tenant.guard';

@Module({
  imports: [SupabaseModule],
  controllers: [DevelopersController],
  providers: [ApiKeyService, WebhookService, TenantGuard],
  exports: [ApiKeyService, WebhookService],
})
export class DevelopersModule {}
