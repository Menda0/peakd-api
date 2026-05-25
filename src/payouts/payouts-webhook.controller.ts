import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  InternalServerErrorException,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import Stripe from 'stripe';
import {
  BILLING_CONFIG_KEY,
  type BillingConfigValues,
} from '../config/billing.config';
import { PayoutsService } from './payouts.service';

/**
 * Connect-account webhooks (`account.updated`, `transfer.*`, `payout.*`).
 * The Stripe Dashboard endpoint can be the same as Checkout's, but a separate
 * endpoint with its own signing secret is cleaner — `STRIPE_CONNECT_WEBHOOK_SECRET`
 * is preferred and falls back to `STRIPE_WEBHOOK_SECRET`.
 */
@Controller('payouts/stripe')
export class PayoutsWebhookController {
  private readonly logger = new Logger(PayoutsWebhookController.name);
  private stripeClient: Stripe | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly payouts: PayoutsService,
  ) {}

  private billing(): BillingConfigValues {
    const b = this.config.get<BillingConfigValues>(BILLING_CONFIG_KEY);
    if (!b) {
      throw new InternalServerErrorException('Billing config missing');
    }
    return b;
  }

  private stripe(): Stripe {
    if (this.stripeClient) return this.stripeClient;
    const secret = this.billing().stripeSecretKey;
    if (!secret) {
      throw new InternalServerErrorException('STRIPE_SECRET_KEY is not set');
    }
    this.stripeClient = new Stripe(secret);
    return this.stripeClient;
  }

  @Post('webhook')
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    const raw = req.rawBody;
    if (!raw || !Buffer.isBuffer(raw)) {
      throw new BadRequestException('Missing raw body for Stripe webhook');
    }
    if (!signature) {
      throw new BadRequestException('Missing stripe-signature header');
    }
    const b = this.billing();
    const secret = b.stripeConnectWebhookSecret || b.stripeWebhookSecret;
    if (!secret) {
      throw new InternalServerErrorException(
        'No Stripe webhook secret configured for Connect events',
      );
    }
    let event: Stripe.Event;
    try {
      event = this.stripe().webhooks.constructEvent(raw, signature, secret);
    } catch {
      throw new BadRequestException('Invalid Stripe webhook signature');
    }
    return this.dispatch(event);
  }

  /** Called by the Next.js BFF after it verifies the Stripe signature on the raw body. */
  @Post('process-event')
  async processEvent(
    @Headers('x-peakd-billing-webhook-internal') internalSecret: string | undefined,
    @Body() body: { event: Stripe.Event },
  ): Promise<{ received: true }> {
    const expected = this.billing().webhookInternalSecret;
    if (!expected) {
      throw new InternalServerErrorException(
        'BILLING_WEBHOOK_INTERNAL_SECRET is not set',
      );
    }
    if (!internalSecret || internalSecret !== expected) {
      throw new UnauthorizedException();
    }
    if (!body?.event?.type) {
      throw new BadRequestException('Missing Stripe event');
    }
    return this.dispatch(body.event);
  }

  private async dispatch(event: Stripe.Event): Promise<{ received: true }> {
    switch (event.type) {
      case 'account.updated': {
        const account = event.data.object as Stripe.Account;
        await this.payouts.syncConnectAccountFromEvent(account);
        break;
      }
      case 'transfer.created':
      case 'transfer.reversed': {
        const transfer = event.data.object as Stripe.Transfer;
        await this.payouts.syncWithdrawalFromTransfer(transfer, event.type);
        break;
      }
      case 'payout.paid':
      case 'payout.failed':
        // Connected-account payout events — useful for partner notifications.
        // We don't change state here because the source of truth for our
        // partner_withdrawals collection is the platform-side Transfer.
        this.logger.log(`Received ${event.type} for ${event.data.object.id}`);
        break;
      default:
        // Unhandled event types are acknowledged silently.
        break;
    }
    return { received: true };
  }
}
