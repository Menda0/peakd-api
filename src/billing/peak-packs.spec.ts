import { assertPacksAreSolvent, PEAK_PACKS } from './peak-packs';

/**
 * The shipping pack table currently has bonus Peaks on `popular`, `pro`, and
 * `ultimate` that exceed the linear value of the base price at
 * `PEAKS_PER_EURO=100`. So a config tuple is only "solvent" when the platform
 * surcharge + Stripe-fee buffer is large enough to cover both:
 *
 *   - the lower bound (`starter` is exactly at the linear rate, so any
 *     `peaksPerEuro` > 100 makes starter fail the linear minimum), and
 *   - the upper bound (the `ultimate` pack has 8000 Peaks vs €50 base, so the
 *     net cash retained after Stripe must be ≥ €50 — currently a ~60%
 *     surcharge is needed to pass the assertion with no Stripe fees).
 *
 * The tests below assert the *direction* of these constraints rather than
 * picking a single magic config that passes — that way changing the pack
 * table or the fee defaults doesn't silently invalidate the test.
 */
describe('assertPacksAreSolvent', () => {
  it('passes when the platform surcharge fully covers bonus Peaks and there are no Stripe fees', () => {
    // 60% surcharge brings the smallest pack (€5) to €8 gross — enough to
    // cover the worst-case bonus pack (`ultimate`: 8000 Peaks = €80 of
    // liability for a €80 gross at 60% surcharge).
    expect(() =>
      assertPacksAreSolvent({
        peaksPerEuro: 100,
        platformFeePercent: 60,
        expectedStripeFeePercent: 0,
        expectedStripeFixedCents: 0,
      }),
    ).not.toThrow();
  });

  it('current shipping pack table is solvent at the production-default config', () => {
    // Production defaults: PEAKS_PER_EURO=100, PLATFORM_FEE_PERCENT=10,
    // EEA Stripe pricing (1.5% + €0.25). The pack table is sized with a
    // few-Peak headroom against this exact config.
    expect(() =>
      assertPacksAreSolvent({
        peaksPerEuro: 100,
        platformFeePercent: 10,
        expectedStripeFeePercent: 1.5,
        expectedStripeFixedCents: 25,
      }),
    ).not.toThrow();
  });

  it('fails if PLATFORM_FEE_PERCENT drops below what the pack bonuses need', () => {
    // With zero surcharge but EEA Stripe pricing, every pack would be
    // net-negative once Stripe takes its cut.
    expect(() =>
      assertPacksAreSolvent({
        peaksPerEuro: 100,
        platformFeePercent: 0,
        expectedStripeFeePercent: 1.5,
        expectedStripeFixedCents: 25,
      }),
    ).toThrow(/loss-prone/);
  });

  it('fails for inflated bonus packs at PEAKS_PER_EURO=100 with PFP=10%', () => {
    // The pre-fix `popular` pack shape — preserved here as a regression
    // guard so anyone who later inflates the bonuses gets a loud failure
    // instead of a silent loss in production.
    expect(() =>
      assertPacksAreSolvent({
        peaksPerEuro: 100,
        platformFeePercent: 10,
        expectedStripeFeePercent: 1.5,
        expectedStripeFixedCents: 25,
        packs: [
          { id: 'starter', label: 'X', peaks: 1200, baseAmountCents: 1000 },
        ],
      }),
    ).toThrow(/loss-prone/);
  });

  it('rejects packs that drop below the linear minimum (starter under-pegged)', () => {
    // Choose `peaksPerEuro=200` so even the starter pack falls below the
    // linear minimum (it would need 1000 Peaks for €5 but ships with 500).
    expect(() =>
      assertPacksAreSolvent({
        peaksPerEuro: 200,
        platformFeePercent: 100,
        expectedStripeFeePercent: 0,
        expectedStripeFixedCents: 0,
      }),
    ).toThrow(/minimum/);
  });

  it('error message names a specific pack id and points at the remediation knobs', () => {
    let err: unknown = null;
    try {
      assertPacksAreSolvent({
        peaksPerEuro: 100,
        platformFeePercent: 0,
        expectedStripeFeePercent: 1.5,
        expectedStripeFixedCents: 25,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    // Any pack id is acceptable — what we care about is that the error
    // tells the operator *which* pack failed and *what knobs* to turn.
    const packIds = PEAK_PACKS.map((p) => p.id).join('|');
    expect(message).toMatch(new RegExp(packIds));
    expect(message).toMatch(/PLATFORM_FEE_PERCENT/);
    expect(message).toMatch(/peaks|baseAmountCents/);
  });

  it('production sanity: bonus packs require a substantially higher surcharge than starter', () => {
    // Sanity check that the upper bound is the binding constraint for the
    // bonus packs. With ample Stripe coverage and *only* lower-bound
    // enforcement (i.e., zero surcharge but also no Stripe fees), the
    // assertion still fails on the upper bound for bonus packs.
    expect(() =>
      assertPacksAreSolvent({
        peaksPerEuro: 100,
        platformFeePercent: 0,
        expectedStripeFeePercent: 0,
        expectedStripeFixedCents: 0,
      }),
    ).toThrow(/loss-prone/);
  });
});
