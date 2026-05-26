import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';
import Stripe from 'stripe';
import {
  BILLING_CONFIG_KEY,
  type BillingConfigValues,
} from '../config/billing.config';
import { UserProfile } from '../users/schemas/user-profile.schema';
import {
  assertPacksAreSolvent,
  computeCheckoutPricing,
  getPeakPackById,
  PEAK_PACKS,
} from './peak-packs';
import { PeakPurchase } from './schemas/peak-purchase.schema';

export type WalletPackDto = {
  id: string;
  label: string;
  peaks: number;
  baseAmountCents: number;
  platformFeeCents: number;
  totalAmountCents: number;
};

export type WalletResponseDto = {
  peaksBalance: number;
  peaksPerEuro: number;
  platformFeePercent: number;
  packs: WalletPackDto[];
};

function isMongoDuplicateKey(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: number }).code === 11000
  );
}

@Injectable()
export class BillingService implements OnModuleInit {
  private readonly logger = new Logger(BillingService.name);
  private stripeClient: Stripe | null = null;

  constructor(
    private readonly config: ConfigService,
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(UserProfile.name)
    private readonly userProfileModel: Model<UserProfile>,
    @InjectModel(PeakPurchase.name)
    private readonly peakPurchaseModel: Model<PeakPurchase>,
  ) {}

  onModuleInit(): void {
    const billing = this.config.get<BillingConfigValues>(BILLING_CONFIG_KEY);
    if (!billing) return;
    assertPacksAreSolvent({
      peaksPerEuro: billing.peaksPerEuro,
      platformFeePercent: billing.platformFeePercent,
      expectedStripeFeePercent: billing.expectedStripeFeePercent,
      expectedStripeFixedCents: billing.expectedStripeFixedCents,
    });
  }

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

  private userPathSegment(userId: string): string {
    return encodeURIComponent(userId);
  }

  async getWallet(userId: string): Promise<WalletResponseDto> {
    const b = this.billing();
    const doc = await this.userProfileModel.findOne({ userId }).lean().exec();
    const peaksBalance = Math.max(0, doc?.peaksBalance ?? 0);
    const packs: WalletPackDto[] = PEAK_PACKS.map((p) => {
      const pricing = computeCheckoutPricing(
        p.baseAmountCents,
        b.platformFeePercent,
      );
      return {
        id: p.id,
        label: p.label,
        peaks: p.peaks,
        baseAmountCents: pricing.baseAmountCents,
        platformFeeCents: pricing.platformFeeCents,
        totalAmountCents: pricing.totalAmountCents,
      };
    });
    return {
      peaksBalance,
      peaksPerEuro: b.peaksPerEuro,
      platformFeePercent: b.platformFeePercent,
      packs,
    };
  }

  async createCheckoutSession(
    userId: string,
    packId: string,
  ): Promise<{ url: string }> {
    const pack = getPeakPackById(packId);
    if (!pack) {
      throw new BadRequestException('Unknown pack');
    }
    const b = this.billing();
    if (!b.appBaseUrl) {
      throw new InternalServerErrorException('APP_BASE_URL is not set');
    }
    const pricing = computeCheckoutPricing(
      pack.baseAmountCents,
      b.platformFeePercent,
    );

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      {
        price_data: {
          currency: 'eur',
          unit_amount: pricing.baseAmountCents,
          product_data: {
            name: `${pack.peaks.toLocaleString('en-US')} Peaks (${pack.label})`,
          },
        },
        quantity: 1,
      },
    ];
    if (pricing.platformFeeCents > 0) {
      lineItems.push({
        price_data: {
          currency: 'eur',
          unit_amount: pricing.platformFeeCents,
          product_data: {
            name: `Platform fee (${b.platformFeePercent}%)`,
          },
        },
        quantity: 1,
      });
    }

    const base = b.appBaseUrl;
    const seg = this.userPathSegment(userId);
    const successUrl = `${base}/${seg}/peaks?checkout=success`;
    const cancelUrl = `${base}/${seg}/peaks?checkout=cancel`;

