import { Injectable, NotFoundException } from '@nestjs/common';
import { S3Service } from '../s3/s3.service';
import type { VideoJobMeta } from './video-job-meta';

export interface VideoJobListItemDto {
  jobId: string;
  originalFilename: string;
  createdAt: string;
  thumbnailUrl?: string;
}

export interface VideoJobDetailDto {
  jobId: string;
  originalFilename: string;
  createdAt: string;
  processedKey: string;
  videoUrl: string;
  snapshots: Array<{ key: string; url: string }>;
}

@Injectable()
export class VideoRegistryService {
  constructor(private readonly s3: S3Service) {}

  async listJobs(): Promise<VideoJobListItemDto[]> {
    const keys = await this.s3.listKeysWithPrefix('videos/');
    const metaKeys = keys.filter((k) => k.endsWith('/meta.json'));

    const items: VideoJobListItemDto[] = [];

    for (const key of metaKeys) {
      const meta = await this.s3.getJson<VideoJobMeta>(key);
      if (!meta?.jobId || !meta.createdAt) {
        continue;
      }
      const firstSnap = meta.snapshotKeys?.[0];
      let thumbnailUrl: string | undefined;
      if (firstSnap) {
        thumbnailUrl = await this.s3.presignedGetUrl(firstSnap);
      }
      items.push({
        jobId: meta.jobId,
        originalFilename: meta.originalFilename ?? 'video',
        createdAt: meta.createdAt,
        thumbnailUrl,
      });
    }

    items.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    return items;
  }

  async getJob(jobId: string): Promise<VideoJobDetailDto> {
    const key = `videos/${jobId}/meta.json`;
    const meta = await this.s3.getJson<VideoJobMeta>(key);
    if (!meta?.jobId) {
      throw new NotFoundException(`Video job not found: ${jobId}`);
    }

    const videoUrl = await this.s3.presignedGetUrl(meta.processedKey);
    const snapshots: VideoJobDetailDto['snapshots'] = [];
    for (const snapKey of meta.snapshotKeys ?? []) {
      snapshots.push({
        key: snapKey,
        url: await this.s3.presignedGetUrl(snapKey),
      });
    }

    return {
      jobId: meta.jobId,
      originalFilename: meta.originalFilename ?? 'video',
      createdAt: meta.createdAt,
      processedKey: meta.processedKey,
      videoUrl,
      snapshots,
    };
  }
}
