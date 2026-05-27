import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type UserProfileDocument = HydratedDocument<UserProfile>;

@Schema({ collection: 'user_profiles' })
export class UserProfile {
  /** Auth0 subject (`sub`). */
  @Prop({ required: true, unique: true, index: true })
  userId: string;

  @Prop({ type: String, default: null })
  displayName: string | null;

  @Prop({ type: String, default: null })
  nickname: string | null;

  /** ISO 3166-1 alpha-2 */
  @Prop({ type: String, default: null })
  countryCode: string | null;

  @Prop({ type: String, default: null })
  homeRegionId: string | null;

  /** beginner | intermediate | advanced */
  @Prop({ type: String, default: null })
  surfLevel: string | null;

  /** S3 object key for the app user profile avatar image. */
  @Prop({ type: String, default: null })
  avatarKey: string | null;

  /**
   * Legacy partner balance map (deprecated). Partners are now paid directly via
   * Stripe destination charges at checkout. Kept for migration compatibility.
   */
  @Prop({ type: Map, of: Number, default: () => new Map<string, number>() })
  partnerEarningsByCurrency: Map<string, number>;
}

export const UserProfileSchema = SchemaFactory.createForClass(UserProfile);
