import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AvatarMultipartInterceptor } from '../interceptors/avatar-multipart.interceptor';
import { Auth0JwtGuard } from '../auth/auth0-jwt.guard';
import { FeedModule } from '../feed/feed.module';
import { S3Module } from '../s3/s3.module';
import { StudioModule } from '../studio/studio.module';
import { VideoJob, VideoJobSchema } from '../video/schemas/video-job.schema';
import { UserProfile, UserProfileSchema } from './schemas/user-profile.schema';
import {
  UserPinnedWave,
  UserPinnedWaveSchema,
} from './schemas/user-pinned-wave.schema';
import { UserProfileService } from './user-profile.service';
import { UserPinnedWaveService } from './user-pinned-wave.service';
import { PublicProfileService } from './public-profile.service';
import { UsersController } from './users.controller';
import { PublicProfileController } from './public-profile.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UserProfile.name, schema: UserProfileSchema },
      { name: UserPinnedWave.name, schema: UserPinnedWaveSchema },
      { name: VideoJob.name, schema: VideoJobSchema },
    ]),
    StudioModule,
    S3Module,
    FeedModule,
  ],
  controllers: [UsersController, PublicProfileController],
  providers: [
    UserProfileService,
    UserPinnedWaveService,
    PublicProfileService,
    Auth0JwtGuard,
    AvatarMultipartInterceptor,
  ],
  exports: [UserProfileService],
})
export class UsersModule {}
