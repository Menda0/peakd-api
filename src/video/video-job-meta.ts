import type { SocialVariantKind } from './social-video.types';

export type VideoJobMetaSocialVariant = {
  kind: SocialVariantKind;
  label: string;
  aspectRatio: string;
  videoKey: string;
  thumbnailKey: string;
  durationSec?: number;
};

/** Stored at `videos/{userId}/{jobId}/meta.json` in S3 */
export interface VideoJobMeta {
  userId: string;
  jobId: string;
  createdAt: string;
  originalFilename: string;
  processedKey: string;
  snapshotKeys: string[];
  socialVariants?: VideoJobMetaSocialVariant[];
  surfSessionId?: string | null;
}
