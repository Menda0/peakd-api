import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Auth0AdminGuard } from '../auth/auth0-admin.guard';
import { AdminPeaksService } from './admin-peaks.service';

@Controller('admin/peaks')
@UseGuards(Auth0AdminGuard)
export class AdminPeaksController {
  constructor(private readonly peaks: AdminPeaksService) {}

  @Get('summary')
  getSummary(
    @Query('countryCode') countryCode?: string,
    @Query('regionId') regionId?: string,
  ) {
    return this.peaks.getSummary({ countryCode, regionId });
  }

  @Get('transactions')
  listTransactions(
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('countryCode') countryCode?: string,
    @Query('regionId') regionId?: string,
  ) {
    const parsedLimit = limit != null ? Number(limit) : undefined;
    return this.peaks.listTransactions({
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      cursor,
      countryCode,
      regionId,
    });
  }

  @Get('by-country')
  listByCountry(
    @Query('countryCode') countryCode?: string,
    @Query('regionId') regionId?: string,
  ) {
    return this.peaks.listByCountry({ countryCode, regionId });
  }

  @Get('by-region')
  listByRegion(
    @Query('countryCode') countryCode?: string,
    @Query('regionId') regionId?: string,
  ) {
    if (!countryCode?.trim()) {
      return this.peaks.listAllByRegion();
    }
    return this.peaks.listByRegion(countryCode, { regionId });
  }
}
