import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Region, RegionSchema } from './schemas/region.schema';
import { Spot, SpotSchema } from './schemas/spot.schema';
import { SurfSession, SurfSessionSchema } from './schemas/surf-session.schema';
import { StudioController } from './studio.controller';
import { StudioService } from './studio.service';
import { Auth0JwtGuard } from '../auth/auth0-jwt.guard';
import { S3Module } from '../s3/s3.module';
import { VideoJob, VideoJobSchema } from '../video/schemas/video-job.schema';

@Module({
  imports: [
    S3Module,
    MongooseModule.forFeature([
      { name: Region.name, schema: RegionSchema },
      { name: Spot.name, schema: SpotSchema },
      { name: SurfSession.name, schema: SurfSessionSchema },
      { name: VideoJob.name, schema: VideoJobSchema },
    ]),
  ],
  controllers: [StudioController],
  providers: [StudioService, Auth0JwtGuard],
  exports: [StudioService],
})
export class StudioModule {}
