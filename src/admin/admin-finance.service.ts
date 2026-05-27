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
import { WaveUnlockOrder } from '../commercial/schemas/wave-unlock-order.schema';
import { UNDISCLOSED_REGION_ID_PATTERN } from '../studio/geo-undisclosed';

/**
 * Snapshot of the platform's financial state, split per settlement currency.
 *
 * Every `*Minor` field is an integer in the minor unit of the row's
 * `currency`. The dashboard renders one card per currency.
 */
export type AdminFinanceCurrencyRowDto = {
  /** ISO 4217 currency code (uppercase for partner-facing, lowercase for stripe). */
  currency: string;
  stripe: {
    availableMinor: number;
    pendingMinor: number;
    error: string | null;
  };
  ledger: {
    /** Lifetime gross revenue across completed wave-unlock orders (`totalAmountMinor`). */
    totalRevenueMinor: number;
    /** Lifetime Stripe processing fees on completed wave-unlock orders. */
    totalStripeFeesMinor: number;
    /** Lifetime sum of `partnerSubtotalMinor` (transferred to partners at checkout). */
    totalPartnerSubtotalMinor: number;
    /** Lifetime platform fees earned (commission + Stripe-fee recovery). */
    totalPlatformCommissionMinor: number;
    /** Count of completed orders. */
    totalOrders: number;
    /** Always zero — partners are paid via Stripe destination charges. */
    totalPartnerLiabilityMinor: number;
    /** Same as gross partner subtotal (auto-transferred at checkout). */
    totalPartnerPaidOutMinor: number;
  };
  derived: {
    /** platform commission − Stripe fees. */
    netPlatformMarginMinor: number;
    /** Platform Stripe available balance in this currency. */
    liabilityVsBalanceDeltaMinor: number;
  };
};

export type AdminFinanceOverviewDto = {
  fetchedAt: string;
  platformCommissionPercent: number;
  rows: AdminFinanceCurrencyRowDto[];
  /** Set when the Stripe balance call failed. UI shows a banner. */
  stripeError: string | null;
};

@Injectable()
export class AdminFinanceService {
  private readonly logger = new Logger(AdminFinanceService.name);
  private stripeClient: Stripe | null = null;
  private cachedBalance: {
    fetchedAt: number;
    availableByCurrency: Map<string, number>;
    pendingByCurrency: Map<string, number>;
    error: string | null;
  } | null = null;
  private static readonly BALANCE_CACHE_MS = 60_000;

  constructor(
    private readonly config: ConfigService,
    @InjectModel(WaveUnlockOrder.name)
    private readonly waveUnlockOrderModel: Model<WaveUnlockOrder>,
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

    const [balanceSnapshot, revenueByCurrency] = await Promise.all([
      this.getStripeBalance(),
      this.aggregateRevenueByCurrency(),
    ]);

    const currencies = new Set<string>();
    for (const cur of revenueByCurrency.keys()) currencies.add(cur);
    for (const cur of balanceSnapshot.availableByCurrency.keys()) {
      currencies.add(cur);
    }

    const rows: AdminFinanceCurrencyRowDto[] = [];
    for (const cur of currencies) {
      const r = revenueByCurrency.get(cur) ?? {
        totalRevenueMinor: 0,
        totalStripeFeesMinor: 0,
        totalPartnerSubtotalMinor: 0,
        totalPlatformCommissionMinor: 0,
        totalOrders: 0,
      };
      const availableMinor =
        balanceSnapshot.availableByCurrency.get(cur) ?? 0;
      const pendingMinor = balanceSnapshot.pendingByCurrency.get(cur) ?? 0;
      // Partners are paid via destination charges at checkout — no internal
      // liability bucket. Platform margin is (app fee on charge) minus Stripe fees.
      const netPlatformMarginMinor =
        r.totalPlatformCommissionMinor - r.totalStripeFeesMinor;
      rows.push({
        currency: cur,
        stripe: {
          availableMinor,
          pendingMinor,
          error: balanceSnapshot.error,
        },
        ledger: {
          totalRevenueMinor: r.totalRevenueMinor,
          totalStripeFeesMinor: r.totalStripeFeesMinor,
          totalPartnerSubtotalMinor: r.totalPartnerSubtotalMinor,
          totalPlatformCommissionMinor: r.totalPlatformCommissionMinor,
          totalOrders: r.totalOrders,
          totalPartnerLiabilityMinor: 0,
          totalPartnerPaidOutMinor: r.totalPartnerSubtotalMinor,
        },
        derived: {
          netPlatformMarginMinor,
          liabilityVsBalanceDeltaMinor: availableMinor,
        },
      });
    }
    rows.sort((a, b) => a.currency.localeCompare(b.currency));

    return {
      fetchedAt: new Date().toISOString(),
      platformCommissionPercent: billing.platformCommissionPercent,
      rows,
      stripeError: balanceSnapshot.error,
    };
  }

