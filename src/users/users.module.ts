import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AvatarMultipartInterceptor } from '../interceptors/avatar-multipart.interceptor';
import { Auth0JwtGuard } from '../auth/auth0-jwt.guard';
import { S3Module } from '../s3/s3.module';
import { StudioModule } from '../studio/studio.module';
import { UserProfile, UserProfileSchema } from './schemas/user-profile.schema';
import { UserProfileService } from './user-profile.service';
import { UsersController } from './users.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UserProfile.name, schema: UserProfileSchema },
    ]),
    StudioModule,
    S3Module,
  ],
  controllers: [UsersController],
  providers: [UserProfileService, Auth0JwtGuard, AvatarMultipartInterceptor],
})
export class UsersModule {}
