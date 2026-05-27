import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { ClientSession, Connection, Model } from 'mongoose';
import Stripe from 'stripe';
import {
  BILLING_CONFIG_KEY,
  type BillingConfigValues,
} from '../config/billing.config';
import { PartnerProfile } from '../partner/schemas/partner-profile.schema';
import { SurfSession } from '../studio/schemas/surf-session.schema';
import { VideoJob } from '../video/schemas/video-job.schema';
import {
  allocateBuyClaimLineBreakdownsMinor,
  computeBuyClaimMinor,
  computeCheckoutTotalMinor,
  computeSponsorMinor,
  PLATFORM_COMMISSION_PERCENT_DEFAULT,
  resolveEffectiveCommercialSettings,
  type CheckoutBreakdownWithDiscountMinor,
} from './commercial-pricing';
import type { CommercialSettings } from './commercial-settings.types';
import {
  WaveUnlockOrder,
  type WaveUnlockOrderDocument,
  type WaveUnlockOrderIntent,
} from './schemas/wave-unlock-order.schema';

export type CommercialWaveContext = {
  job: {
    jobId: string;
    userId: string;
    surfSessionId: string | null;
    uploadSource?: string;
    status?: string;
    processedKey?: string | null;
    discoverPublishedAt?: string | null;
    claimStatus?: string;
    claimedByUserId?: string | null;
    videoUnlockedForUserId?: string | null;
  };
  session: {
    sessionId: string;
    userId: string;
    countryCode: string;
    regionId: string;
    spotId: string;
    isCommercial?: boolean;
    commercialSettings?: CommercialSettings | null;
  };
  settings: CommercialSettings;
};

export type CreateWaveOrderCheckoutInput = {
  buyerUserId: string;
  partnerUserId: string;
  jobIds: string[];
  intent: WaveUnlockOrderIntent;
};

export type CreateWaveOrderCheckoutResult = {
  url: string;
  orderId: string;
};

export type WaveOrderStatusDto = {
  orderId: string;
  status: WaveUnlockOrderDocument['status'];
  intent: WaveUnlockOrderIntent;
  partnerUserId: string;
  jobIds: string[];
  currency: string;
  partnerSubtotalMinor: number;
  platformCommissionMinor: number;
  totalAmountMinor: number;
  failureReason: string | null;
  completedAt: string | null;
};

@Injectable()
export class CommercialWaveService {
  private readonly logger = new Logger(CommercialWaveService.name);
  private stripeClient: Stripe | null = null;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(VideoJob.name)
    private readonly videoJobModel: Model<VideoJob>,
    @InjectModel(SurfSession.name)
    private readonly surfSessionModel: Model<SurfSession>,
    @InjectModel(PartnerProfile.name)
    private readonly partnerProfileModel: Model<PartnerProfile>,
    @InjectModel(WaveUnlockOrder.name)
    private readonly waveUnlockOrderModel: Model<WaveUnlockOrder>,
    private readonly config: ConfigService,
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

  private commissionPercent(): number {
    return (
      this.billing().platformCommissionPercent ??
      PLATFORM_COMMISSION_PERCENT_DEFAULT
    );
  }

  private stripeFeeConfig(): {
    stripeProcessingFeePercent: number;
    stripeProcessingFeeFixedMinor: number;
  } {
    const b = this.billing();
    return {
      stripeProcessingFeePercent: b.stripeProcessingFeePercent,
      stripeProcessingFeeFixedMinor: b.stripeProcessingFeeFixedMinor,
    };
  }

  private isCompleted(doc: {
    status?: string;
    processedKey?: string | null;
  }): boolean {
    if (doc.status === 'completed') return true;
    return Boolean(doc.processedKey?.trim());
  }

  async loadCommercialContext(jobId: string): Promise<CommercialWaveContext> {
    const doc = await this.videoJobModel.findOne({ jobId }).lean().exec();
    if (!doc) {
      throw new NotFoundException(`Video job not found: ${jobId}`);
    }
    if (doc.uploadSource !== 'studio') {
      throw new BadRequestException(
        'Only partner studio uploads support commercial flows',
      );
    }
    if (!this.isCompleted(doc)) {
      throw new BadRequestException(
        'Only completed videos support commercial flows',
      );
    }
    if (!doc.discoverPublishedAt) {
      throw new BadRequestException('Video must be published to discover');
    }
    const sessionId = doc.surfSessionId?.trim();
    if (!sessionId) {
      throw new BadRequestException('Video must belong to a surf session');
    }
    const session = await this.surfSessionModel
      .findOne({ sessionId })
      .lean()
      .exec();
    if (!session?.isCommercial) {
      throw new BadRequestException('Session is not commercial');
    }
    const partner = await this.partnerProfileModel
      .findOne({ userId: session.userId })
      .lean()
      .exec();
    const settings = resolveEffectiveCommercialSettings(session, partner);
    if (!settings) {
      throw new BadRequestException(
        'Commercial pricing is not configured for this session',
      );
    }
    return {
      job: doc,
      session: {
        sessionId: session.sessionId,
        userId: session.userId,
        countryCode: session.countryCode,
        regionId: session.regionId,
        spotId: session.spotId,
        isCommercial: session.isCommercial,
        commercialSettings:
          session.commercialSettings as CommercialSettings | null,
      },
      settings,
    };
  }

