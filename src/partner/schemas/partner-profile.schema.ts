import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import {
  CommercialSettingsEmbed,
  CommercialSettingsEmbedSchema,
} from '../../commercial/schemas/commercial-settings.embed';

export type PartnerProfileDocument = HydratedDocument<PartnerProfile>;

@Schema({ collection: 'partner_profiles' })
export class PartnerProfile {
  /** Auth0 subject (`sub`). */
  @Prop({ required: true, unique: true, index: true })
  userId: string;

  @Prop({ type: String, default: null })
  partnerName: string | null;

  @Prop({
    required: true,
    enum: ['videographer', 'coach', 'other'],
    default: 'videographer',
  })
  partnerType: string;

  @Prop({ type: String, default: null })
  descriptionMarkdown: string | null;

  /** S3 object key for the partner avatar image. */
  @Prop({ type: String, default: null })
  avatarKey: string | null;

  /** ISO 3166-1 alpha-2 */
  @Prop({ type: String, default: null })
  countryCode: string | null;

  /** Default Peaks pricing for commercial studio sessions. */
  @Prop({ type: CommercialSettingsEmbedSchema, default: null })
  commercialSettings: CommercialSettingsEmbed | null;

  /** Stripe Connect account id (`acct_...`) used to receive bank payouts. */
  @Prop({ type: String, default: null, index: true, sparse: true })
  stripeConnectAccountId: string | null;

  /** Cached `charges_enabled && payouts_enabled` from `account.updated`. */
  @Prop({ type: Boolean, default: false })
  stripeConnectPayoutsEnabled: boolean;

  /** Cached `requirements.currently_due` to surface KYC blockers in the UI. */
  @Prop({ type: [String], default: [] })
  stripeConnectRequirementsDue: string[];
}

export const PartnerProfileSchema = SchemaFactory.createForClass(PartnerProfile);
