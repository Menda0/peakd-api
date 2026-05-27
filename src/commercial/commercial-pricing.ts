/**
 * Commercial wave-unlock pricing — fiat / minor-unit math.
 *
 * Money flow on a single unlock (Stripe destination charge):
 *
 *   buyer pays  (partnerSubtotalMinor + platformCommissionMinor + stripeFeeMinor)
 *                │
 *                ├── partnerSubtotalMinor → transferred immediately to the
 *                │                        partner's Stripe Connect account
 *                │
 *                └── (platformCommissionMinor + stripeFeeMinor)
 *                                         → kept on the platform balance, then
 *                                           Stripe deducts processing fees
 *
 * The commission is a flat 20% surcharge on top of the partner-defined
 * `videoPriceMinor` (after any volume discount). Checkout totals are then
 * grossed up for Stripe fees so partner payout + commission targets remain
 * intact after processing fees.
 */
import { BadRequestException } from '@nestjs/common';
import type {
  CommercialSettings,
  VolumeDiscountTier,
} from './commercial-settings.types';
import { isSupportedCurrency } from './commercial-settings.types';

const MIN_VIDEO_PRICE = 1;
const MAX_VIDEO_PRICE = 100_000_000; // generous cap: 1,000,000.00 in any 2-decimal currency
const MAX_DISCOUNT_PERCENT = 90;
const MIN_TIER_VIDEOS = 2;

export function normalizeVolumeDiscounts(raw: unknown): VolumeDiscountTier[] {
  if (!Array.isArray(raw)) return [];
  const tiers: VolumeDiscountTier[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const o = row as Record<string, unknown>;
    const minVideos = Number(o.minVideos);
    const discountPercent = Number(o.discountPercent);
    if (
      !Number.isFinite(minVideos) ||
      !Number.isInteger(minVideos) ||
      minVideos < MIN_TIER_VIDEOS
    ) {
      continue;
    }
    if (
      !Number.isFinite(discountPercent) ||
      discountPercent < 0 ||
      discountPercent > MAX_DISCOUNT_PERCENT
    ) {
      continue;
    }
    tiers.push({ minVideos, discountPercent });
  }
  tiers.sort((a, b) => a.minVideos - b.minVideos);
  const seen = new Set<number>();
  const unique: VolumeDiscountTier[] = [];
  for (const t of tiers) {
    if (seen.has(t.minVideos)) continue;
    seen.add(t.minVideos);
    unique.push(t);
  }
  return unique;
}

