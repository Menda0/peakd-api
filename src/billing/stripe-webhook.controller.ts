import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import type Stripe from 'stripe';
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

  /** Called by the Next.js BFF after it verifies the Stripe signature on the raw body. */
  @Post('process-event')
  processEvent(
    @Headers('x-peakd-billing-webhook-internal') internalSecret: string | undefined,
    @Body() body: { event: Stripe.Event },
  ) {
    if (!body?.event?.type) {
      throw new BadRequestException('Missing Stripe event');
    }
    return this.billing.processStripeEventFromBff(internalSecret, body.event);
  }
}
