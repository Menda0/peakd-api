import {
  allocateBuyClaimLineBreakdownsMinor,
  checkoutBreakdownWithDiscountMinor,
  computeBuyClaimMinor,
  computeCheckoutTotalMinor,
  computeSponsorMinor,
  isCommercialVideoUnlockedForViewer,
  normalizeVolumeDiscounts,
  parseCommercialSettings,
  PLATFORM_COMMISSION_PERCENT_DEFAULT,
  STRIPE_PROCESSING_FEE_FIXED_MINOR_DEFAULT,
  STRIPE_PROCESSING_FEE_PERCENT_DEFAULT,
  resolveEffectiveCommercialSettings,
  splitIntegerTotal,
  validateCommercialSettings,
  volumeDiscountPercent,
} from './commercial-pricing';
import type { CommercialSettings } from './commercial-settings.types';

const eur = (cents: number, volumeDiscounts: CommercialSettings['volumeDiscounts'] = []) => ({
  currency: 'EUR',
  videoPriceMinor: cents,
  volumeDiscounts,
});

describe('parseCommercialSettings', () => {
  it('returns null for non-objects', () => {
    expect(parseCommercialSettings(null)).toBeNull();
    expect(parseCommercialSettings('foo')).toBeNull();
    expect(parseCommercialSettings(42)).toBeNull();
  });

  it('rejects unsupported currencies', () => {
    expect(
      parseCommercialSettings({ currency: 'xyz', videoPriceMinor: 500 }),
    ).toBeNull();
  });

  it('rejects non-integer or negative prices', () => {
    expect(
      parseCommercialSettings({ currency: 'usd', videoPriceMinor: 0 }),
    ).toBeNull();
    expect(
      parseCommercialSettings({ currency: 'usd', videoPriceMinor: 12.5 }),
    ).toBeNull();
  });

  it('uppercases the currency and normalizes discounts', () => {
    const parsed = parseCommercialSettings({
      currency: 'eur',
      videoPriceMinor: 500,
      volumeDiscounts: [
        { minVideos: 2, discountPercent: 10 },
        { minVideos: 2, discountPercent: 30 }, // duplicate minVideos dropped
        { minVideos: 5, discountPercent: 25 },
        { minVideos: 1, discountPercent: 50 }, // below min tier — dropped
      ],
    });
    expect(parsed).toEqual({
      currency: 'EUR',
      videoPriceMinor: 500,
      volumeDiscounts: [
        { minVideos: 2, discountPercent: 10 },
        { minVideos: 5, discountPercent: 25 },
      ],
    });
  });
});

describe('validateCommercialSettings', () => {
  it('throws if required and missing', () => {
    expect(() =>
      validateCommercialSettings(null, { required: true }),
    ).toThrow(/required/i);
  });

  it('throws if invalid', () => {
    expect(() =>
      validateCommercialSettings({
        currency: 'EUR',
        videoPriceMinor: -1,
        volumeDiscounts: [],
      }),
    ).toThrow(/invalid/i);
  });

  it('returns parsed settings when valid', () => {
    const result = validateCommercialSettings({
      currency: 'eur',
      videoPriceMinor: 500,
      volumeDiscounts: [],
    });
    expect(result?.currency).toBe('EUR');
  });
});

describe('resolveEffectiveCommercialSettings', () => {
  it('returns null when session is not commercial', () => {
    expect(
      resolveEffectiveCommercialSettings(
        { isCommercial: false, commercialSettings: eur(500) },
        { commercialSettings: eur(900) },
      ),
    ).toBeNull();
  });

  it('prefers session override over partner default', () => {
    const r = resolveEffectiveCommercialSettings(
      { isCommercial: true, commercialSettings: eur(700) },
      { commercialSettings: eur(900) },
    );
    expect(r?.videoPriceMinor).toBe(700);
  });

  it('falls back to partner default', () => {
    const r = resolveEffectiveCommercialSettings(
      { isCommercial: true, commercialSettings: null },
      { commercialSettings: eur(900) },
    );
    expect(r?.videoPriceMinor).toBe(900);
  });
});

