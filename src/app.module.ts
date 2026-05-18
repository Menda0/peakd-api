import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { VideoModule } from './video/video.module';
import { PartnerModule } from './partner/partner.module';
import { UsersModule } from './users/users.module';
import { FeedModule } from './feed/feed.module';
import { StudioModule } from './studio/studio.module';
import { AdminModule } from './admin/admin.module';
import { S3Module } from './s3/s3.module';
import { videoConfig } from './config/video.config';
import { auth0Config } from './config/auth0.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [videoConfig, auth0Config],
    }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('MONGODB_URI'),
      }),
      inject: [ConfigService],
    }),
    S3Module,
    VideoModule,
    StudioModule,
    AdminModule,
    PartnerModule,
    UsersModule,
    FeedModule,
  ],
})
export class AppModule {}
