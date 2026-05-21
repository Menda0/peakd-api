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

export const COMMUNITY_FEE_PERCENT = 20;

export type CheckoutPeaksBreakdown = {
  basePeaks: number;
  communityFeePeaks: number;
  totalPeaks: number;
  communityFeePercent: number;
};

export function computeCheckoutTotal(basePeaks: number): CheckoutPeaksBreakdown {
  const base = Math.max(0, Math.round(basePeaks));
  const communityFeePeaks = Math.max(
    1,
    Math.round((base * COMMUNITY_FEE_PERCENT) / 100),
  );
  return {
    basePeaks: base,
    communityFeePeaks,
    totalPeaks: base + communityFeePeaks,
    communityFeePercent: COMMUNITY_FEE_PERCENT,
  };
}
