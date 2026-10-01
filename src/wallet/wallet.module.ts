import { Module } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { NotificationModule } from '../notification/notification.module';
import { AuditModule } from '../audit/audit.module';
import { DevelopersModule } from '../developers/developers.module';

@Module({
  imports: [NotificationModule, AuditModule, DevelopersModule],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