  /**
   * Build a Stripe Checkout Session for a buyer purchasing one or more waves
   * from the *same partner*. Persists a `pending` wave_unlock_orders row so
   * the webhook can later confirm/fulfill the order idempotently.
   */
  async createWaveOrderCheckout(
    input: CreateWaveOrderCheckoutInput,
  ): Promise<CreateWaveOrderCheckoutResult> {
    const billing = this.billing();
    if (!billing.appBaseUrl) {
      throw new InternalServerErrorException('APP_BASE_URL is not set');
    }
    const ids = [
      ...new Set(input.jobIds.map((id) => id.trim()).filter(Boolean)),
    ];
    if (ids.length === 0) {
      throw new BadRequestException('At least one video is required');
    }
    const intent: WaveUnlockOrderIntent =
      input.intent === 'sponsor' ? 'sponsor' : 'buy_claim';

    const contexts = await Promise.all(
      ids.map((id) => this.loadCommercialContext(id)),
    );

    const partnerUserId = contexts[0]!.session.userId;
    if (input.partnerUserId && input.partnerUserId !== partnerUserId) {
      throw new BadRequestException(
        'Items in a checkout must belong to the same partner',
      );
    }
    if (input.buyerUserId === partnerUserId) {
      throw new BadRequestException(
        "You can't buy your own session's waves",
      );
    }

    const settings = contexts[0]!.settings;
    const currency = settings.currency.toUpperCase();
    const stripeCurrency = currency.toLowerCase();
    for (const ctx of contexts) {
      if (ctx.session.userId !== partnerUserId) {
        throw new BadRequestException(
          'Items in a checkout must belong to the same partner',
        );
      }
      if (ctx.settings.currency.toUpperCase() !== currency) {
        throw new BadRequestException(
          'All items in a checkout must share the same currency',
        );
      }
      if (intent === 'buy_claim' && ctx.job.videoUnlockedForUserId?.trim()) {
        throw new ConflictException(
          `Video ${ctx.job.jobId} is already unlocked`,
        );
      }
    }

    let lineBreakdowns: CheckoutBreakdownWithDiscountMinor[];
    if (intent === 'sponsor') {
      // Sponsor is single-wave by definition; allowing multi-job here only
      // makes sense as N independent sponsor charges. We collapse them into
      // a single Checkout Session with one line per wave.
      const commissionPct = this.commissionPercent();
      const stripeFeeConfig = this.stripeFeeConfig();
      lineBreakdowns = contexts.map((ctx) => {
        const basePriceMinor = computeSponsorMinor(ctx.settings, 1);
        const checkout = computeCheckoutTotalMinor(
          basePriceMinor,
          commissionPct,
          stripeFeeConfig,
        );
        return {
          basePriceMinor,
          listPriceMinor: ctx.settings.videoPriceMinor,
          discountPercent: 0,
          discountSavedMinor: 0,
          commissionMinor: checkout.commissionMinor,
          stripeProcessingFeeMinor: checkout.stripeProcessingFeeMinor,
          totalMinor: checkout.totalMinor,
          commissionPercent: checkout.commissionPercent,
        };
      });
    } else {
      lineBreakdowns = allocateBuyClaimLineBreakdownsMinor(
        settings,
        ids.length,
        this.commissionPercent(),
        this.stripeFeeConfig(),
      );
    }

    const partnerSubtotalMinor = lineBreakdowns.reduce(
      (sum, line) => sum + line.basePriceMinor,
      0,
    );
    const platformCommissionMinor = lineBreakdowns.reduce(
      (sum, line) => sum + line.commissionMinor,
      0,
    );
    const totalAmountMinor = lineBreakdowns.reduce(
      (sum, line) => sum + line.totalMinor,
      0,
    );
    const applicationFeeMinor = Math.max(
      0,
      totalAmountMinor - partnerSubtotalMinor,
    );
    const discountPercent =
      intent === 'buy_claim'
        ? computeBuyClaimMinor(settings, ids.length).discountPercent
        : 0;

    const partnerProfile = await this.partnerProfileModel
      .findOne({ userId: partnerUserId })
      .select({
        stripeConnectAccountId: 1,
        stripeConnectPayoutsEnabled: 1,
        stripeConnectRequirementsDue: 1,
      })
      .lean()
      .exec();
    const stripeConnectAccountId =
      partnerProfile?.stripeConnectAccountId?.trim() ?? '';
    if (!stripeConnectAccountId) {
      throw new BadRequestException(
        'This partner has not connected Stripe — unlock is unavailable until they finish setup.',
      );
    }
    if (
      !partnerProfile?.stripeConnectPayoutsEnabled ||
      (partnerProfile.stripeConnectRequirementsDue?.length ?? 0) > 0
    ) {
      throw new BadRequestException(
        'This partner is still completing Stripe onboarding — unlock is temporarily unavailable.',
      );
    }

    const orderId = `ord_${randomUUID()}`;
    const buyerSeg = encodeURIComponent(input.buyerUserId);
    const base = billing.appBaseUrl;
    const successUrl = `${base}/${buyerSeg}/orders/return?session_id={CHECKOUT_SESSION_ID}&order_id=${orderId}`;
    const cancelUrl = `${base}/${buyerSeg}/orders/return?session_id={CHECKOUT_SESSION_ID}&order_id=${orderId}&canceled=1`;

    const productLabel =
      intent === 'sponsor'
        ? 'Sponsor a wave on Peakd'
        : 'Unlock a wave on Peakd';
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] =
      lineBreakdowns.map((line, idx) => {
        const jobId = ids[idx]!;
        return {
          price_data: {
            currency: stripeCurrency,
            unit_amount: line.totalMinor,
            product_data: {
              name: `${productLabel} (${jobId.slice(0, 8)})`,
            },
          },
          quantity: 1,
        };
      });

