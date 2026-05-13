import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type VideoJobDocument = HydratedDocument<VideoJob>;

@Schema({ collection: 'video_jobs' })
export class VideoJob {
  @Prop({ required: true, index: true })
  userId: string;

  @Prop({ required: true, unique: true })
  jobId: string;

  @Prop({ required: true })
  originalFilename: string;

  @Prop({ required: true })
  processedKey: string;

  @Prop({ type: [String], default: [] })
  snapshotKeys: string[];

  /** ISO 8601 string, aligned with S3 meta.json */
  @Prop({ required: true })
  createdAt: string;

  /** Surf session folder (UUID); null for legacy uploads */
  @Prop({ type: String, default: null, index: true })
  surfSessionId: string | null;
}

export const VideoJobSchema = SchemaFactory.createForClass(VideoJob);
VideoJobSchema.index({ userId: 1, createdAt: -1 });
VideoJobSchema.index({ userId: 1, surfSessionId: 1, createdAt: -1 });
