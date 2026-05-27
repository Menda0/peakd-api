import { registerAs } from '@nestjs/config';

export const BILLING_CONFIG_KEY = 'billing';

export interface BillingConfigValues {
  /**
   * Percent the platform charges on top of the partner's price at checkout.
   * Paid by the buyer, kept by the platform. Default 20.
   */
  platformCommissionPercent: number;
  /**
   * Stripe processing percentage used to gross up checkout totals so the
   * partner payout + platform commission remain intact after Stripe fees.
   */
  stripeProcessingFeePercent: number;
  /**
   * Stripe fixed processing fee in minor units (e.g. 30 for $0.30).
   */
  stripeProcessingFeeFixedMinor: number;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  /** Optional dedicated signing secret for connected-account events. Falls back to stripeWebhookSecret. */
  stripeConnectWebhookSecret: string;
  /** Shared secret for BFF → API after Stripe signature is verified in Next.js */
  webhookInternalSecret: string;
  appBaseUrl: string;
  /**
   * Minimum withdrawal per currency, in integer minor units (e.g. cents).
   * Keys are lowercase ISO 4217 codes. Default 1000 minor units (€10/$10).
   */
  partnerMinWithdrawalByCurrency: Record<string, number>;
  /** Path appended to APP_BASE_URL for Connect onboarding return/refresh URLs. */
  partnerPayoutReturnPath: string;
}

function parseFeePercent(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, 100);
}

function parseMinorAmount(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function parsePath(raw: string | undefined, fallback: string): string {
  const v = (raw ?? '').trim();
  if (!v) return fallback;
  return v.startsWith('/') ? v : `/${v}`;
}

const DEFAULT_PARTNER_MIN_WITHDRAWAL_BY_CURRENCY: Record<string, number> = {
  eur: 1000,
  usd: 1000,
  gbp: 1000,
  aud: 1500,
  cad: 1500,
  brl: 5000,
  jpy: 1000,
};

function parsePartnerMinWithdrawalByCurrency(): Record<string, number> {
  const raw = process.env.PARTNER_MIN_WITHDRAWAL_BY_CURRENCY;
  if (raw == null || raw.trim() === '') {
    return { ...DEFAULT_PARTNER_MIN_WITHDRAWAL_BY_CURRENCY };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 1 && Number.isInteger(n)) {
        out[k.toLowerCase()] = n;
      }
    }
    return Object.keys(out).length > 0
      ? out
      : { ...DEFAULT_PARTNER_MIN_WITHDRAWAL_BY_CURRENCY };
  } catch {
    return { ...DEFAULT_PARTNER_MIN_WITHDRAWAL_BY_CURRENCY };
  }
}

export const billingConfig = registerAs(
  BILLING_CONFIG_KEY,
  (): BillingConfigValues => ({
    platformCommissionPercent: parseFeePercent(
      process.env.PLATFORM_COMMISSION_PERCENT,
      20,
    ),
    stripeProcessingFeePercent: parseFeePercent(
      process.env.STRIPE_PROCESSING_FEE_PERCENT,
      2.9,
    ),
    stripeProcessingFeeFixedMinor: parseMinorAmount(
      process.env.STRIPE_PROCESSING_FEE_FIXED_MINOR,
      30,
    ),
    stripeSecretKey: (process.env.STRIPE_SECRET_KEY ?? '').trim(),
    stripeWebhookSecret: (process.env.STRIPE_WEBHOOK_SECRET ?? '').trim(),
    stripeConnectWebhookSecret: (
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET ?? ''
    ).trim(),
    webhookInternalSecret: (
      process.env.BILLING_WEBHOOK_INTERNAL_SECRET ?? ''
    ).trim(),
    appBaseUrl: (process.env.APP_BASE_URL ?? '').replace(/\/+$/, ''),
    partnerMinWithdrawalByCurrency: parsePartnerMinWithdrawalByCurrency(),
    partnerPayoutReturnPath: parsePath(
      process.env.PARTNER_PAYOUT_RETURN_PATH,
      '/partner/income',
    ),
  }),
);

/**
 * Lookup the configured minimum withdrawal for a currency. Falls back to 100
 * minor units (e.g. €1) for currencies not explicitly configured.
 */
export function partnerMinWithdrawalFor(
  config: BillingConfigValues,
  currency: string,
): number {
  return config.partnerMinWithdrawalByCurrency[currency.toLowerCase()] ?? 100;
}
