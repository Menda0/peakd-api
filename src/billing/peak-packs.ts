export type PeakPackId = 'starter' | 'popular' | 'pro' | 'ultimate';

export type PeakPackDefinition = {
  id: PeakPackId;
  label: string;
  peaks: number;
  /** EUR minor units (cents), before platform fee */
  baseAmountCents: number;
};

export const PEAK_PACKS: readonly PeakPackDefinition[] = [
  { id: 'starter', label: 'Starter', peaks: 500, baseAmountCents: 500 },
  { id: 'popular', label: 'Popular', peaks: 1200, baseAmountCents: 1000 },
  { id: 'pro', label: 'Pro', peaks: 3500, baseAmountCents: 2500 },
  { id: 'ultimate', label: 'Ultimate', peaks: 8000, baseAmountCents: 5000 },
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
