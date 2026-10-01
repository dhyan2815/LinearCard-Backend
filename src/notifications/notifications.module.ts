import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { SupabaseModule } from '../supabase/supabase.module';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [SupabaseModule, NotificationModule],
  controllers: [NotificationsController],
})
export class NotificationsModule {}
