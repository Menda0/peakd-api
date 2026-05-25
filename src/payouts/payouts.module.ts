import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Auth0JwtGuard } from '../auth/auth0-jwt.guard';
import {
  WaveUnlockPurchase,
  WaveUnlockPurchaseSchema,
} from '../commercial/schemas/wave-unlock-purchase.schema';
import {
  PartnerProfile,
  PartnerProfileSchema,
} from '../partner/schemas/partner-profile.schema';
import {
  UserProfile,
  UserProfileSchema,
} from '../users/schemas/user-profile.schema';
import { PayoutsController } from './payouts.controller';
import { PayoutsService } from './payouts.service';
import { PayoutsWebhookController } from './payouts-webhook.controller';
import {
  PartnerWithdrawal,
  PartnerWithdrawalSchema,
} from './schemas/partner-withdrawal.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UserProfile.name, schema: UserProfileSchema },
      { name: PartnerProfile.name, schema: PartnerProfileSchema },
      { name: PartnerWithdrawal.name, schema: PartnerWithdrawalSchema },
      { name: WaveUnlockPurchase.name, schema: WaveUnlockPurchaseSchema },
    ]),
  ],
  controllers: [PayoutsController, PayoutsWebhookController],
  providers: [PayoutsService, Auth0JwtGuard],
  exports: [PayoutsService],
})
export class PayoutsModule {}
