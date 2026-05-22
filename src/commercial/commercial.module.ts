import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PartnerProfile, PartnerProfileSchema } from '../partner/schemas/partner-profile.schema';
import { SurfSession, SurfSessionSchema } from '../studio/schemas/surf-session.schema';
import { UserProfile, UserProfileSchema } from '../users/schemas/user-profile.schema';
import { VideoJob, VideoJobSchema } from '../video/schemas/video-job.schema';
import { CommercialWaveService } from './commercial-wave.service';
import {
  WaveUnlockPurchase,
  WaveUnlockPurchaseSchema,
} from './schemas/wave-unlock-purchase.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: VideoJob.name, schema: VideoJobSchema },
      { name: SurfSession.name, schema: SurfSessionSchema },
      { name: PartnerProfile.name, schema: PartnerProfileSchema },
      { name: UserProfile.name, schema: UserProfileSchema },
      { name: WaveUnlockPurchase.name, schema: WaveUnlockPurchaseSchema },
    ]),
  ],
  providers: [CommercialWaveService],
  exports: [CommercialWaveService],
})
export class CommercialModule {}
