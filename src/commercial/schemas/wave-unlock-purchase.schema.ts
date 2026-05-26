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

  /** Partner (session owner) who earns the list-price share. */
  @Prop({ required: true, index: true })
  partnerUserId: string;

  /** List price after volume discount, expressed in Peaks (buyer-side). */
  @Prop({ required: true })
  basePeaks: number;

  /**
   * Money credited to the partner for this unlock, in EUR cents. Persisted
   * at unlock time so historical earnings remain stable across future
   * `peaksPerEuro` rate changes. Optional/null on rows created before the
   * partner pivot — read paths fall back to `floor(basePeaks * 100 /
   * peaksPerEuro)` for those.
   */
  @Prop({ type: Number, default: null })
  partnerEarningsCents: number | null;

  /**
   * Legacy field name for the platform's retention surcharge on each unlock.
   * Kept for backwards compatibility with existing rows + admin aggregates;
   * always equals `platformRetentionPeaks` for newly-written rows.
   *
   * The Peaks are debited from the buyer but credited to nobody — the fiat
   * equivalent stays in the platform's Stripe balance as operational
   * retention (used at the admin's discretion to fund community awards).
   * See `commercial-pricing.ts` for the policy explanation.
   */
  @Prop({ required: true })
  communityFeePeaks: number;

  /**
   * Canonical name for the same retention amount, dual-written alongside
   * `communityFeePeaks`. New code should prefer this name; aggregations
   * should `$ifNull` between the two to survive the migration window.
   */
  @Prop({ type: Number, default: null })
  platformRetentionPeaks: number | null;

  /** ISO 3166-1 alpha-2 from surf session. */
  @Prop({ required: true, index: true })
  countryCode: string;

  @Prop({ required: true, index: true })
  regionId: string;

  @Prop({ type: Number, default: 0 })
  discountPercent: number;

  @Prop({ required: true })
  createdAt: string;
}

export const WaveUnlockPurchaseSchema =
  SchemaFactory.createForClass(WaveUnlockPurchase);

WaveUnlockPurchaseSchema.index({ jobId: 1, buyerUserId: 1, type: 1 });
WaveUnlockPurchaseSchema.index({ createdAt: -1 });
// Note: `countryCode` and `regionId` are already indexed via `@Prop({ index: true })`
// on the field decorators above; adding `schema.index()` here would create
// duplicate-index warnings at Mongoose boot.
