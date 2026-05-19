import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PeakPurchaseDocument = HydratedDocument<PeakPurchase>;

@Schema({ collection: 'peak_purchases', timestamps: { createdAt: true, updatedAt: false } })
export class PeakPurchase {
  @Prop({ required: true, index: true })
  userId: string;

  @Prop({ required: true })
  packId: string;

  @Prop({ required: true })
  peaksAmount: number;

  @Prop({ required: true })
  baseAmountCents: number;

  @Prop({ required: true })
  platformFeePercent: number;

  @Prop({ required: true })
  platformFeeCents: number;

  @Prop({ required: true })
  totalAmountCents: number;

  /** Stripe Checkout Session id (cs_...) — unique for idempotency */
  @Prop({ required: true, unique: true, index: true })
  stripeCheckoutSessionId: string;

  @Prop({ type: String, default: null })
  stripePaymentIntentId: string | null;

  @Prop({ required: true, default: 'completed' })
  status: string;
}

export const PeakPurchaseSchema = SchemaFactory.createForClass(PeakPurchase);
