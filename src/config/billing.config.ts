import { registerAs } from '@nestjs/config';

export const BILLING_CONFIG_KEY = 'billing';

export interface BillingConfigValues {
  peaksPerEuro: number;
  platformFeePercent: number;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  /** Shared secret for BFF → API after Stripe signature is verified in Next.js */
  webhookInternalSecret: string;
  appBaseUrl: string;
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

export const billingConfig = registerAs(
  BILLING_CONFIG_KEY,
  (): BillingConfigValues => ({
    peaksPerEuro: parsePositiveInt(process.env.PEAKS_PER_EURO, 100),
    platformFeePercent: parseFeePercent(process.env.PLATFORM_FEE_PERCENT),
    stripeSecretKey: (process.env.STRIPE_SECRET_KEY ?? '').trim(),
    stripeWebhookSecret: (process.env.STRIPE_WEBHOOK_SECRET ?? '').trim(),
    webhookInternalSecret: (process.env.BILLING_WEBHOOK_INTERNAL_SECRET ?? '').trim(),
    appBaseUrl: (process.env.APP_BASE_URL ?? '').replace(/\/+$/, ''),
  }),
);
