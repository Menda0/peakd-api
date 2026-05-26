import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type VideoShakaDocument = HydratedDocument<VideoShaka>;

@Schema({ collection: 'video_shakas' })
export class VideoShaka {
  @Prop({ required: true, index: true })
  jobId: string;

  @Prop({ required: true, index: true })
  userId: string;

  /** ISO 8601 instant when the shaka was given. */
  @Prop({ required: true })
  createdAt: string;
}

export const VideoShakaSchema = SchemaFactory.createForClass(VideoShaka);

VideoShakaSchema.index({ jobId: 1, userId: 1 }, { unique: true });