export function parseCommercialSettings(
  raw: unknown,
): CommercialSettings | null {
  if (raw == null) return null;
  if (typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const currencyRaw =
    typeof o.currency === 'string' ? o.currency.toUpperCase() : '';
  if (!currencyRaw || !isSupportedCurrency(currencyRaw)) {
    return null;
  }
  const videoPriceMinor = Number(o.videoPriceMinor);
  if (
    !Number.isFinite(videoPriceMinor) ||
    !Number.isInteger(videoPriceMinor) ||
    videoPriceMinor < MIN_VIDEO_PRICE ||
    videoPriceMinor > MAX_VIDEO_PRICE
  ) {
    return null;
  }
  return {
    currency: currencyRaw,
    videoPriceMinor,
    volumeDiscounts: normalizeVolumeDiscounts(o.volumeDiscounts),
  };
}

export function validateCommercialSettings(
  settings: CommercialSettings | null,
  options?: { required?: boolean },
): CommercialSettings | null {
  if (settings == null) {
    if (options?.required) {
      throw new BadRequestException('Commercial pricing is required');
    }
    return null;
  }
  const parsed = parseCommercialSettings(settings);
  if (!parsed) {
    throw new BadRequestException('Invalid commercial pricing settings');
  }
  return parsed;
}

export function resolveEffectiveCommercialSettings(
  session: {
    commercialSettings?: CommercialSettings | null;
    isCommercial?: boolean;
  },
  partner: { commercialSettings?: CommercialSettings | null } | null,
): CommercialSettings | null {
  if (!session.isCommercial) return null;
  const sessionSettings = session.commercialSettings
    ? parseCommercialSettings(session.commercialSettings)
    : null;
  if (sessionSettings) return sessionSettings;
  if (!partner) return null;
  return parseCommercialSettings(partner.commercialSettings);
}

export function volumeDiscountPercent(
  quantity: number,
  tiers: VolumeDiscountTier[],
): number {
  if (quantity < 1 || tiers.length === 0) return 0;
  let best = 0;
  for (const tier of tiers) {
    if (quantity >= tier.minVideos && tier.discountPercent > best) {
      best = tier.discountPercent;
    }
  }
  return best;
}

export function computeBuyClaimMinor(
  settings: CommercialSettings,
  quantity: number,
): {
  unitPriceMinor: number;
  discountPercent: number;
  totalMinor: number;
} {
  const q = Math.max(1, Math.floor(quantity));
  const unitPriceMinor = settings.videoPriceMinor;
  const discountPercent = volumeDiscountPercent(q, settings.volumeDiscounts);
  const subtotal = unitPriceMinor * q;
  const totalMinor = Math.max(
    1,
    Math.round(subtotal * (1 - discountPercent / 100)),
  );
  return { unitPriceMinor, discountPercent, totalMinor };
}

export function computeSponsorMinor(
  settings: CommercialSettings,
  quantity = 1,
): number {
  const q = Math.max(1, Math.floor(quantity));
  return settings.videoPriceMinor * q;
}

/**
 * Flat platform commission percent charged on top of the partner's
 * `videoPriceMinor` (after volume discount) at checkout.
 */
export const PLATFORM_COMMISSION_PERCENT_DEFAULT = 20;
export const STRIPE_PROCESSING_FEE_PERCENT_DEFAULT = 2.9;
export const STRIPE_PROCESSING_FEE_FIXED_MINOR_DEFAULT = 30;

export type StripeProcessingFeeConfig = {
  stripeProcessingFeePercent?: number;
  stripeProcessingFeeFixedMinor?: number;
};

export type CheckoutBreakdownMinor = {
  basePriceMinor: number;
  commissionMinor: number;
  stripeProcessingFeeMinor: number;
  totalMinor: number;
  commissionPercent: number;
};

export function computeCheckoutTotalMinor(
  basePriceMinor: number,
  commissionPercent: number = PLATFORM_COMMISSION_PERCENT_DEFAULT,
  stripeConfig?: StripeProcessingFeeConfig,
): CheckoutBreakdownMinor {
  const base = Math.max(0, Math.round(basePriceMinor));
  const pct = Math.max(0, commissionPercent);
  const stripePct = Math.max(
    0,
    stripeConfig?.stripeProcessingFeePercent ??
      STRIPE_PROCESSING_FEE_PERCENT_DEFAULT,
  );
  const stripeFixed = Math.max(
    0,
    Math.round(
      stripeConfig?.stripeProcessingFeeFixedMinor ??
        STRIPE_PROCESSING_FEE_FIXED_MINOR_DEFAULT,
    ),
  );
  const commission = base > 0
    ? Math.max(1, Math.round((base * pct) / 100))
    : 0;
  const targetNet = base + commission;
  const stripeFeeForTotal = (amountMinor: number): number => {
    if (amountMinor <= 0) return 0;
    return Math.max(0, Math.round((amountMinor * stripePct) / 100) + stripeFixed);
  };
  let total = targetNet;
  // Fixed-point iteration to gross up the checkout total so Stripe fees are
  // passed to the buyer while partner base payout + platform commission stay intact.
  for (let i = 0; i < 8; i += 1) {
    const fee = stripeFeeForTotal(total);
    const next = targetNet + fee;
    if (next <= total) break;
    total = next;
  }
  const stripeProcessingFeeMinor = Math.max(0, total - targetNet);
  return {
    basePriceMinor: base,
    commissionMinor: commission,
    stripeProcessingFeeMinor,
    totalMinor: total,
    commissionPercent: pct,
  };
}

export type CheckoutBreakdownWithDiscountMinor = CheckoutBreakdownMinor & {
  listPriceMinor: number;
  discountPercent: number;
  discountSavedMinor: number;
};

export function checkoutBreakdownWithDiscountMinor(
  basePriceMinor: number,
  listPriceMinor: number,
  discountPercent: number,
  commissionPercent: number = PLATFORM_COMMISSION_PERCENT_DEFAULT,
  stripeConfig?: StripeProcessingFeeConfig,
): CheckoutBreakdownWithDiscountMinor {
  const checkout = computeCheckoutTotalMinor(
    basePriceMinor,
    commissionPercent,
    stripeConfig,
  );
  const list = Math.max(0, Math.round(listPriceMinor));
  return {
    ...checkout,
    listPriceMinor: list,
    discountPercent: Math.max(0, Math.round(discountPercent)),
    discountSavedMinor: Math.max(0, list - checkout.basePriceMinor),
  };
}

/** Split a total into `parts` whole amounts that sum exactly to `total`. */
export function splitIntegerTotal(total: number, parts: number): number[] {
  const n = Math.max(1, Math.floor(parts));
  const sum = Math.max(0, Math.round(total));
  const base = Math.floor(sum / n);
  let remainder = sum - base * n;
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const extra = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder -= 1;
    out.push(base + extra);
  }
  return out;
}

/**
 * Per-wave checkout lines for buy & claim when purchasing `waveCount` waves
 * from the same session (volume discount applies to the batch count).
 */
export function allocateBuyClaimLineBreakdownsMinor(
  settings: CommercialSettings,
  waveCount: number,
  commissionPercent: number = PLATFORM_COMMISSION_PERCENT_DEFAULT,
  stripeConfig?: StripeProcessingFeeConfig,
): CheckoutBreakdownWithDiscountMinor[] {
  const q = Math.max(1, Math.floor(waveCount));
  const {
    unitPriceMinor,
    discountPercent,
    totalMinor: discountedBaseTotal,
  } = computeBuyClaimMinor(settings, q);
  const baseShares = splitIntegerTotal(discountedBaseTotal, q);
  return baseShares.map((basePriceMinor) =>
    checkoutBreakdownWithDiscountMinor(
      basePriceMinor,
      unitPriceMinor,
      discountPercent,
      commissionPercent,
      stripeConfig,
    ),
  );
}
