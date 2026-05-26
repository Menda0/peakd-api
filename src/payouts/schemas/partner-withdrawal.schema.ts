import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PartnerWithdrawalDocument = HydratedDocument<PartnerWithdrawal>;

export const PARTNER_WITHDRAWAL_STATUSES = [
  'pending',
  'completed',
  'failed',
] as const;
export type PartnerWithdrawalStatus =
  (typeof PARTNER_WITHDRAWAL_STATUSES)[number];

@Schema({
  collection: 'partner_withdrawals',
  timestamps: { createdAt: true, updatedAt: true },
})
export class PartnerWithdrawal {
  @Prop({ required: true, index: true })
  userId: string;

  /** Stripe connected account the funds were transferred to (`acct_...`). */
  @Prop({ required: true, index: true })
  stripeAccountId: string;

  /** EUR cents transferred to the connected account. */
  @Prop({ required: true })
  amountCents: number;

  @Prop({ required: true, default: 'eur' })
  currency: string;

  /**
   * Stable key sent as `Idempotency-Key` to Stripe so retries are safe and
   * duplicate withdrawal records cannot be created.
   */
  @Prop({ required: true, unique: true, index: true })
  idempotencyKey: string;

  /** Stripe Transfer id (`tr_...`). Null until the API call completes. */
  @Prop({ type: String, default: null, index: true, sparse: true })
  stripeTransferId: string | null;

  @Prop({
    type: String,
    required: true,
    enum: PARTNER_WITHDRAWAL_STATUSES,
    default: 'pending',
    index: true,
  })
  status: PartnerWithdrawalStatus;

  @Prop({ type: String, default: null })
  failureReason: string | null;
}

export const PartnerWithdrawalSchema =
  SchemaFactory.createForClass(PartnerWithdrawal);

PartnerWithdrawalSchema.index({ userId: 1, createdAt: -1 });
