import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Auth0AdminGuard } from '../auth/auth0-admin.guard';
import { Auth0JwtGuard } from '../auth/auth0-jwt.guard';
import { Region, RegionSchema } from '../studio/schemas/region.schema';
import { Spot, SpotSchema } from '../studio/schemas/spot.schema';
import { AdminRegionsController } from './admin-regions.controller';
import { AdminRegionsService } from './admin-regions.service';
import { AdminSpotsService } from './admin-spots.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Region.name, schema: RegionSchema },
      { name: Spot.name, schema: SpotSchema },
    ]),
  ],
  controllers: [AdminRegionsController],
  providers: [
    AdminRegionsService,
    AdminSpotsService,
    Auth0JwtGuard,
    Auth0AdminGuard,
  ],
})
export class AdminModule {}
