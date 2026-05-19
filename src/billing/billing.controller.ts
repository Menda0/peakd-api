import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Auth0JwtGuard } from '../auth/auth0-jwt.guard';
import { AuthUserId } from '../auth/auth-user.decorator';
import { BillingService } from './billing.service';

@Controller('billing')
@UseGuards(Auth0JwtGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('wallet')
  wallet(@AuthUserId() userId: string) {
    return this.billing.getWallet(userId);
  }

  @Post('checkout')
  checkout(
    @AuthUserId() userId: string,
    @Body() body: { packId?: string },
  ) {
    const packId = typeof body?.packId === 'string' ? body.packId.trim() : '';
    if (!packId) {
      throw new BadRequestException('packId is required');
    }
    return this.billing.createCheckoutSession(userId, packId);
  }
}
