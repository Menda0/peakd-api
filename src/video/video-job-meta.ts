/** Stored at `videos/{jobId}/meta.json` in S3 */
export interface VideoJobMeta {
  jobId: string;
  createdAt: string;
  originalFilename: string;
  processedKey: string;
  snapshotKeys: string[];
}
