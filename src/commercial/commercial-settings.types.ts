export type VolumeDiscountTier = {
  minVideos: number;
  discountPercent: number;
};

export type CommercialSettings = {
  /** ISO 4217 currency code, uppercase (e.g. "EUR", "USD"). */
  currency: string;
  /** Integer price in the minor unit of `currency` (e.g. cents). */
  videoPriceMinor: number;
  volumeDiscounts: VolumeDiscountTier[];
};

export const DEFAULT_VOLUME_DISCOUNTS: VolumeDiscountTier[] = [
  { minVideos: 3, discountPercent: 10 },
  { minVideos: 5, discountPercent: 15 },
  { minVideos: 10, discountPercent: 20 },
];

/**
 * Stripe-supported ISO 4217 currencies that partners can pick from. Stored
 * uppercase; Stripe APIs receive the lowercase form. Keep this list in sync
 * with whatever the platform Stripe account is enabled for.
 */
export const SUPPORTED_CURRENCIES: readonly string[] = [
  'AUD',
  'BRL',
  'CAD',
  'CHF',
  'DKK',
  'EUR',
  'GBP',
  'HKD',
  'JPY',
  'MXN',
  'NOK',
  'NZD',
  'PLN',
  'SEK',
  'SGD',
  'USD',
  'ZAR',
] as const;

/**
 * ISO 4217 currencies that are "zero-decimal" in Stripe (no minor unit) —
 * e.g. JPY. For these, the minor unit and the major unit are the same.
 */
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF',
  'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

/** Decimal places for the minor unit of `currency` (2 for EUR/USD, 0 for JPY). */
export function currencyDecimals(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}

export function isSupportedCurrency(currency: unknown): currency is string {
  return (
    typeof currency === 'string' &&
    SUPPORTED_CURRENCIES.includes(currency.toUpperCase())
  );
}
