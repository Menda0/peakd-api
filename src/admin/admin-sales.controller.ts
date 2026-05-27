import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Auth0AdminGuard } from '../auth/auth0-admin.guard';
import { AdminSalesService } from './admin-sales.service';

@Controller('admin/sales')
@UseGuards(Auth0AdminGuard)
export class AdminSalesController {
  constructor(private readonly sales: AdminSalesService) {}

  @Get('summary')
  getSummary(
    @Query('countryCode') countryCode?: string,
    @Query('regionId') regionId?: string,
    @Query('currency') currency?: string,
  ) {
    return this.sales.getSummary({ countryCode, regionId, currency });
  }

  @Get('transactions')
  listTransactions(
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('countryCode') countryCode?: string,
    @Query('regionId') regionId?: string,
    @Query('currency') currency?: string,
  ) {
    const parsedLimit = limit != null ? Number(limit) : undefined;
    return this.sales.listTransactions({
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      cursor,
      countryCode,
      regionId,
      currency,
    });
  }

  @Get('by-country')
  listByCountry(
    @Query('countryCode') countryCode?: string,
    @Query('regionId') regionId?: string,
    @Query('currency') currency?: string,
  ) {
    return this.sales.listByCountry({ countryCode, regionId, currency });
  }

  @Get('by-region')
  listByRegion(
    @Query('countryCode') countryCode?: string,
    @Query('regionId') regionId?: string,
    @Query('currency') currency?: string,
  ) {
    if (!countryCode?.trim()) {
      return this.sales.listAllByRegion();
    }
    return this.sales.listByRegion(countryCode, { regionId, currency });
  }
}
