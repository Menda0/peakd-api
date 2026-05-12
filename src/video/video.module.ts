import { Module } from '@nestjs/common';
import { VideoController } from './video.controller';
import { VideoProcessingService } from './video-processing.service';
import { VideoRegistryService } from './video-registry.service';
import { VideoFileInterceptor } from './video-file.interceptor';
import { S3Module } from '../s3/s3.module';

@Module({
  imports: [S3Module],
  controllers: [VideoController],
  providers: [
    VideoProcessingService,
    VideoRegistryService,
    VideoFileInterceptor,
  ],
})
export class VideoModule {}
