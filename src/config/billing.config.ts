import { registerAs } from '@nestjs/config';

export const BILLING_CONFIG_KEY = 'billing';

export interface BillingConfigValues {
  peaksPerEuro: number;
  platformFeePercent: number;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  /** Optional dedicated signing secret for connected-account events (Connect webhook endpoint). Falls back to stripeWebhookSecret. */
  stripeConnectWebhookSecret: string;
  /** Shared secret for BFF → API after Stripe signature is verified in Next.js */
  webhookInternalSecret: string;
  appBaseUrl: string;
  /** Minimum partner withdrawal expressed in EUR cents (e.g. 1000 = €10). */
  partnerMinWithdrawalCents: number;
  /** Path appended to APP_BASE_URL for Connect onboarding return/refresh URLs. */
  partnerPayoutReturnPath: string;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

function parseFeePercent(raw: string | undefined): number {
  if (raw == null || raw.trim() === '') return 0;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 100);
}

function parsePath(raw: string | undefined, fallback: string): string {
  const v = (raw ?? '').trim();
  if (!v) return fallback;
  return v.startsWith('/') ? v : `/${v}`;
}

export const billingConfig = registerAs(
  BILLING_CONFIG_KEY,
  (): BillingConfigValues => ({
    peaksPerEuro: parsePositiveInt(process.env.PEAKS_PER_EURO, 100),
    platformFeePercent: parseFeePercent(process.env.PLATFORM_FEE_PERCENT),
    stripeSecretKey: (process.env.STRIPE_SECRET_KEY ?? '').trim(),
    stripeWebhookSecret: (process.env.STRIPE_WEBHOOK_SECRET ?? '').trim(),
    stripeConnectWebhookSecret: (
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET ?? ''
    ).trim(),
    webhookInternalSecret: (process.env.BILLING_WEBHOOK_INTERNAL_SECRET ?? '').trim(),
    appBaseUrl: (process.env.APP_BASE_URL ?? '').replace(/\/+$/, ''),
    partnerMinWithdrawalCents: parsePartnerMinWithdrawalCents(),
    partnerPayoutReturnPath: parsePath(
      process.env.PARTNER_PAYOUT_RETURN_PATH,
      '/partner/income',
    ),
  }),
);

/**
 * Reads the partner minimum withdrawal in EUR cents. Falls back to converting
 * the legacy `PARTNER_MIN_WITHDRAWAL_PEAKS` env (deprecated, may be removed)
 * via `PEAKS_PER_EURO` so existing deployments don't break during the pivot.
 */
function parsePartnerMinWithdrawalCents(): number {
  const directRaw = process.env.PARTNER_MIN_WITHDRAWAL_CENTS;
  if (directRaw != null && directRaw.trim() !== '') {
    return parsePositiveInt(directRaw, 1000);
  }
  const legacyPeaks = process.env.PARTNER_MIN_WITHDRAWAL_PEAKS;
  if (legacyPeaks != null && legacyPeaks.trim() !== '') {
    const peaks = parsePositiveInt(legacyPeaks, 1000);
    const peaksPerEuro = parsePositiveInt(process.env.PEAKS_PER_EURO, 100);
    return Math.max(1, Math.floor((peaks * 100) / peaksPerEuro));
  }
  return 1000;
}
