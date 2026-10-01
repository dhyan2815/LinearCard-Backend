import { Module } from '@nestjs/common';
import { OtpService } from './otp.service';
import { NotifyService } from './notify.service';
import { WhatsappService } from './whatsapp.service';

@Module({
  providers: [OtpService, NotifyService, WhatsappService],
  exports: [OtpService, NotifyService, WhatsappService],
})
export class NotificationModule {}
