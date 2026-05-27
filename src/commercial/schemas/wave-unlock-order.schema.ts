import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type WaveUnlockOrderDocument = HydratedDocument<WaveUnlockOrder>;

export const WAVE_UNLOCK_ORDER_INTENTS = ['buy_claim', 'sponsor'] as const;
export type WaveUnlockOrderIntent = (typeof WAVE_UNLOCK_ORDER_INTENTS)[number];

export const WAVE_UNLOCK_ORDER_STATUSES = [
  'pending',
  'completed',
  'failed',
] as const;
export type WaveUnlockOrderStatus = (typeof WAVE_UNLOCK_ORDER_STATUSES)[number];

/**
 * One row per Stripe Checkout Session created for a wave-unlock purchase.
 * Each order belongs to a single partner (single settlement currency), but
 * can contain multiple `jobIds` from the same partner's session (so volume
 * discount applies). Cross-partner carts are split into multiple orders.
 */
@Schema({
  collection: 'wave_unlock_orders',
  timestamps: { createdAt: true, updatedAt: true },
})
export class WaveUnlockOrder {
  /** Stable internal id, also used as `client_reference_id` on Stripe. */
  @Prop({ required: true, unique: true, index: true })
  orderId: string;

  /** Buyer (Auth0 sub) initiating the checkout. */
  @Prop({ required: true, index: true })
  buyerUserId: string;

  /** Partner (Auth0 sub) who will earn `partnerSubtotalMinor` on fulfillment. */
  @Prop({ required: true, index: true })
  partnerUserId: string;

  /** ISO 4217 currency, uppercase. */
  @Prop({ required: true })
  currency: string;

  /** Wave job ids included in the order, all from one partner. */
  @Prop({ type: [String], required: true })
  jobIds: string[];

  @Prop({ required: true, enum: WAVE_UNLOCK_ORDER_INTENTS })
  intent: WaveUnlockOrderIntent;

  /** Sum of per-line base prices (after volume discount), in minor units. */
  @Prop({ required: true })
  partnerSubtotalMinor: number;

  /** 20% platform commission charged on top of the partner subtotal. */
  @Prop({ required: true })
  platformCommissionMinor: number;

  /** `partnerSubtotalMinor + platformCommissionMinor` (what the buyer pays). */
  @Prop({ required: true })
  totalAmountMinor: number;

  @Prop({ required: true })
  platformCommissionPercent: number;

  @Prop({ type: Number, default: 0 })
  discountPercent: number;

  /** Stripe Checkout Session id (`cs_...`) — unique for idempotency. */
  @Prop({ required: true, unique: true, index: true })
  stripeCheckoutSessionId: string;

  @Prop({ type: String, default: null })
  stripePaymentIntentId: string | null;

  @Prop({ type: String, default: null, index: true })
  stripeBalanceTransactionId: string | null;

  @Prop({ type: Number, default: null })
  stripeFeeMinor: number | null;

  @Prop({ type: Number, default: null })
  stripeNetMinor: number | null;

  /** Settlement currency reported by Stripe (may differ if adaptive pricing). */
  @Prop({ type: String, default: null })
  stripeCurrency: string | null;

  @Prop({
    type: String,
    required: true,
    enum: WAVE_UNLOCK_ORDER_STATUSES,
    default: 'pending',
    index: true,
  })
  status: WaveUnlockOrderStatus;

  @Prop({ type: String, default: null })
  failureReason: string | null;

  /** ISO 3166-1 alpha-2 of the surf session location. */
  @Prop({ required: true, index: true })
  countryCode: string;

  @Prop({ required: true, index: true })
  regionId: string;

  /** Set when the order is moved out of `pending`. */
  @Prop({ type: Date, default: null })
  completedAt: Date | null;
}

export const WaveUnlockOrderSchema =
  SchemaFactory.createForClass(WaveUnlockOrder);

WaveUnlockOrderSchema.index({ buyerUserId: 1, createdAt: -1 });
WaveUnlockOrderSchema.index({ partnerUserId: 1, createdAt: -1 });
WaveUnlockOrderSchema.index({ partnerUserId: 1, status: 1, completedAt: -1 });
WaveUnlockOrderSchema.index({ status: 1, completedAt: -1 });
WaveUnlockOrderSchema.index({ status: 1, countryCode: 1, completedAt: -1 });
WaveUnlockOrderSchema.index({ status: 1, regionId: 1, completedAt: -1 });
WaveUnlockOrderSchema.index({ status: 1, currency: 1, completedAt: -1 });
