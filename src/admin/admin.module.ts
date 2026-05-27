import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Auth0AdminGuard } from '../auth/auth0-admin.guard';
import { Auth0JwtGuard } from '../auth/auth0-jwt.guard';
import {
  WaveUnlockOrder,
  WaveUnlockOrderSchema,
} from '../commercial/schemas/wave-unlock-order.schema';
import {
  PartnerWithdrawal,
  PartnerWithdrawalSchema,
} from '../payouts/schemas/partner-withdrawal.schema';
import { Region, RegionSchema } from '../studio/schemas/region.schema';
import { Spot, SpotSchema } from '../studio/schemas/spot.schema';
import { S3Module } from '../s3/s3.module';
import {
  UserProfile,
  UserProfileSchema,
} from '../users/schemas/user-profile.schema';
import { AdminFinanceController } from './admin-finance.controller';
import { AdminFinanceService } from './admin-finance.service';
import { AdminRegionsController } from './admin-regions.controller';
import { AdminRegionsService } from './admin-regions.service';
import { AdminSalesController } from './admin-sales.controller';
import { AdminSalesService } from './admin-sales.service';
import { AdminSpotsService } from './admin-spots.service';

@Module({
  imports: [
    S3Module,
    MongooseModule.forFeature([
      { name: Region.name, schema: RegionSchema },
      { name: Spot.name, schema: SpotSchema },
      { name: WaveUnlockOrder.name, schema: WaveUnlockOrderSchema },
      { name: PartnerWithdrawal.name, schema: PartnerWithdrawalSchema },
      { name: UserProfile.name, schema: UserProfileSchema },
    ]),
  ],
  controllers: [
    AdminRegionsController,
    AdminSalesController,
    AdminFinanceController,
  ],
  providers: [
    AdminRegionsService,
    AdminSpotsService,
    AdminSalesService,
    AdminFinanceService,
    Auth0JwtGuard,
    Auth0AdminGuard,
  ],
})
export class AdminModule {}
