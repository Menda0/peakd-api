import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Auth0JwtGuard } from '../auth/auth0-jwt.guard';
import { PartnerAvatarInterceptor } from './partner-avatar.interceptor';
import { S3Module } from '../s3/s3.module';
import {
  PartnerProfile,
  PartnerProfileSchema,
} from './schemas/partner-profile.schema';
import { PartnerProfileService } from './partner-profile.service';
import { PartnersController } from './partners.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PartnerProfile.name, schema: PartnerProfileSchema },
    ]),
    S3Module,
  ],
  controllers: [PartnersController],
  providers: [
    PartnerProfileService,
    Auth0JwtGuard,
    PartnerAvatarInterceptor,
  ],
})
export class PartnerModule {}
