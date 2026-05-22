import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type WaveUnlockPurchaseDocument = HydratedDocument<WaveUnlockPurchase>;

export const WAVE_UNLOCK_PURCHASE_TYPES = ['buy_claim', 'sponsor'] as const;
export type WaveUnlockPurchaseType = (typeof WAVE_UNLOCK_PURCHASE_TYPES)[number];

@Schema({ collection: 'wave_unlock_purchases', timestamps: { createdAt: true, updatedAt: false } })
export class WaveUnlockPurchase {
  @Prop({ required: true, index: true })
  jobId: string;

  @Prop({ required: true, index: true })
  sessionId: string;

  /** User who paid Peaks. */
  @Prop({ required: true, index: true })
  buyerUserId: string;

  /** User who receives video unlock (claimant for sponsor). */
  @Prop({ required: true })
  beneficiaryUserId: string;

  @Prop({ type: String, required: true, enum: WAVE_UNLOCK_PURCHASE_TYPES })
  type: WaveUnlockPurchaseType;

  @Prop({ required: true })
  peaksCharged: number;

  @Prop({ type: Number, default: 0 })
  discountPercent: number;

  @Prop({ required: true })
  createdAt: string;
}

export const WaveUnlockPurchaseSchema =
  SchemaFactory.createForClass(WaveUnlockPurchase);

WaveUnlockPurchaseSchema.index({ jobId: 1, buyerUserId: 1, type: 1 });
