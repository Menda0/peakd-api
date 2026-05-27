import {
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Auth0JwtGuard } from '../auth/auth0-jwt.guard';
import { AuthUserId } from '../auth/auth-user.decorator';
import { PayoutsService } from './payouts.service';

/**
 * Partner-only UX is enforced in Next.js (mirrors PartnersController). The API
 * scopes everything by the authenticated `sub`.
 */
@Controller('partners/me/payouts')
@UseGuards(Auth0JwtGuard)
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get('status')
  status(@AuthUserId() userId: string) {
    return this.payouts.getStatus(userId);
  }

  @Get('earnings')
  earnings(
    @AuthUserId() userId: string,
    @Query('limit') limitRaw?: string,
    @Query('cursor') cursor?: string,
  ) {
    const limit = limitRaw != null ? Number.parseInt(limitRaw, 10) : undefined;
    return this.payouts.listEarnings(userId, {
      limit: Number.isFinite(limit) ? limit : undefined,
      cursor: typeof cursor === 'string' ? cursor : undefined,
    });
  }

  @Post('onboarding-link')
  onboardingLink(@AuthUserId() userId: string) {
    return this.payouts.createOnboardingLink(userId);
  }
}