describe('normalizeVolumeDiscounts', () => {
  it('clamps obviously bogus rows', () => {
    expect(
      normalizeVolumeDiscounts([
        { minVideos: 2, discountPercent: 10 },
        { minVideos: 2, discountPercent: 0 },
        { minVideos: 'bad', discountPercent: 30 },
        { minVideos: 4, discountPercent: 91 }, // > MAX_DISCOUNT_PERCENT
        { minVideos: 4, discountPercent: 20 },
        null,
      ]),
    ).toEqual([
      { minVideos: 2, discountPercent: 10 },
      { minVideos: 4, discountPercent: 20 },
    ]);
  });
});

describe('volumeDiscountPercent', () => {
  it('picks the highest tier applicable to the quantity', () => {
    const tiers = [
      { minVideos: 2, discountPercent: 10 },
      { minVideos: 5, discountPercent: 25 },
      { minVideos: 10, discountPercent: 40 },
    ];
    expect(volumeDiscountPercent(1, tiers)).toBe(0);
    expect(volumeDiscountPercent(2, tiers)).toBe(10);
    expect(volumeDiscountPercent(4, tiers)).toBe(10);
    expect(volumeDiscountPercent(5, tiers)).toBe(25);
    expect(volumeDiscountPercent(9, tiers)).toBe(25);
    expect(volumeDiscountPercent(10, tiers)).toBe(40);
    expect(volumeDiscountPercent(1000, tiers)).toBe(40);
  });
});

describe('computeBuyClaimMinor', () => {
  it('returns the unit price for quantity 1', () => {
    const r = computeBuyClaimMinor(eur(500), 1);
    expect(r).toEqual({
      unitPriceMinor: 500,
      discountPercent: 0,
      totalMinor: 500,
    });
  });

  it('applies the best applicable discount', () => {
    const r = computeBuyClaimMinor(
      eur(500, [{ minVideos: 3, discountPercent: 20 }]),
      3,
    );
    expect(r.discountPercent).toBe(20);
    expect(r.totalMinor).toBe(Math.round(500 * 3 * 0.8));
  });

  it('never drops below 1 minor unit', () => {
    const r = computeBuyClaimMinor(
      eur(1, [{ minVideos: 2, discountPercent: 90 }]),
      2,
    );
    expect(r.totalMinor).toBeGreaterThanOrEqual(1);
  });
});

describe('computeSponsorMinor', () => {
  it('uses the list price times quantity, no discount', () => {
    expect(computeSponsorMinor(eur(500))).toBe(500);
    expect(computeSponsorMinor(eur(500), 3)).toBe(1500);
    expect(computeSponsorMinor(eur(500), 0)).toBe(500); // floor at 1
  });
});

describe('computeCheckoutTotalMinor', () => {
  it('defaults to 20% commission plus Stripe gross-up', () => {
    const r = computeCheckoutTotalMinor(1000);
    expect(r.commissionPercent).toBe(PLATFORM_COMMISSION_PERCENT_DEFAULT);
    expect(r.basePriceMinor).toBe(1000);
    expect(r.commissionMinor).toBe(200);
    expect(r.stripeProcessingFeeMinor).toBeGreaterThan(0);
    expect(r.totalMinor).toBe(1000 + 200 + r.stripeProcessingFeeMinor);
  });

  it('rounds commission to at least 1 minor unit on positive bases', () => {
    const r = computeCheckoutTotalMinor(3, 20);
    // 3 * 0.2 = 0.6 → rounds to 1
    expect(r.commissionMinor).toBe(1);
    expect(r.totalMinor).toBeGreaterThanOrEqual(4);
  });

  it('charges no commission for zero base', () => {
    const r = computeCheckoutTotalMinor(0);
    expect(r.commissionMinor).toBe(0);
    expect(r.totalMinor).toBe(0);
  });

  it('can disable Stripe gross-up via config', () => {
    const r = computeCheckoutTotalMinor(1000, 20, {
      stripeProcessingFeePercent: 0,
      stripeProcessingFeeFixedMinor: 0,
    });
    expect(r.commissionMinor).toBe(200);
    expect(r.stripeProcessingFeeMinor).toBe(0);
    expect(r.totalMinor).toBe(1200);
  });

  it('uses default Stripe fee constants', () => {
    const r = computeCheckoutTotalMinor(1000);
    expect(STRIPE_PROCESSING_FEE_PERCENT_DEFAULT).toBe(2.9);
    expect(STRIPE_PROCESSING_FEE_FIXED_MINOR_DEFAULT).toBe(30);
    expect(r.stripeProcessingFeeMinor).toBeGreaterThan(0);
  });
});

