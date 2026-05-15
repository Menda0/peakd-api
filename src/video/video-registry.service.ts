import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { validate as uuidValidate, version as uuidVersion } from 'uuid';
import { S3Service } from '../s3/s3.service';
import { VideoJob } from './schemas/video-job.schema';
import type { VideoJobStatus } from './schemas/video-job.schema';

const LIST_THUMBNAIL_MAX = 4;

export interface VideoJobListItemDto {
  jobId: string;
  originalFilename: string;
  createdAt: string;
  status: VideoJobStatus;
  errorMessage?: string | null;
  /** First snapshot presigned URL (legacy). */
  thumbnailUrl?: string;
  /** Up to four snapshot presigned URLs for list/detail previews. */
  thumbnailUrls: string[];
  surfSessionId?: string | null;
}

export interface VideoJobDetailDto {
  jobId: string;
  originalFilename: string;
  createdAt: string;
  status: VideoJobStatus;
  errorMessage?: string | null;
  processedKey?: string;
  videoUrl?: string;
  snapshots: Array<{ key: string; url: string }>;
  surfSessionId?: string | null;
}

function normalizeJobStatus(doc: {
  status?: VideoJobStatus;
  processedKey?: string;
}): VideoJobStatus {
  if (doc.status === 'failed' || doc.status === 'processing') {
    return doc.status;
  }
  if (doc.status === 'completed') {
    return 'completed';
  }
  return doc.processedKey ? 'completed' : 'processing';
}

@Injectable()
export class VideoRegistryService {
  constructor(
    private readonly s3: S3Service,
    @InjectModel(VideoJob.name)
    private readonly videoJobModel: Model<VideoJob>,
  ) {}

  async listJobs(
    userId: string,
    surfSessionId?: string,
  ): Promise<VideoJobListItemDto[]> {
    const filter: { userId: string; surfSessionId?: string | null } = {
      userId,
    };
    if (typeof surfSessionId === 'string' && surfSessionId.trim()) {
      const sid = surfSessionId.trim();
      if (!uuidValidate(sid) || uuidVersion(sid) !== 4) {
        throw new BadRequestException('Invalid surfSessionId');
      }
      filter.surfSessionId = sid;
    }

    const docs = await this.videoJobModel
      .find(filter)
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    const items: VideoJobListItemDto[] = [];

    for (const doc of docs) {
      const status = normalizeJobStatus(doc);
      const snapKeys =
        status === 'completed'
          ? (doc.snapshotKeys ?? []).slice(0, LIST_THUMBNAIL_MAX)
          : [];
      const thumbnailUrls: string[] = [];
      for (const key of snapKeys) {
        thumbnailUrls.push(await this.s3.presignedGetUrl(key));
      }
      items.push({
        jobId: doc.jobId,
        originalFilename: doc.originalFilename ?? 'video',
        createdAt: doc.createdAt,
        status,
        errorMessage: doc.errorMessage ?? null,
        thumbnailUrl: thumbnailUrls[0],
        thumbnailUrls,
        surfSessionId: doc.surfSessionId ?? null,
      });
    }

    return items;
  }

  async getJob(userId: string, jobId: string): Promise<VideoJobDetailDto> {
    const doc = await this.videoJobModel
      .findOne({ jobId, userId })
      .lean()
      .exec();
    if (!doc) {
      throw new NotFoundException(`Video job not found: ${jobId}`);
    }

    const status = normalizeJobStatus(doc);

    if (status === 'processing') {
      return {
        jobId: doc.jobId,
        originalFilename: doc.originalFilename ?? 'video',
        createdAt: doc.createdAt,
        status: 'processing',
        errorMessage: null,
        snapshots: [],
        surfSessionId: doc.surfSessionId ?? null,
      };
    }

    if (status === 'failed') {
      return {
        jobId: doc.jobId,
        originalFilename: doc.originalFilename ?? 'video',
        createdAt: doc.createdAt,
        status: 'failed',
        errorMessage: doc.errorMessage ?? 'Processing failed',
        snapshots: [],
        surfSessionId: doc.surfSessionId ?? null,
      };
    }

    if (!doc.processedKey) {
      return {
        jobId: doc.jobId,
        originalFilename: doc.originalFilename ?? 'video',
        createdAt: doc.createdAt,
        status: 'processing',
        errorMessage: null,
        snapshots: [],
        surfSessionId: doc.surfSessionId ?? null,
      };
    }

    const videoUrl = await this.s3.presignedGetUrl(doc.processedKey);
    const snapshots: VideoJobDetailDto['snapshots'] = [];
    for (const snapKey of doc.snapshotKeys ?? []) {
      snapshots.push({
        key: snapKey,
        url: await this.s3.presignedGetUrl(snapKey),
      });
    }

    return {
      jobId: doc.jobId,
      originalFilename: doc.originalFilename ?? 'video',
      createdAt: doc.createdAt,
      status: 'completed',
      errorMessage: null,
      processedKey: doc.processedKey,
      videoUrl,
      snapshots,
      surfSessionId: doc.surfSessionId ?? null,
    };
  }
}