    // Destination charge: buyer pays the platform Checkout total; Stripe
    // immediately transfers the partner share to their Connect account and
    // leaves the platform commission on the platform balance.
    const paymentIntentData: Stripe.Checkout.SessionCreateParams.PaymentIntentData =
      {
        transfer_data: { destination: stripeConnectAccountId },
        ...(applicationFeeMinor > 0
          ? { application_fee_amount: applicationFeeMinor }
          : {}),
      };

    const stripeSession = await this.stripe().checkout.sessions.create({
      mode: 'payment',
      client_reference_id: orderId,
      success_url: successUrl,
      cancel_url: cancelUrl,
      line_items: lineItems,
      adaptive_pricing: { enabled: true },
      payment_intent_data: paymentIntentData,
      metadata: {
        orderId,
        buyerUserId: input.buyerUserId,
        partnerUserId,
        intent,
      },
    });
    if (!stripeSession.url) {
      throw new InternalServerErrorException(
        'Stripe did not return a checkout URL',
      );
    }

    await this.waveUnlockOrderModel.create({
      orderId,
      buyerUserId: input.buyerUserId,
      partnerUserId,
      currency,
      jobIds: ids,
      intent,
      partnerSubtotalMinor,
      platformCommissionMinor,
      totalAmountMinor,
      platformCommissionPercent: this.commissionPercent(),
      discountPercent,
      stripeCheckoutSessionId: stripeSession.id,
      stripePaymentIntentId: null,
      stripeBalanceTransactionId: null,
      stripeFeeMinor: null,
      stripeNetMinor: null,
      stripeCurrency: null,
      status: 'pending',
      failureReason: null,
      countryCode: contexts[0]!.session.countryCode,
      regionId: contexts[0]!.session.regionId,
      completedAt: null,
    });

