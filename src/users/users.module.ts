import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Auth0JwtGuard } from '../auth/auth0-jwt.guard';
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
  ],
  controllers: [UsersController],
  providers: [UserProfileService, Auth0JwtGuard],
})
export class UsersModule {}
