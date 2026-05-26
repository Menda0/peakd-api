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
import { S3Module } from '../s3/s3.module';
import {
  UserProfile,
  UserProfileSchema,
} from '../users/schemas/user-profile.schema';
import { VideoJob, VideoJobSchema } from '../video/schemas/video-job.schema';
import { PayoutsController } from './payouts.controller';
import { PayoutsService } from './payouts.service';
import { PayoutsWebhookController } from './payouts-webhook.controller';
import {
  PartnerWithdrawal,
  PartnerWithdrawalSchema,
} from './schemas/partner-withdrawal.schema';

@Module({
  imports: [
    S3Module,
    MongooseModule.forFeature([
      { name: UserProfile.name, schema: UserProfileSchema },
      { name: PartnerProfile.name, schema: PartnerProfileSchema },
      { name: PartnerWithdrawal.name, schema: PartnerWithdrawalSchema },
      { name: WaveUnlockPurchase.name, schema: WaveUnlockPurchaseSchema },
      { name: VideoJob.name, schema: VideoJobSchema },
    ]),
  ],
  controllers: [PayoutsController, PayoutsWebhookController],
  providers: [PayoutsService, Auth0JwtGuard],
  exports: [PayoutsService],
})
export class PayoutsModule {}