    return { url: stripeSession.url, orderId };
  }

  /**
   * Idempotently fulfill a wave-unlock order from a `checkout.session.completed`
   * webhook event. Unlocks each wave in the order's `jobIds` and flips the
   * order to `completed`. Partner funds were already routed via the Checkout
   * destination charge — no internal balance is credited here. Safe to call
   * multiple times for the same Stripe session id.
   */
  async fulfillWaveOrder(
    stripeSession: Stripe.Checkout.Session,
  ): Promise<{ fulfilled: boolean; orderId: string | null }> {
    if (stripeSession.payment_status !== 'paid') {
      return { fulfilled: false, orderId: null };
    }
    const order = await this.waveUnlockOrderModel
      .findOne({ stripeCheckoutSessionId: stripeSession.id })
      .lean()
      .exec();
    if (!order) {
      this.logger.warn(
        `Stripe checkout.session.completed ${stripeSession.id} has no matching wave_unlock_orders row`,
      );
      return { fulfilled: false, orderId: null };
    }
    if (order.status === 'completed') {
      return { fulfilled: false, orderId: order.orderId };
    }

    const paymentIntentId =
      typeof stripeSession.payment_intent === 'string'
        ? stripeSession.payment_intent
        : stripeSession.payment_intent &&
            typeof stripeSession.payment_intent === 'object'
          ? (stripeSession.payment_intent as Stripe.PaymentIntent).id
          : null;
    const feeInfo = await this.resolveStripeFeeInfo(paymentIntentId);

    const unlockedAt = new Date();
    const unlockedAtIso = unlockedAt.toISOString();

    const mongoSession = await this.connection.startSession();
    mongoSession.startTransaction();
    try {
      // Flip status atomically so concurrent webhook retries can't both
      // proceed to the credit step.
      const claimed = await this.waveUnlockOrderModel
        .findOneAndUpdate(
          { orderId: order.orderId, status: 'pending' },
          {
            $set: {
              status: 'completed',
              completedAt: unlockedAt,
              stripePaymentIntentId: paymentIntentId,
              stripeBalanceTransactionId: feeInfo.balanceTransactionId,
              stripeFeeMinor: feeInfo.feeMinor,
              stripeNetMinor: feeInfo.netMinor,
              stripeCurrency: feeInfo.currency,
            },
          },
          { session: mongoSession, returnDocument: 'after' },
        )
        .lean()
        .exec();
      if (!claimed) {
        await mongoSession.abortTransaction();
        return { fulfilled: false, orderId: order.orderId };
      }

      // Unlock every wave covered by the order. For `sponsor`, beneficiary
      // is whoever currently has the claim (or sponsor) — same semantics as
      // the legacy sponsor flow, but consolidated here for simplicity: the
      // sponsor becomes the unlocker if there's no prior claimant.
      for (const jobId of order.jobIds) {
        await this.unlockJob(
          jobId,
          order.buyerUserId,
          order.intent,
          unlockedAtIso,
          mongoSession,
        );
      }

      await mongoSession.commitTransaction();
    } catch (err) {
      await mongoSession.abortTransaction();
      throw err;
    } finally {
      void mongoSession.endSession();
    }

    return { fulfilled: true, orderId: order.orderId };
  }

  private async unlockJob(
    jobId: string,
    buyerUserId: string,
    intent: WaveUnlockOrderIntent,
    unlockedAtIso: string,
    mongoSession: ClientSession,
  ): Promise<void> {
    if (intent === 'buy_claim') {
      const updated = await this.videoJobModel
        .updateOne(
          { jobId, videoUnlockedForUserId: null },
          {
            $set: {
              claimStatus: 'claimed',
              claimedAt: unlockedAtIso,
              claimedByUserId: buyerUserId,
              videoUnlockedForUserId: buyerUserId,
              videoUnlockedByUserId: buyerUserId,
              videoUnlockedAt: unlockedAtIso,
            },
          },
          { session: mongoSession },
        )
        .exec();
      if (updated.matchedCount === 0) {
        // Another order may have unlocked it for someone else between
        // checkout creation and webhook fulfillment. Log and continue —
        // the buyer's payment has cleared, but the wave is no longer
        // available to claim. The order row tracks this transaction so
        // admins/support can refund.
        this.logger.warn(
          `Job ${jobId} already unlocked when fulfilling order — skipping unlock`,
        );
      }
      return;
    }

    // Sponsor: target whoever currently has the claim, or the sponsor
    // themselves if no claimant. Skip when already unlocked.
    const doc = await this.videoJobModel
      .findOne({ jobId })
      .session(mongoSession)
      .lean()
      .exec();
    if (!doc) return;
    if (doc.videoUnlockedForUserId?.trim()) return;
    const claimedBy = doc.claimedByUserId?.trim() || null;
    const beneficiary =
      doc.claimStatus === 'claimed' && claimedBy ? claimedBy : buyerUserId;
    await this.videoJobModel
      .updateOne(
        { jobId, videoUnlockedForUserId: null },
        {
          $set: {
            videoUnlockedForUserId: beneficiary,
            videoUnlockedByUserId: buyerUserId,
            videoUnlockedAt: unlockedAtIso,
          },
        },
        { session: mongoSession },
      )
      .exec();
  }

  /**
   * Pulls the Stripe processing fee + net settled amount for a Checkout
   * charge so the order ledger can reconcile against the platform balance.
   */
  private async resolveStripeFeeInfo(
    paymentIntentId: string | null,
  ): Promise<{
    balanceTransactionId: string | null;
    feeMinor: number | null;
    netMinor: number | null;
    currency: string | null;
  }> {
    if (!paymentIntentId) {
      return {
        balanceTransactionId: null,
        feeMinor: null,
        netMinor: null,
        currency: null,
      };
    }
    try {
      const pi = await this.stripe().paymentIntents.retrieve(paymentIntentId, {
        expand: ['latest_charge.balance_transaction'],
      });
      const charge = pi.latest_charge;
      if (!charge || typeof charge === 'string') {
        return {
          balanceTransactionId: null,
          feeMinor: null,
          netMinor: null,
          currency: null,
        };
      }
      const bt = (charge as Stripe.Charge).balance_transaction;
      if (!bt || typeof bt === 'string') {
        return {
          balanceTransactionId: null,
          feeMinor: null,
          netMinor: null,
          currency: null,
        };
      }
      const txn = bt as Stripe.BalanceTransaction;
      return {
        balanceTransactionId: txn.id,
        feeMinor: typeof txn.fee === 'number' ? txn.fee : null,
        netMinor: typeof txn.net === 'number' ? txn.net : null,
        currency: (txn.currency ?? '').toLowerCase() || null,
      };
    } catch (err) {
      this.logger.warn(
        `Failed to retrieve Stripe BalanceTransaction for PI ${paymentIntentId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return {
        balanceTransactionId: null,
        feeMinor: null,
        netMinor: null,
        currency: null,
      };
    }
  }

  /**
   * Buyer-visible status for the Stripe Checkout return page poller. Only
   * the order's own buyer can read it; this guards against using the public
   * `session_id` to enumerate other users' orders.
   */
  async getOrderStatus(
    buyerUserId: string,
    orderId: string,
  ): Promise<WaveOrderStatusDto> {
    const order = await this.waveUnlockOrderModel
      .findOne({ orderId })
      .lean()
      .exec();
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (order.buyerUserId !== buyerUserId) {
      throw new NotFoundException('Order not found');
    }
    return {
      orderId: order.orderId,
      status: order.status,
      intent: order.intent,
      partnerUserId: order.partnerUserId,
      jobIds: order.jobIds,
      currency: order.currency,
      partnerSubtotalMinor: order.partnerSubtotalMinor,
      platformCommissionMinor: order.platformCommissionMinor,
      totalAmountMinor: order.totalAmountMinor,
      failureReason: order.failureReason ?? null,
      completedAt: order.completedAt ? order.completedAt.toISOString() : null,
    };
  }

  /**
   * Compute a per-line quote for a single-partner buy/sponsor flow without
   * persisting any state. Used by the cart UI (`/discover/cart/quote`) and
   * the wave-detail page to display prices and totals.
   */
  computeQuoteLines(
    settings: CommercialSettings,
    quantity: number,
    intent: WaveUnlockOrderIntent,
  ): CheckoutBreakdownWithDiscountMinor[] {
    if (intent === 'sponsor') {
      const commissionPct = this.commissionPercent();
      const stripeFeeConfig = this.stripeFeeConfig();
      return Array.from({ length: Math.max(1, quantity) }, () => {
        const basePriceMinor = settings.videoPriceMinor;
        const checkout = computeCheckoutTotalMinor(
          basePriceMinor,
          commissionPct,
          stripeFeeConfig,
        );
        return {
          basePriceMinor,
          listPriceMinor: settings.videoPriceMinor,
          discountPercent: 0,
          discountSavedMinor: 0,
          commissionMinor: checkout.commissionMinor,
          stripeProcessingFeeMinor: checkout.stripeProcessingFeeMinor,
          totalMinor: checkout.totalMinor,
          commissionPercent: checkout.commissionPercent,
        };
      });
    }
    return allocateBuyClaimLineBreakdownsMinor(
      settings,
      quantity,
      this.commissionPercent(),
      this.stripeFeeConfig(),
    );
  }

  /** Single-line price (intent agnostic) — used by feed extras. */
  computeSingleLineQuote(
    settings: CommercialSettings,
    intent: WaveUnlockOrderIntent,
  ): CheckoutBreakdownWithDiscountMinor {
    return this.computeQuoteLines(settings, 1, intent)[0]!;
  }
}