    const session = await this.stripe().checkout.sessions.create({
      mode: 'payment',
      client_reference_id: userId,
      success_url: successUrl,
      cancel_url: cancelUrl,
      line_items: lineItems,
      metadata: {
        userId,
        packId: pack.id,
        peaksAmount: String(pack.peaks),
        baseAmountCents: String(pricing.baseAmountCents),
        platformFeePercent: String(b.platformFeePercent),
        platformFeeCents: String(pricing.platformFeeCents),
        totalAmountCents: String(pricing.totalAmountCents),
      },
    });
    if (!session.url) {
      throw new InternalServerErrorException('Stripe did not return checkout URL');
    }
    return { url: session.url };
  }

  async handleStripeWebhook(
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<{ received: true }> {
    const b = this.billing();
    if (!b.stripeWebhookSecret) {
      throw new InternalServerErrorException('STRIPE_WEBHOOK_SECRET is not set');
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

  async processStripeEvent(event: Stripe.Event): Promise<{ received: true }> {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      await this.fulfillCheckoutIfPaid(session);
    }

    return { received: true };
  }

  private async fulfillCheckoutIfPaid(
    session: Stripe.Checkout.Session,
  ): Promise<void> {
    if (session.payment_status !== 'paid') {
      return;
    }
    const sessionId = session.id;
    const meta = session.metadata ?? {};
    const userId = meta.userId;
    const packId = meta.packId;
    if (typeof userId !== 'string' || !userId) {
      return;
    }
    if (typeof packId !== 'string' || !packId) {
      return;
    }
    if (session.client_reference_id && session.client_reference_id !== userId) {
      return;
    }

    const pack = getPeakPackById(packId);
    if (!pack) {
      return;
    }

    const b = this.billing();
    const pricing = computeCheckoutPricing(
      pack.baseAmountCents,
      b.platformFeePercent,
    );

    const peaksAmount = Number(meta.peaksAmount);
    const baseAmountCents = Number(meta.baseAmountCents);
    const platformFeePercent = Number(meta.platformFeePercent);
    const platformFeeCents = Number(meta.platformFeeCents);
    const totalAmountCents = Number(meta.totalAmountCents);

    if (!Number.isFinite(peaksAmount) || peaksAmount !== pack.peaks) {
      return;
    }
    if (!Number.isFinite(baseAmountCents) || baseAmountCents !== pricing.baseAmountCents) {
      return;
    }
    if (!Number.isFinite(platformFeePercent) || platformFeePercent !== b.platformFeePercent) {
      return;
    }
    if (!Number.isFinite(platformFeeCents) || platformFeeCents !== pricing.platformFeeCents) {
      return;
    }
    if (!Number.isFinite(totalAmountCents) || totalAmountCents !== pricing.totalAmountCents) {
      return;
    }

    const currency = (session.currency ?? '').toLowerCase();
    if (currency !== 'eur') {
      return;
    }

    if (
      typeof session.amount_total === 'number' &&
      session.amount_total !== pricing.totalAmountCents
    ) {
      return;
    }

    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent && typeof session.payment_intent === 'object'
          ? (session.payment_intent as Stripe.PaymentIntent).id
          : null;

    // Retrieve the BalanceTransaction so we can persist Stripe's real processing
    // fee + net settlement amount alongside the gross we already store. Without
    // this we can never reconcile our `peak_purchases` ledger against the actual
    // money landing in our Stripe balance.
    const feeInfo = await this.resolveStripeFeeInfo(paymentIntentId, currency);

    const mongoSession = await this.connection.startSession();
    mongoSession.startTransaction();
    try {
      await this.peakPurchaseModel.create(
        [
          {
            userId,
            packId: pack.id,
            peaksAmount: pack.peaks,
            baseAmountCents: pricing.baseAmountCents,
            platformFeePercent: b.platformFeePercent,
            platformFeeCents: pricing.platformFeeCents,
            totalAmountCents: pricing.totalAmountCents,
            stripeCheckoutSessionId: sessionId,
            stripePaymentIntentId: paymentIntentId,
            stripeBalanceTransactionId: feeInfo.balanceTransactionId,
            stripeFeeCents: feeInfo.feeCents,
            stripeNetCents: feeInfo.netCents,
            stripeCurrency: feeInfo.currency,
            status: 'completed',
          },
        ],
        { session: mongoSession },
      );

      await this.userProfileModel.updateOne(
        { userId },
        {
          $inc: { peaksBalance: pack.peaks },
          $setOnInsert: {
            userId,
            displayName: null,
            nickname: null,
            countryCode: null,
            homeRegionId: null,
            surfLevel: null,
            avatarKey: null,
          },
        },
        { session: mongoSession, upsert: true },
      );

      await mongoSession.commitTransaction();
    } catch (err) {
      await mongoSession.abortTransaction();
      if (isMongoDuplicateKey(err)) {
        return;
      }
      throw err;
    } finally {
      await mongoSession.endSession();
    }
  }

  /**
   * Pulls the Stripe processing fee + net settled amount for a Checkout charge
   * by retrieving the PaymentIntent with its latest charge's BalanceTransaction
   * expanded. Returns nulls if Stripe doesn't have the data yet — the webhook
   * may retry, and we still want the purchase row written.
   */
  private async resolveStripeFeeInfo(
    paymentIntentId: string | null,
    expectedCurrency: string,
  ): Promise<{
    balanceTransactionId: string | null;
    feeCents: number | null;
    netCents: number | null;
    currency: string | null;
  }> {
    if (!paymentIntentId) {
      return { balanceTransactionId: null, feeCents: null, netCents: null, currency: null };
    }
    try {
      const pi = await this.stripe().paymentIntents.retrieve(paymentIntentId, {
        expand: ['latest_charge.balance_transaction'],
      });
      const charge = pi.latest_charge;
      if (!charge || typeof charge === 'string') {
        return { balanceTransactionId: null, feeCents: null, netCents: null, currency: null };
      }
      const bt = (charge as Stripe.Charge).balance_transaction;
      if (!bt || typeof bt === 'string') {
        return { balanceTransactionId: null, feeCents: null, netCents: null, currency: null };
      }
      const txn = bt as Stripe.BalanceTransaction;
      const currency = (txn.currency ?? '').toLowerCase();
      if (currency && currency !== expectedCurrency) {
        // Loud warning rather than throwing — we'd rather still record the
        // purchase than drop revenue because Stripe routed the charge through
        // a different settlement currency. The admin dashboard surfaces FX
        // anomalies via the per-row `stripeCurrency` field.
        this.logger.warn(
          `Stripe BalanceTransaction currency (${currency}) differs from Checkout currency (${expectedCurrency}) for PI ${paymentIntentId}`,
        );
      }
      return {
        balanceTransactionId: txn.id,
        feeCents: typeof txn.fee === 'number' ? txn.fee : null,
        netCents: typeof txn.net === 'number' ? txn.net : null,
        currency: currency || null,
      };
    } catch (err) {
      this.logger.warn(
        `Failed to retrieve Stripe BalanceTransaction for PI ${paymentIntentId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { balanceTransactionId: null, feeCents: null, netCents: null, currency: null };
    }
  }
}
