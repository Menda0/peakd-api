import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthUserId } from '../auth/auth-user.decorator';
import { Auth0AdminGuard } from '../auth/auth0-admin.guard';
import { AdminRegionsService } from './admin-regions.service';
import { AdminSpotsService } from './admin-spots.service';

@Controller('admin/regions')
@UseGuards(Auth0AdminGuard)
export class AdminRegionsController {
  constructor(
    private readonly regions: AdminRegionsService,
    private readonly spots: AdminSpotsService,
  ) {}

  @Get()
  listRegions(@Query('countryCode') countryCode: string) {
    return this.regions.listRegions(countryCode ?? '');
  }

  @Post()
  createRegion(
    @AuthUserId() userId: string,
    @Body()
    body: { countryCode?: string; name?: string; verified?: boolean },
  ) {
    return this.regions.createRegion(userId, body);
  }

  @Get(':regionId')
  getRegion(@Param('regionId') regionId: string) {
    return this.regions.getRegion(regionId);
  }

  @Patch(':regionId')
  updateRegion(
    @Param('regionId') regionId: string,
    @Body()
    body: {
      name?: string;
      countryCode?: string;
      verified?: boolean;
      disabled?: boolean;
    },
  ) {
    return this.regions.updateRegion(regionId, body);
  }

  @Delete(':regionId')
  @HttpCode(HttpStatus.OK)
  disableRegion(@Param('regionId') regionId: string) {
    return this.regions.disableRegion(regionId);
  }

  @Get(':regionId/spots')
  listSpots(@Param('regionId') regionId: string) {
    return this.spots.listSpots(regionId);
  }

  @Post(':regionId/spots')
  createSpot(
    @Param('regionId') regionId: string,
    @AuthUserId() userId: string,
    @Body()
    body: {
      name?: string;
      level?: string | null;
      breakType?: string | null;
      consistency?: string | null;
      verified?: boolean;
    },
  ) {
    return this.spots.createSpot(regionId, userId, body);
  }

  @Patch(':regionId/spots/:spotId')
  updateSpot(
    @Param('regionId') regionId: string,
    @Param('spotId') spotId: string,
    @Body()
    body: {
      name?: string;
      level?: string | null;
      breakType?: string | null;
      consistency?: string | null;
      verified?: boolean;
      disabled?: boolean;
    },
  ) {
    return this.spots.updateSpot(regionId, spotId, body);
  }

  @Delete(':regionId/spots/:spotId')
  @HttpCode(HttpStatus.OK)
  disableSpot(
    @Param('regionId') regionId: string,
    @Param('spotId') spotId: string,
  ) {
    return this.spots.disableSpot(regionId, spotId);
  }
}
