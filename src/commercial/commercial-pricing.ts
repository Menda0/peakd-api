/**
 * Commercial wave-unlock pricing.
 *
 * Money flow on a single unlock:
 *
 *   buyer pays  (basePeaks + platformRetentionPeaks)  ──┐
 *                                                       │
 *                ┌── basePeaks  →  partnerEarningsCents (EUR, withdrawable)
 *                │
 *                └── platformRetentionPeaks  →  burned from circulation
 *                                                (no credit to any account)
 *
 * The retention Peaks are deliberately *not* held as a per-region or
 * per-community liability. Their fiat equivalent sits in the platform's
 * Stripe balance and is used at the admin's discretion to fund community
 * awards, ops, infrastructure, etc. Historically this surcharge was named
 * "community fee" because that was the dominant intended use, but the
 * payout to communities has always been discretionary, not automatic.
 *
 * Field-name conventions:
 *   - `communityFeePeaks` / `communityFeePercent` — legacy field names
 *     preserved on the DB ledger + API DTOs for backwards compatibility.
 *   - `platformRetentionPeaks` / `platformRetentionPercent` — canonical
 *     names introduced alongside; new code should prefer these.
 */
import { BadRequestException } from '@nestjs/common';
import type { CommercialSettings, VolumeDiscountTier } from './commercial-settings.types';

const MIN_VIDEO_PRICE = 1;
const MAX_VIDEO_PRICE = 1_000_000;
const MAX_DISCOUNT_PERCENT = 90;
const MIN_TIER_VIDEOS = 2;

export function normalizeVolumeDiscounts(
  raw: unknown,
): VolumeDiscountTier[] {
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

export function parseCommercialSettings(raw: unknown): CommercialSettings | null {
  if (raw == null) return null;
  if (typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const videoPricePeaks = Number(o.videoPricePeaks);
  if (
    !Number.isFinite(videoPricePeaks) ||
    !Number.isInteger(videoPricePeaks) ||
    videoPricePeaks < MIN_VIDEO_PRICE ||
    videoPricePeaks > MAX_VIDEO_PRICE
  ) {
    return null;
  }
  return {
    videoPricePeaks,
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
  session: { commercialSettings?: CommercialSettings | null; isCommercial?: boolean },
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

export function computeBuyClaimPeaks(
  settings: CommercialSettings,
  quantity: number,
): { unitPricePeaks: number; discountPercent: number; totalPeaks: number } {
  const q = Math.max(1, Math.floor(quantity));
  const unitPricePeaks = settings.videoPricePeaks;
  const discountPercent = volumeDiscountPercent(q, settings.volumeDiscounts);
  const subtotal = unitPricePeaks * q;
  const totalPeaks = Math.max(
    1,
    Math.round(subtotal * (1 - discountPercent / 100)),
  );
  return { unitPricePeaks, discountPercent, totalPeaks };
}

export function computeSponsorPeaks(
  settings: CommercialSettings,
  quantity = 1,
): number {
  const q = Math.max(1, Math.floor(quantity));
  return settings.videoPricePeaks * q;
}

/**
 * Surcharge percent the platform retains on each wave unlock, on top of the
 * `basePeaks` price that's converted into partner earnings.
 *
 * Policy: this Peaks amount is debited from the buyer at unlock time but
 * **credited to nobody** — the fiat equivalent stays in the platform's
 * Stripe balance as operational retention. It is used at the admin's
 * discretion to fund community / region awards, but it is *not* held as a
 * per-region liability and no automatic payout pipeline drains it.
 *
 * The legacy name `COMMUNITY_FEE_PERCENT` is preserved as an alias so
 * existing imports continue to compile during the rename.
 */
export const PLATFORM_RETENTION_PERCENT = 20;

/** @deprecated Use {@link PLATFORM_RETENTION_PERCENT}. */
export const COMMUNITY_FEE_PERCENT = PLATFORM_RETENTION_PERCENT;

export type CheckoutPeaksBreakdown = {
  basePeaks: number;
  /** Legacy field — same value as `platformRetentionPeaks`. */
  communityFeePeaks: number;
  /** Canonical name for the retention Peaks. Equal to `communityFeePeaks`. */
  platformRetentionPeaks: number;
  totalPeaks: number;
  /** Legacy field — same value as `platformRetentionPercent`. */
  communityFeePercent: number;
  platformRetentionPercent: number;
};

export type CheckoutOptions = {
  /**
   * When true, no platform retention is charged (undisclosed locations).
   * Historically named `waiveCommunityFee` — kept as the field name for
   * backwards compatibility with existing call sites.
   */
  waiveCommunityFee?: boolean;
};

export function computeCheckoutTotal(
  basePeaks: number,
  options?: CheckoutOptions,
): CheckoutPeaksBreakdown {
  const base = Math.max(0, Math.round(basePeaks));
  if (options?.waiveCommunityFee) {
    return {
      basePeaks: base,
      communityFeePeaks: 0,
      platformRetentionPeaks: 0,
      totalPeaks: base,
      communityFeePercent: PLATFORM_RETENTION_PERCENT,
      platformRetentionPercent: PLATFORM_RETENTION_PERCENT,
    };
  }
  const retentionPeaks = Math.max(
    1,
    Math.round((base * PLATFORM_RETENTION_PERCENT) / 100),
  );
  return {
    basePeaks: base,
    communityFeePeaks: retentionPeaks,
    platformRetentionPeaks: retentionPeaks,
    totalPeaks: base + retentionPeaks,
    communityFeePercent: PLATFORM_RETENTION_PERCENT,
    platformRetentionPercent: PLATFORM_RETENTION_PERCENT,
  };
}

export type CheckoutBreakdownWithDiscount = CheckoutPeaksBreakdown & {
  listPricePeaks: number;
  discountPercent: number;
  discountPeaksSaved: number;
};

export function checkoutBreakdownWithDiscount(
  basePeaks: number,
  listPricePeaks: number,
  discountPercent: number,
  options?: CheckoutOptions,
): CheckoutBreakdownWithDiscount {
  const checkout = computeCheckoutTotal(basePeaks, options);
  const list = Math.max(0, Math.round(listPricePeaks));
  const base = Math.max(0, Math.round(basePeaks));
  return {
    ...checkout,
    listPricePeaks: list,
    discountPercent: Math.max(0, Math.round(discountPercent)),
    discountPeaksSaved: Math.max(0, list - base),
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
 * Per-wave checkout lines for buy & claim when purchasing `waveCount` waves from the
 * same session (volume discount applies to the batch count).
 */
export function allocateBuyClaimLineBreakdowns(
  settings: CommercialSettings,
  waveCount: number,
  options?: CheckoutOptions,
): CheckoutBreakdownWithDiscount[] {
  const q = Math.max(1, Math.floor(waveCount));
  const { unitPricePeaks, discountPercent, totalPeaks: discountedBaseTotal } =
    computeBuyClaimPeaks(settings, q);
  const baseShares = splitIntegerTotal(discountedBaseTotal, q);
  return baseShares.map((basePeaks) =>
    checkoutBreakdownWithDiscount(
      basePeaks,
      unitPricePeaks,
      discountPercent,
      options,
    ),
  );
}
