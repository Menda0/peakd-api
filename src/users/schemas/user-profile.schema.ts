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

  /** UTC calendar day (YYYY-MM-DD) when the onboarding nudge was last recorded (dismiss or prompt). */
  @Prop({ type: String, default: null })
  onboardingPromptDayUtc: string | null;
}

export const UserProfileSchema = SchemaFactory.createForClass(UserProfile);
