import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Auth0AdminGuard } from '../auth/auth0-admin.guard';
import { AdminPeaksService } from './admin-peaks.service';

@Controller('admin/peaks')
@UseGuards(Auth0AdminGuard)
export class AdminPeaksController {
  constructor(private readonly peaks: AdminPeaksService) {}

  @Get('summary')
  getSummary() {
    return this.peaks.getSummary();
  }

  @Get('transactions')
  listTransactions(
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const parsedLimit = limit != null ? Number(limit) : undefined;
    return this.peaks.listTransactions({
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      cursor,
    });
  }

  @Get('by-country')
  listByCountry() {
    return this.peaks.listByCountry();
  }

  @Get('by-region')
  listByRegion(@Query('countryCode') countryCode: string) {
    return this.peaks.listByRegion(countryCode ?? '');
  }
}
