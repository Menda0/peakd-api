/** Stored at `videos/{userId}/{jobId}/meta.json` in S3 */
export interface VideoJobMeta {
  userId: string;
  jobId: string;
  createdAt: string;
  originalFilename: string;
  processedKey: string;
  snapshotKeys: string[];
}
