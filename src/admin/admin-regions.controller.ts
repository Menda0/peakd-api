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

@Controller('admin/regions')
@UseGuards(Auth0AdminGuard)
export class AdminRegionsController {
  constructor(private readonly regions: AdminRegionsService) {}

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
}
