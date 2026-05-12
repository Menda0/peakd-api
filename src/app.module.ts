import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { VideoModule } from './video/video.module';
import { S3Module } from './s3/s3.module';
import { videoConfig } from './config/video.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [videoConfig],
    }),
    S3Module,
    VideoModule,
  ],
})
export class AppModule {}
