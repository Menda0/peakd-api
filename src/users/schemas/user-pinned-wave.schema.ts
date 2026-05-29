import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type UserPinnedWaveDocument = HydratedDocument<UserPinnedWave>;

@Schema({ collection: 'user_pinned_waves' })
export class UserPinnedWave {
  @Prop({ required: true, index: true })
  userId: string;

  @Prop({ required: true, index: true })
  jobId: string;

  @Prop({ required: true, default: () => new Date() })
  pinnedAt: Date;
}

export const UserPinnedWaveSchema = SchemaFactory.createForClass(UserPinnedWave);
UserPinnedWaveSchema.index({ userId: 1, jobId: 1 }, { unique: true });
