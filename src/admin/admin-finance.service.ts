import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import Stripe from 'stripe';
import {
  BILLING_CONFIG_KEY,
  type BillingConfigValues,
} from '../config/billing.config';
import { WaveUnlockPurchase } from '../commercial/schemas/wave-unlock-purchase.schema';
import { PeakPurchase } from '../billing/schemas/peak-purchase.schema';
import { PartnerWithdrawal } from '../payouts/schemas/partner-withdrawal.schema';
import { UNDISCLOSED_REGION_ID_PATTERN } from '../studio/geo-undisclosed';
import { UserProfile } from '../users/schemas/user-profile.schema';

/**
 * Snapshot of the platform's financial state, denominated in EUR cents.
 *
 * All `*Cents` fields are EUR cents and the `peaksPerEuro` field gives the
 * conversion factor for Peaks-denominated totals (`*Peaks`).
 */
export type AdminFinanceOverviewDto = {
  /** ISO timestamp of the snapshot. */
  fetchedAt: string;
  peaksPerEuro: number;
  stripe: {
    /**
     * Funds Stripe has cleared into the platform's EUR balance and are
     * available to fund `transfers.create` calls right now.
     */
    availableEurCents: number;
    /**
     * Funds that have been charged but not yet cleared into the available
     * balance. New accounts typically see a 7-day pending window.
     */
    pendingEurCents: number;
    /** ISO codes of any non-EUR balances present (FX exposure check). */
    nonEurCurrencies: string[];
    /** Null if Stripe was unreachable; in that case the UI shows a warning. */
    error: string | null;
  };
  ledger: {
    /** Lifetime gross revenue from completed Peak-pack purchases (`totalAmountCents`). */
    totalRevenueCents: number;
    /**
     * Lifetime Stripe processing fees taken on completed Peak-pack
     * purchases. Only counts rows where `stripeFeeCents` was successfully
     * captured at webhook time (older rows pre-A1 are skipped).
     */
    totalStripeFeesCents: number;
    /** Count of `PeakPurchase` rows where `stripeFeeCents` is non-null. */
    purchasesWithFeeData: number;
    /** Count of completed purchases overall (regardless of fee data). */
    totalPurchases: number;
    /**
     * Total `partnerEarningsCents` currently sitting on `UserProfile`
     * documents — i.e. money owed to partners that they haven't withdrawn
     * yet. This is the platform's largest in-DB liability.
     */
    totalPartnerLiabilityCents: number;
    /** Lifetime sum of completed partner withdrawals. */
    totalPartnerPaidOutCents: number;
    /**
     * Lifetime platform retention (formerly "community fee") in Peaks,
     * across disclosed regions only. EUR equivalent is derived using the
     * current `peaksPerEuro` rate.
     */
    totalPlatformRetentionPeaks: number;
    totalPlatformRetentionEurCents: number;
  };
  derived: {
    /**
     * Best estimate of the platform's net margin over its lifetime:
     *   revenue − stripe fees − amounts already paid to partners
     *           − money still owed to partners (liability).
     *
     * This *intentionally* doesn't add platform retention back in: the
     * retention is collected from buyer Peaks (already paid for at Peak-pack
     * purchase time), so it's already part of `totalRevenueCents`.
     */
    netPlatformMarginCents: number;
    /**
     * `stripeAvailable - totalPartnerLiability`. When negative, a coordinated
     * partner mass-withdrawal would fail because the platform's Stripe EUR
     * balance can't cover what it owes. UI surfaces this as a red banner.
     */
    liabilityVsBalanceDeltaCents: number;
  };
};

@Injectable()
export class AdminFinanceService {
  private readonly logger = new Logger(AdminFinanceService.name);
  private stripeClient: Stripe | null = null;
  /**
   * Cache the Stripe balance for a minute so the admin dashboard can
   * comfortably poll without burning API requests. The endpoint is admin-only
   * and the data is intrinsically eventually-consistent.
   */
  private cachedBalance: {
    fetchedAt: number;
    available: number;
    pending: number;
    nonEurCurrencies: string[];
    error: string | null;
  } | null = null;
  private static readonly BALANCE_CACHE_MS = 60_000;

