import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Auth0JwtGuard } from '../auth/auth0-jwt.guard';
import { UserProfile, UserProfileSchema } from '../users/schemas/user-profile.schema';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { PeakPurchase, PeakPurchaseSchema } from './schemas/peak-purchase.schema';
import { StripeWebhookController } from './stripe-webhook.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UserProfile.name, schema: UserProfileSchema },
      { name: PeakPurchase.name, schema: PeakPurchaseSchema },
    ]),
  ],
  controllers: [BillingController, StripeWebhookController],
  providers: [BillingService, Auth0JwtGuard],
})
export class BillingModule {}
