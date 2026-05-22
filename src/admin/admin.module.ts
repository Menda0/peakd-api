import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Auth0AdminGuard } from '../auth/auth0-admin.guard';
import { Auth0JwtGuard } from '../auth/auth0-jwt.guard';
import {
  WaveUnlockPurchase,
  WaveUnlockPurchaseSchema,
} from '../commercial/schemas/wave-unlock-purchase.schema';
import { Region, RegionSchema } from '../studio/schemas/region.schema';
import { Spot, SpotSchema } from '../studio/schemas/spot.schema';
import { UserProfile, UserProfileSchema } from '../users/schemas/user-profile.schema';
import { AdminPeaksController } from './admin-peaks.controller';
import { AdminPeaksService } from './admin-peaks.service';
import { AdminRegionsController } from './admin-regions.controller';
import { AdminRegionsService } from './admin-regions.service';
import { AdminSpotsService } from './admin-spots.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Region.name, schema: RegionSchema },
      { name: Spot.name, schema: SpotSchema },
      { name: WaveUnlockPurchase.name, schema: WaveUnlockPurchaseSchema },
      { name: UserProfile.name, schema: UserProfileSchema },
    ]),
  ],
  controllers: [AdminRegionsController, AdminPeaksController],
  providers: [
    AdminRegionsService,
    AdminSpotsService,
    AdminPeaksService,
    Auth0JwtGuard,
    Auth0AdminGuard,
  ],
})
export class AdminModule {}
