import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Auth0JwtGuard } from '../auth/auth0-jwt.guard';
import { CommercialModule } from '../commercial/commercial.module';
import { S3Module } from '../s3/s3.module';
import { StudioModule } from '../studio/studio.module';
import { Region, RegionSchema } from '../studio/schemas/region.schema';
import { Spot, SpotSchema } from '../studio/schemas/spot.schema';
import { SurfSession, SurfSessionSchema } from '../studio/schemas/surf-session.schema';
import {
  PartnerProfile,
  PartnerProfileSchema,
} from '../partner/schemas/partner-profile.schema';
import { UserProfile, UserProfileSchema } from '../users/schemas/user-profile.schema';
import { VideoJob, VideoJobSchema } from '../video/schemas/video-job.schema';
import { FeedController } from './feed.controller';
import { FeedService } from './feed.service';
import { PublicLandingController } from './public-landing.controller';
import { VideoShaka, VideoShakaSchema } from './schemas/video-shaka.schema';

@Module({
  imports: [
    CommercialModule,
    S3Module,
    StudioModule,
    MongooseModule.forFeature([
      { name: VideoJob.name, schema: VideoJobSchema },
      { name: SurfSession.name, schema: SurfSessionSchema },
      { name: UserProfile.name, schema: UserProfileSchema },
      { name: PartnerProfile.name, schema: PartnerProfileSchema },
      { name: Region.name, schema: RegionSchema },
      { name: Spot.name, schema: SpotSchema },
      { name: VideoShaka.name, schema: VideoShakaSchema },
    ]),
  ],
  controllers: [FeedController, PublicLandingController],
  providers: [FeedService, Auth0JwtGuard],
})
export class FeedModule {}
