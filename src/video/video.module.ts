import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { VideoController } from './video.controller';
import { VideoProcessingService } from './video-processing.service';
import { VideoRegistryService } from './video-registry.service';
import { VideoFileInterceptor } from './video-file.interceptor';
import { S3Module } from '../s3/s3.module';
import { VideoJob, VideoJobSchema } from './schemas/video-job.schema';
import { Auth0JwtGuard } from '../auth/auth0-jwt.guard';
import { StudioModule } from '../studio/studio.module';
import {
  WaveUnlockOrder,
  WaveUnlockOrderSchema,
} from '../commercial/schemas/wave-unlock-order.schema';

@Module({
  imports: [
    S3Module,
    StudioModule,
    MongooseModule.forFeature([
      { name: VideoJob.name, schema: VideoJobSchema },
      { name: WaveUnlockOrder.name, schema: WaveUnlockOrderSchema },
    ]),
  ],
  controllers: [VideoController],
  providers: [
    VideoProcessingService,
    VideoRegistryService,
    VideoFileInterceptor,
    Auth0JwtGuard,
  ],
})
export class VideoModule {}
