export type PeakPackId = 'starter' | 'popular' | 'pro' | 'ultimate';

export type PeakPackDefinition = {
  id: PeakPackId;
  label: string;
  peaks: number;
  /** EUR minor units (cents), before platform fee */
  baseAmountCents: number;
};

/**
 * Pack table sized to satisfy `assertPacksAreSolvent` at the production
 * defaults (`PEAKS_PER_EURO=100`, `PLATFORM_FEE_PERCENT=10`, EEA Stripe
 * fees of 1.5% + €0.25). Each pack still grants a modest volume bonus
 * (more Peaks-per-EUR as the pack size grows) while keeping every unit
 * sale cash-positive after Stripe takes its cut.
 *
 * Per-pack max-solvent Peaks at this config (computed by the assertion):
 *   starter:  517   → ship 500   (0% bonus, headroom 17)
 *   popular:  1058  → ship 1050  (5% bonus, headroom 8)
 *   pro:      2683  → ship 2650  (6% bonus, headroom 33)
 *   ultimate: 5392  → ship 5350  (7% bonus, headroom 42)
 *
 * If you bump bonuses here, you MUST also raise PLATFORM_FEE_PERCENT or
 * baseAmountCents — the boot assertion will refuse to start otherwise.
 */
export const PEAK_PACKS: readonly PeakPackDefinition[] = [
  { id: 'starter', label: 'Starter', peaks: 500, baseAmountCents: 500 },
  { id: 'popular', label: 'Popular', peaks: 1050, baseAmountCents: 1000 },
  { id: 'pro', label: 'Pro', peaks: 2650, baseAmountCents: 2500 },
  { id: 'ultimate', label: 'Ultimate', peaks: 5350, baseAmountCents: 5000 },
] as const;

const byId = new Map<PeakPackId, PeakPackDefinition>(
  PEAK_PACKS.map((p) => [p.id, p]),
);

export function getPeakPackById(id: string): PeakPackDefinition | null {
  return byId.get(id as PeakPackId) ?? null;
}

export function computeCheckoutPricing(
  baseAmountCents: number,
  platformFeePercent: number,
): {
  baseAmountCents: number;
  platformFeeCents: number;
  totalAmountCents: number;
} {
  const fee = Math.round((baseAmountCents * platformFeePercent) / 100);
  return {
    baseAmountCents,
    platformFeeCents: fee,
    totalAmountCents: baseAmountCents + fee,
  };
}

/** Ensures bonus packs are at least linear value vs PEAKS_PER_EURO. */
export function assertPacksMeetMinimum(peaksPerEuro: number): void {
  for (const p of PEAK_PACKS) {
    const minPeaks = Math.floor((p.baseAmountCents / 100) * peaksPerEuro);
    if (p.peaks < minPeaks) {
      throw new Error(
        `Peak pack ${p.id}: peaks ${p.peaks} < minimum ${minPeaks} for PEAKS_PER_EURO=${peaksPerEuro}`,
      );
    }
  }
}

export type PackSolvencyParams = {
  peaksPerEuro: number;
  platformFeePercent: number;
  /** Expected Stripe processing fee, percent of gross (e.g. 1.5 for EEA cards). */
  expectedStripeFeePercent: number;
  /** Expected Stripe processing fee, fixed cents per charge (e.g. 25 for EEA cards). */
  expectedStripeFixedCents: number;
  /**
   * Optional override of the pack table to assert against. Defaults to the
   * shipping `PEAK_PACKS` constant. Tests use this to regression-guard
   * hypothetical configurations without mutating module state.
   */
  packs?: readonly PeakPackDefinition[];
};

/**
 * Two-sided pack solvency check. Run at boot.
 *
 *  Lower bound: peaks ≥ baseAmountCents/100 * peaksPerEuro  →  buyer can't
 *  receive *less* than they'd get at the linear conversion rate (we never
 *  want to sell Peaks at worse value than buying them piecemeal).
 *
 *  Upper bound: the partner liability a buyer can extract from a pack
 *  (`peaks / peaksPerEuro` cents) must be ≤ the *expected net cash* we keep
 *  after Stripe takes its fee, otherwise every purchase is a guaranteed
 *  loss for the platform.
 *
 *      maxPartnerLiabilityCents  =  peaks * 100 / peaksPerEuro
 *      expectedNetCashCents      =  totalAmountCents
 *                                   − ceil(totalAmountCents * stripeFee% / 100)
 *                                   − stripeFixedCents
 *
 *  We use ceil for the percentage component so the assertion is conservative.
 */
export function assertPacksAreSolvent(params: PackSolvencyParams): void {
  const {
    peaksPerEuro,
    platformFeePercent,
    expectedStripeFeePercent,
    expectedStripeFixedCents,
    packs = PEAK_PACKS,
  } = params;
  for (const p of packs) {
    const minPeaks = Math.floor((p.baseAmountCents / 100) * peaksPerEuro);
    if (p.peaks < minPeaks) {
      throw new Error(
        `Peak pack ${p.id}: peaks ${p.peaks} < minimum ${minPeaks} for PEAKS_PER_EURO=${peaksPerEuro}`,
      );
    }
    const { totalAmountCents } = computeCheckoutPricing(
      p.baseAmountCents,
      platformFeePercent,
    );
    const maxPartnerLiabilityCents = Math.ceil(
      (p.peaks * 100) / peaksPerEuro,
    );
    const stripePercentCents = Math.ceil(
      (totalAmountCents * expectedStripeFeePercent) / 100,
    );
    const expectedNetCashCents =
      totalAmountCents - stripePercentCents - expectedStripeFixedCents;
    if (maxPartnerLiabilityCents > expectedNetCashCents) {
      throw new Error(
        `Peak pack ${p.id} is loss-prone: max partner liability ${maxPartnerLiabilityCents}c > expected net cash ${expectedNetCashCents}c ` +
          `(total ${totalAmountCents}c − Stripe ~${stripePercentCents + expectedStripeFixedCents}c). ` +
          `Reduce \`peaks\`, raise \`baseAmountCents\`, or raise PLATFORM_FEE_PERCENT (currently ${platformFeePercent}%).`,
      );
    }
  }
}
