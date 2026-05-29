import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type VideoJobDocument = HydratedDocument<VideoJob>;

export const VIDEO_JOB_STATUSES = ['processing', 'completed', 'failed'] as const;
export type VideoJobStatus = (typeof VIDEO_JOB_STATUSES)[number];

export const VIDEO_UPLOAD_SOURCES = ['studio', 'personal'] as const;
export type VideoUploadSource = (typeof VIDEO_UPLOAD_SOURCES)[number];

export const VIDEO_CLAIM_STATUSES = ['none', 'auto', 'claimed'] as const;
export type VideoClaimStatus = (typeof VIDEO_CLAIM_STATUSES)[number];

export const SOCIAL_VARIANT_KINDS = ['reel', 'story', 'post'] as const;
export type SocialVariantKind = (typeof SOCIAL_VARIANT_KINDS)[number];

@Schema({ _id: false })
export class SocialVideoVariant {
  @Prop({ type: String, enum: SOCIAL_VARIANT_KINDS, required: true })
  kind: SocialVariantKind;

  @Prop({ required: true })
  label: string;

  @Prop({ required: true })
  aspectRatio: string;

  @Prop({ required: true })
  videoKey: string;

  @Prop({ required: true })
  thumbnailKey: string;

  @Prop({ type: Number })
  durationSec?: number;
}

export const SocialVideoVariantSchema =
  SchemaFactory.createForClass(SocialVideoVariant);

@Schema({ collection: 'video_jobs' })
export class VideoJob {
  @Prop({ required: true, index: true })
  userId: string;

  @Prop({ required: true, unique: true })
  jobId: string;

  @Prop({ required: true })
  originalFilename: string;

  /** Set when transcoding and upload to S3 finish */
  @Prop({ type: String })
  processedKey?: string;

  /** Original upload on raw-retention bucket (`S3_RAW_BUCKET`) */
  @Prop({ type: String, default: null })
  rawOriginalKey: string | null;

  @Prop({ type: [String], default: [] })
  snapshotKeys: string[];

  /** MP4 exports for social platforms (reel/story/post). */
  @Prop({ type: [SocialVideoVariantSchema], default: [] })
  socialVariants: SocialVideoVariant[];

  /** ISO 8601 string, aligned with S3 meta.json */
  @Prop({ required: true })
  createdAt: string;

  /** Surf session folder (UUID); null for legacy uploads */
  @Prop({ type: String, default: null, index: true })
  surfSessionId: string | null;

  @Prop({
    type: String,
    enum: VIDEO_JOB_STATUSES,
    default: 'processing',
  })
  status: VideoJobStatus;

  @Prop({ type: String })
  errorMessage?: string;

  /** ISO 8601 instant when the video became visible on the discover feed. */
  @Prop({ type: String, default: null, index: true })
  discoverPublishedAt: string | null;

  /** Partner studio vs personal user upload from the feed. */
  @Prop({
    type: String,
    enum: VIDEO_UPLOAD_SOURCES,
    default: 'studio',
    index: true,
  })
  uploadSource: VideoUploadSource;

  /** Surf claim state (auto for personal uploads). */
  @Prop({
    type: String,
    enum: VIDEO_CLAIM_STATUSES,
    default: 'none',
  })
  claimStatus: VideoClaimStatus;

  @Prop({ type: String, default: null })
  claimedAt: string | null;

  /** Auth0 subject of the surfer who claimed a partner studio clip. */
  @Prop({ type: String, default: null, index: true })
  claimedByUserId: string | null;

  /** Auth0 subject who may watch the full processed video (commercial unlock). */
  @Prop({ type: String, default: null, index: true })
  videoUnlockedForUserId: string | null;

  /** Auth0 subject who paid Peaks to unlock (buyer or sponsor). */
  @Prop({ type: String, default: null })
  videoUnlockedByUserId: string | null;

  @Prop({ type: String, default: null })
  videoUnlockedAt: string | null;
}

export const VideoJobSchema = SchemaFactory.createForClass(VideoJob);
VideoJobSchema.index({ userId: 1, createdAt: -1 });
VideoJobSchema.index({ userId: 1, surfSessionId: 1, createdAt: -1 });
VideoJobSchema.index(
  { discoverPublishedAt: 1, createdAt: -1 },
  { partialFilterExpression: { discoverPublishedAt: { $type: 'string' } } },
);
VideoJobSchema.index({ claimedByUserId: 1, createdAt: -1 });