describe('checkoutBreakdownWithDiscountMinor', () => {
  it('surfaces discount savings vs the list price', () => {
    const r = checkoutBreakdownWithDiscountMinor(800, 1000, 20, 20);
    expect(r.basePriceMinor).toBe(800);
    expect(r.listPriceMinor).toBe(1000);
    expect(r.discountPercent).toBe(20);
    expect(r.discountSavedMinor).toBe(200);
    expect(r.commissionMinor).toBe(160);
    expect(r.totalMinor).toBe(800 + 160 + r.stripeProcessingFeeMinor);
  });
});

describe('splitIntegerTotal', () => {
  it('distributes remainders to the first slots', () => {
    expect(splitIntegerTotal(10, 3)).toEqual([4, 3, 3]);
    expect(splitIntegerTotal(11, 3)).toEqual([4, 4, 3]);
    expect(splitIntegerTotal(0, 5)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('isCommercialVideoUnlockedForViewer', () => {
  it('is true for the beneficiary surfer', () => {
    expect(
      isCommercialVideoUnlockedForViewer({
        videoUnlockedForUserId: 'surfer-1',
        viewerUserId: 'surfer-1',
        sessionOwnerUserId: 'partner-1',
      }),
    ).toBe(true);
  });

  it('is true for the session owner when any surfer unlocked', () => {
    expect(
      isCommercialVideoUnlockedForViewer({
        videoUnlockedForUserId: 'surfer-1',
        viewerUserId: 'partner-1',
        sessionOwnerUserId: 'partner-1',
      }),
    ).toBe(true);
  });

  it('is false for other viewers and when not unlocked', () => {
    expect(
      isCommercialVideoUnlockedForViewer({
        videoUnlockedForUserId: 'surfer-1',
        viewerUserId: 'other-1',
        sessionOwnerUserId: 'partner-1',
      }),
    ).toBe(false);
    expect(
      isCommercialVideoUnlockedForViewer({
        videoUnlockedForUserId: null,
        viewerUserId: 'partner-1',
        sessionOwnerUserId: 'partner-1',
      }),
    ).toBe(false);
  });
});

describe('allocateBuyClaimLineBreakdownsMinor', () => {
  it('returns one line per wave whose bases sum to the discounted total', () => {
    const settings = eur(700, [{ minVideos: 3, discountPercent: 15 }]);
    const lines = allocateBuyClaimLineBreakdownsMinor(settings, 3);
    expect(lines).toHaveLength(3);
    const baseSum = lines.reduce((s, l) => s + l.basePriceMinor, 0);
    expect(baseSum).toBe(Math.round(700 * 3 * 0.85));
    for (const line of lines) {
      expect(line.commissionPercent).toBe(PLATFORM_COMMISSION_PERCENT_DEFAULT);
      expect(line.discountPercent).toBe(15);
      expect(line.listPriceMinor).toBe(700);
      expect(line.commissionMinor).toBeGreaterThanOrEqual(1);
      expect(line.totalMinor).toBe(
        line.basePriceMinor +
          line.commissionMinor +
          line.stripeProcessingFeeMinor,
      );
    }
  });
});
