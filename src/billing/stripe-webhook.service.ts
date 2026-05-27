import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { CommercialWaveService } from '../commercial/commercial-wave.service';
import {
  BILLING_CONFIG_KEY,
  type BillingConfigValues,
} from '../config/billing.config';

/**
 * Stripe Checkout webhook handler. Verifies signatures (or trusts the BFF
 * via a shared internal secret) and routes
 * `checkout.session.completed` events to
 * {@link CommercialWaveService.fulfillWaveOrder}.
 */
@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);
  private stripeClient: Stripe | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly commercialWave: CommercialWaveService,
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

  async handleStripeWebhook(
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<{ received: true }> {
    const b = this.billing();
    if (!b.stripeWebhookSecret) {
      throw new InternalServerErrorException(
        'STRIPE_WEBHOOK_SECRET is not set',
      );
    }
    if (!signature) {
      throw new BadRequestException('Missing stripe-signature header');
    }
    let event: Stripe.Event;
    try {
      event = this.stripe().webhooks.constructEvent(
        rawBody,
        signature,
        b.stripeWebhookSecret,
      );
    } catch {
      throw new BadRequestException('Invalid Stripe webhook signature');
    }
    return this.processStripeEvent(event);
  }

  async processStripeEventFromBff(
    internalSecret: string | undefined,
    event: Stripe.Event,
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
    return this.processStripeEvent(event);
  }

  async processStripeEvent(
    event: Stripe.Event,
  ): Promise<{ received: true }> {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      try {
        await this.commercialWave.fulfillWaveOrder(session);
      } catch (err) {
        this.logger.error(
          `Failed to fulfill wave-unlock order for ${session.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        throw err;
      }
    }
    return { received: true };
  }
}
