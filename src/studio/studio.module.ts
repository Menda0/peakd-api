import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Region, RegionSchema } from './schemas/region.schema';
import { Spot, SpotSchema } from './schemas/spot.schema';
import { SurfSession, SurfSessionSchema } from './schemas/surf-session.schema';
import { StudioController } from './studio.controller';
import { StudioService } from './studio.service';
import { Auth0JwtGuard } from '../auth/auth0-jwt.guard';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Region.name, schema: RegionSchema },
      { name: Spot.name, schema: SpotSchema },
      { name: SurfSession.name, schema: SurfSessionSchema },
    ]),
  ],
  controllers: [StudioController],
  providers: [StudioService, Auth0JwtGuard],
  exports: [StudioService],
})
export class StudioModule {}
