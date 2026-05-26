import {
  allocateBuyClaimLineBreakdowns,
  computeBuyClaimPeaks,
  computeCheckoutTotal,
  computeSponsorPeaks,
  resolveEffectiveCommercialSettings,
  volumeDiscountPercent,
} from './commercial-pricing';
import { DEFAULT_VOLUME_DISCOUNTS } from './commercial-settings.types';

describe('commercial-pricing', () => {
  const settings = {
    videoPricePeaks: 100,
    volumeDiscounts: DEFAULT_VOLUME_DISCOUNTS,
  };

  it('resolves session override over partner defaults', () => {
    const sessionOverride = { videoPricePeaks: 80, volumeDiscounts: [] };
    const effective = resolveEffectiveCommercialSettings(
      { isCommercial: true, commercialSettings: sessionOverride },
      { commercialSettings: settings },
    );
    expect(effective?.videoPricePeaks).toBe(80);
  });

  it('falls back to partner defaults when session has no override', () => {
    const effective = resolveEffectiveCommercialSettings(
      { isCommercial: true, commercialSettings: null },
      { commercialSettings: settings },
    );
    expect(effective?.videoPricePeaks).toBe(100);
  });

  it('returns null when session is not commercial', () => {
    const effective = resolveEffectiveCommercialSettings(
      { isCommercial: false, commercialSettings: settings },
      { commercialSettings: settings },
    );
    expect(effective).toBeNull();
  });

  it('applies volume discount tiers for buy and claim', () => {
    expect(volumeDiscountPercent(1, settings.volumeDiscounts)).toBe(0);
    expect(volumeDiscountPercent(3, settings.volumeDiscounts)).toBe(10);
    expect(volumeDiscountPercent(10, settings.volumeDiscounts)).toBe(20);
    const priced = computeBuyClaimPeaks(settings, 10);
    expect(priced.discountPercent).toBe(20);
    expect(priced.totalPeaks).toBe(800);
  });

  it('charges full price per wave for sponsor without tiers', () => {
    expect(computeSponsorPeaks(settings, 1)).toBe(100);
    expect(computeSponsorPeaks(settings, 2)).toBe(200);
  });

  it('allocates per-wave lines that sum to session buy-claim total', () => {
    const lines = allocateBuyClaimLineBreakdowns(settings, 3);
    expect(lines).toHaveLength(3);
    expect(lines[0]?.discountPercent).toBe(10);
    expect(lines.every((l) => l.listPricePeaks === 100)).toBe(true);
    const baseSum = lines.reduce((s, l) => s + l.basePeaks, 0);
    expect(baseSum).toBe(270);
    const totalSum = lines.reduce((s, l) => s + l.totalPeaks, 0);
    expect(totalSum).toBeGreaterThan(baseSum);
  });

  it('adds 20% platform retention (legacy: community fee) on checkout total', () => {
    expect(computeCheckoutTotal(50)).toEqual({
      basePeaks: 50,
      communityFeePeaks: 10,
      platformRetentionPeaks: 10,
      totalPeaks: 60,
      communityFeePercent: 20,
      platformRetentionPercent: 20,
    });
  });

  it('waives platform retention for undisclosed locations', () => {
    expect(computeCheckoutTotal(50, { waiveCommunityFee: true })).toEqual({
      basePeaks: 50,
      communityFeePeaks: 0,
      platformRetentionPeaks: 0,
      totalPeaks: 50,
      communityFeePercent: 20,
      platformRetentionPercent: 20,
    });
    const lines = allocateBuyClaimLineBreakdowns(settings, 2, {
      waiveCommunityFee: true,
    });
    expect(lines.every((l) => l.communityFeePeaks === 0)).toBe(true);
    expect(lines.reduce((s, l) => s + l.totalPeaks, 0)).toBe(
      lines.reduce((s, l) => s + l.basePeaks, 0),
    );
  });

  it('dual-writes platformRetentionPeaks alongside communityFeePeaks', () => {
    const breakdown = computeCheckoutTotal(100);
    expect(breakdown.communityFeePeaks).toBe(breakdown.platformRetentionPeaks);
    expect(breakdown.communityFeePercent).toBe(
      breakdown.platformRetentionPercent,
    );
  });
});
