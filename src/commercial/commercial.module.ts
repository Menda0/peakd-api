import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  PartnerProfile,
  PartnerProfileSchema,
} from '../partner/schemas/partner-profile.schema';
import {
  SurfSession,
  SurfSessionSchema,
} from '../studio/schemas/surf-session.schema';
import {
  UserProfile,
  UserProfileSchema,
} from '../users/schemas/user-profile.schema';
import { VideoJob, VideoJobSchema } from '../video/schemas/video-job.schema';
import { CommercialWaveService } from './commercial-wave.service';
import {
  WaveUnlockOrder,
  WaveUnlockOrderSchema,
} from './schemas/wave-unlock-order.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: VideoJob.name, schema: VideoJobSchema },
      { name: SurfSession.name, schema: SurfSessionSchema },
      { name: PartnerProfile.name, schema: PartnerProfileSchema },
      { name: UserProfile.name, schema: UserProfileSchema },
      { name: WaveUnlockOrder.name, schema: WaveUnlockOrderSchema },
    ]),
  ],
  providers: [CommercialWaveService],
  exports: [
    CommercialWaveService,
    MongooseModule,
  ],
})
export class CommercialModule {}
