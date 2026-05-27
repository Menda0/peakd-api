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
import { StripeWebhookService } from './stripe-webhook.service';

/**
 * Routes Stripe Checkout webhooks (`checkout.session.completed`) to
 * {@link StripeWebhookService}, which delegates to
 * `CommercialWaveService.fulfillWaveOrder`. Two ingress paths:
 *
 *  - `/billing/stripe/webhook` — Stripe → API directly (verify signature here).
 *  - `/billing/stripe/process-event` — Next.js BFF after it has verified the
 *    signature on the raw request body, then forwarded the parsed event with
 *    a shared internal secret.
 */
@Controller('billing/stripe')
export class StripeWebhookController {
  constructor(private readonly webhook: StripeWebhookService) {}

  @Post('webhook')
  handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ) {
    const raw = req.rawBody;
    if (!raw || !Buffer.isBuffer(raw)) {
      throw new BadRequestException('Missing raw body for Stripe webhook');
    }
    return this.webhook.handleStripeWebhook(raw, signature);
  }

  @Post('process-event')
  processEvent(
    @Headers('x-peakd-billing-webhook-internal') internalSecret:
      | string
      | undefined,
    @Body() body: { event: Stripe.Event },
  ) {
    if (!body?.event?.type) {
      throw new BadRequestException('Missing Stripe event');
    }
    return this.webhook.processStripeEventFromBff(internalSecret, body.event);
  }
}
