import { Module } from '@nestjs/common';
import { CommercialModule } from '../commercial/commercial.module';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeWebhookService } from './stripe-webhook.service';

/**
 * Slim billing module: only handles the Stripe Checkout webhook for
 * wave-unlock orders. The actual order/fulfillment lives in
 * {@link CommercialModule}, which we import here to call
 * `CommercialWaveService.fulfillWaveOrder()`.
 */
@Module({
  imports: [CommercialModule],
  controllers: [StripeWebhookController],
  providers: [StripeWebhookService],
})
export class BillingModule {}
