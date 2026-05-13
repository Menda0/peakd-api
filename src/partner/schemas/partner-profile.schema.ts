import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

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
}

export const PartnerProfileSchema = SchemaFactory.createForClass(PartnerProfile);