  constructor(
    private readonly config: ConfigService,
    @InjectModel(WaveUnlockPurchase.name)
    private readonly waveUnlockPurchaseModel: Model<WaveUnlockPurchase>,
    @InjectModel(PeakPurchase.name)
    private readonly peakPurchaseModel: Model<PeakPurchase>,
    @InjectModel(PartnerWithdrawal.name)
    private readonly partnerWithdrawalModel: Model<PartnerWithdrawal>,
    @InjectModel(UserProfile.name)
    private readonly userProfileModel: Model<UserProfile>,
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

  async getOverview(): Promise<AdminFinanceOverviewDto> {
    const billing = this.billing();
    const peaksPerEuro =
      billing.peaksPerEuro && billing.peaksPerEuro > 0
        ? billing.peaksPerEuro
        : 100;

    // Run all DB aggregations in parallel — they all hit different
    // collections and none of them depend on the Stripe API call.
    const [
      balanceSnapshot,
      revenueAgg,
      liabilityAgg,
      paidOutAgg,
      retentionAgg,
    ] = await Promise.all([
      this.getStripeBalance(),
      this.peakPurchaseModel
        .aggregate<{
          totalRevenueCents: number;
          totalStripeFeesCents: number;
          totalPurchases: number;
          purchasesWithFeeData: number;
        }>([
          { $match: { status: 'completed' } },
          {
            $group: {
              _id: null,
              totalRevenueCents: {
                $sum: { $ifNull: ['$totalAmountCents', 0] },
              },
              totalStripeFeesCents: {
                $sum: { $ifNull: ['$stripeFeeCents', 0] },
              },
              totalPurchases: { $sum: 1 },
              purchasesWithFeeData: {
                $sum: { $cond: [{ $ne: ['$stripeFeeCents', null] }, 1, 0] },
              },
            },
          },
        ])
        .exec(),
      this.userProfileModel
        .aggregate<{ total: number }>([
          {
            $group: {
              _id: null,
              total: { $sum: { $ifNull: ['$partnerEarningsCents', 0] } },
            },
          },
        ])
        .exec(),
      this.partnerWithdrawalModel
        .aggregate<{ total: number }>([
          { $match: { status: 'completed' } },
          {
            $group: {
              _id: null,
              total: { $sum: { $ifNull: ['$amountCents', 0] } },
            },
          },
        ])
        .exec(),
      this.waveUnlockPurchaseModel
        .aggregate<{ totalRetentionPeaks: number }>([
          {
            $group: {
              _id: null,
              totalRetentionPeaks: {
                $sum: {
                  $cond: [
                    {
                      $regexMatch: {
                        input: { $ifNull: ['$regionId', ''] },
                        regex: UNDISCLOSED_REGION_ID_PATTERN,
                      },
                    },
                    0,
                    {
                      // Prefer the new canonical field; fall back to the
                      // legacy one so historical rows are still summed.
                      $ifNull: [
                        '$platformRetentionPeaks',
                        { $ifNull: ['$communityFeePeaks', 0] },
                      ],
                    },
                  ],
                },
              },
            },
          },
        ])
        .exec(),
    ]);

    const revenue = revenueAgg[0] ?? {
      totalRevenueCents: 0,
      totalStripeFeesCents: 0,
      totalPurchases: 0,
      purchasesWithFeeData: 0,
    };
    const totalPartnerLiabilityCents = Math.max(
      0,
      liabilityAgg[0]?.total ?? 0,
    );
    const totalPartnerPaidOutCents = Math.max(0, paidOutAgg[0]?.total ?? 0);
    const totalPlatformRetentionPeaks = Math.max(
      0,
      retentionAgg[0]?.totalRetentionPeaks ?? 0,
    );
    const totalPlatformRetentionEurCents = Math.floor(
      (totalPlatformRetentionPeaks * 100) / peaksPerEuro,
    );

    const netPlatformMarginCents =
      revenue.totalRevenueCents -
      revenue.totalStripeFeesCents -
      totalPartnerPaidOutCents -
      totalPartnerLiabilityCents;
    const liabilityVsBalanceDeltaCents =
      balanceSnapshot.available - totalPartnerLiabilityCents;

    return {
      fetchedAt: new Date().toISOString(),
      peaksPerEuro,
      stripe: {
        availableEurCents: balanceSnapshot.available,
        pendingEurCents: balanceSnapshot.pending,
        nonEurCurrencies: balanceSnapshot.nonEurCurrencies,
        error: balanceSnapshot.error,
      },
      ledger: {
        totalRevenueCents: revenue.totalRevenueCents,
        totalStripeFeesCents: revenue.totalStripeFeesCents,
        purchasesWithFeeData: revenue.purchasesWithFeeData,
        totalPurchases: revenue.totalPurchases,
        totalPartnerLiabilityCents,
        totalPartnerPaidOutCents,
        totalPlatformRetentionPeaks,
        totalPlatformRetentionEurCents,
      },
      derived: {
        netPlatformMarginCents,
        liabilityVsBalanceDeltaCents,
      },
    };
  }

  /**
   * Cached Stripe balance fetch. Returns zeros + an `error` string on
   * Stripe outage so the dashboard can render with a banner instead of
   * 500ing the whole page.
   */
  private async getStripeBalance(): Promise<{
    available: number;
    pending: number;
    nonEurCurrencies: string[];
    error: string | null;
  }> {
    const now = Date.now();
    if (
      this.cachedBalance &&
      now - this.cachedBalance.fetchedAt < AdminFinanceService.BALANCE_CACHE_MS
    ) {
      const { available, pending, nonEurCurrencies, error } =
        this.cachedBalance;
      return { available, pending, nonEurCurrencies, error };
    }
    try {
      const balance = await this.stripe().balance.retrieve();
      const pickEur = (
        items: Stripe.Balance['available'] | Stripe.Balance['pending'],
      ): number =>
        (items ?? []).find((b) => (b.currency ?? '').toLowerCase() === 'eur')
          ?.amount ?? 0;
      const available = pickEur(balance.available);
      const pending = pickEur(balance.pending);
      const nonEur = new Set<string>();
      for (const bucket of [
        ...(balance.available ?? []),
        ...(balance.pending ?? []),
      ]) {
        const c = (bucket.currency ?? '').toLowerCase();
        if (c && c !== 'eur' && bucket.amount !== 0) nonEur.add(c);
      }
      const snapshot = {
        fetchedAt: now,
        available,
        pending,
        nonEurCurrencies: [...nonEur].sort(),
        error: null as string | null,
      };
      this.cachedBalance = snapshot;
      const { available: a, pending: p, nonEurCurrencies, error } = snapshot;
      return { available: a, pending: p, nonEurCurrencies, error };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to fetch Stripe balance: ${message}`);
      const snapshot = {
        fetchedAt: now,
        available: 0,
        pending: 0,
        nonEurCurrencies: [] as string[],
        error: message,
      };
      this.cachedBalance = snapshot;
      return {
        available: snapshot.available,
        pending: snapshot.pending,
        nonEurCurrencies: snapshot.nonEurCurrencies,
        error: snapshot.error,
      };
    }
  }
}
