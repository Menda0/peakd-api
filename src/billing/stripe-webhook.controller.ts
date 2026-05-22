import {
  BadRequestException,
  Controller,
  Headers,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { BillingService } from './billing.service';

@Controller('billing/stripe')
export class StripeWebhookController {
  constructor(private readonly billing: BillingService) {}

  @Post('webhook')
  webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ) {
    const raw = req.rawBody;
    if (!raw || !Buffer.isBuffer(raw)) {
      throw new BadRequestException('Missing raw body for Stripe webhook');
    }
    return this.billing.handleStripeWebhook(raw, signature);
  }
}
