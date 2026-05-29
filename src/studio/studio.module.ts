import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Region, RegionSchema } from './schemas/region.schema';
import { Spot, SpotSchema } from './schemas/spot.schema';
import { SurfSession, SurfSessionSchema } from './schemas/surf-session.schema';
import { StudioController } from './studio.controller';
import { PublicSharedSessionController } from './public-shared-session.controller';
import { SharedSessionAuthController } from './shared-session-auth.controller';
import { SessionExportService } from './session-export.service';
import { SharedSessionService } from './shared-session.service';
import { StudioService } from './studio.service';
import { SurfSessionIndexesService } from './surf-session-indexes.service';
import { Auth0JwtGuard } from '../auth/auth0-jwt.guard';
import { S3Module } from '../s3/s3.module';
import { VideoShaka, VideoShakaSchema } from '../feed/schemas/video-shaka.schema';
import { VideoJob, VideoJobSchema } from '../video/schemas/video-job.schema';
import {
  PartnerProfile,
  PartnerProfileSchema,
} from '../partner/schemas/partner-profile.schema';
import {
  UserProfile,
  UserProfileSchema,
} from '../users/schemas/user-profile.schema';

@Module({
  imports: [
    S3Module,
    MongooseModule.forFeature([
      { name: Region.name, schema: RegionSchema },
      { name: Spot.name, schema: SpotSchema },
      { name: SurfSession.name, schema: SurfSessionSchema },
      { name: VideoJob.name, schema: VideoJobSchema },
      { name: VideoShaka.name, schema: VideoShakaSchema },
      { name: PartnerProfile.name, schema: PartnerProfileSchema },
      { name: UserProfile.name, schema: UserProfileSchema },
    ]),
  ],
  controllers: [
    StudioController,
    PublicSharedSessionController,
    SharedSessionAuthController,
  ],
  providers: [
    StudioService,
    SharedSessionService,
    SessionExportService,
    SurfSessionIndexesService,
    Auth0JwtGuard,
  ],
  exports: [StudioService],
})
export class StudioModule {}