  private async aggregateRevenueByCurrency(): Promise<
    Map<
      string,
      {
        totalRevenueMinor: number;
        totalStripeFeesMinor: number;
        totalPartnerSubtotalMinor: number;
        totalPlatformCommissionMinor: number;
        totalOrders: number;
      }
    >
  > {
    const rows = await this.waveUnlockOrderModel
      .aggregate<{
        _id: string;
        totalRevenueMinor: number;
        totalStripeFeesMinor: number;
        totalPartnerSubtotalMinor: number;
        totalPlatformCommissionMinor: number;
        totalOrders: number;
      }>([
        { $match: { status: 'completed' } },
        {
          $group: {
            _id: '$currency',
            totalRevenueMinor: {
              $sum: { $ifNull: ['$totalAmountMinor', 0] },
            },
            totalStripeFeesMinor: {
              $sum: { $ifNull: ['$stripeFeeMinor', 0] },
            },
            totalPartnerSubtotalMinor: {
              $sum: { $ifNull: ['$partnerSubtotalMinor', 0] },
            },
            totalPlatformCommissionMinor: {
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
                    $subtract: [
                      { $ifNull: ['$totalAmountMinor', 0] },
                      { $ifNull: ['$partnerSubtotalMinor', 0] },
                    ],
                  },
                ],
              },
            },
            totalOrders: { $sum: 1 },
          },
        },
      ])
      .exec();
    const out = new Map<
      string,
      {
        totalRevenueMinor: number;
        totalStripeFeesMinor: number;
        totalPartnerSubtotalMinor: number;
        totalPlatformCommissionMinor: number;
        totalOrders: number;
      }
    >();
    for (const row of rows) {
      out.set(row._id, {
        totalRevenueMinor: row.totalRevenueMinor,
        totalStripeFeesMinor: row.totalStripeFeesMinor,
        totalPartnerSubtotalMinor: row.totalPartnerSubtotalMinor,
        totalPlatformCommissionMinor: row.totalPlatformCommissionMinor,
        totalOrders: row.totalOrders,
      });
    }
    return out;
  }

  /**
   * Cached Stripe balance fetch. Returns empty maps + an `error` string on
   * Stripe outage so the dashboard renders with a banner instead of 500ing.
   */
  private async getStripeBalance(): Promise<{
    availableByCurrency: Map<string, number>;
    pendingByCurrency: Map<string, number>;
    error: string | null;
  }> {
    const now = Date.now();
    if (
      this.cachedBalance &&
      now - this.cachedBalance.fetchedAt < AdminFinanceService.BALANCE_CACHE_MS
    ) {
      return {
        availableByCurrency: this.cachedBalance.availableByCurrency,
        pendingByCurrency: this.cachedBalance.pendingByCurrency,
        error: this.cachedBalance.error,
      };
    }
    try {
      const balance = await this.stripe().balance.retrieve();
      const availableByCurrency = new Map<string, number>();
      for (const bucket of balance.available ?? []) {
        const cur = (bucket.currency ?? '').toUpperCase();
        if (!cur) continue;
        availableByCurrency.set(
          cur,
          (availableByCurrency.get(cur) ?? 0) + (bucket.amount ?? 0),
        );
      }
      const pendingByCurrency = new Map<string, number>();
      for (const bucket of balance.pending ?? []) {
        const cur = (bucket.currency ?? '').toUpperCase();
        if (!cur) continue;
        pendingByCurrency.set(
          cur,
          (pendingByCurrency.get(cur) ?? 0) + (bucket.amount ?? 0),
        );
      }
      this.cachedBalance = {
        fetchedAt: now,
        availableByCurrency,
        pendingByCurrency,
        error: null,
      };
      return { availableByCurrency, pendingByCurrency, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to fetch Stripe balance: ${message}`);
      this.cachedBalance = {
        fetchedAt: now,
        availableByCurrency: new Map(),
        pendingByCurrency: new Map(),
        error: message,
      };
      return {
        availableByCurrency: new Map(),
        pendingByCurrency: new Map(),
        error: message,
      };
    }
  }
}
