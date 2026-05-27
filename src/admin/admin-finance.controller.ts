import { Controller, Get, UseGuards } from '@nestjs/common';
import { Auth0AdminGuard } from '../auth/auth0-admin.guard';
import { AdminFinanceService } from './admin-finance.service';

@Controller('admin/finance')
@UseGuards(Auth0AdminGuard)
export class AdminFinanceController {
  constructor(private readonly finance: AdminFinanceService) {}

  /**
   * One-shot snapshot of platform finances:
   * Stripe balance, revenue, fees, partner transfers (destination charges),
   * commission retention, and net margin.
   */
  @Get('overview')
  getOverview() {
    return this.finance.getOverview();
  }
}
