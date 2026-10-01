import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { WalletModule } from '../wallet/wallet.module';
import { NotificationModule } from '../notification/notification.module';
import { PassesModule } from '../passes/passes.module';
import { TenantGuard } from '../auth/tenant.guard';

@Module({
  imports: [WalletModule, NotificationModule, PassesModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, TenantGuard],
})
export class PaymentsModule {}
