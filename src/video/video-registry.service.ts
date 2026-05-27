import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { validate as uuidValidate, version as uuidVersion } from 'uuid';
import { S3Service } from '../s3/s3.service';
import { StudioService } from '../studio/studio.service';
import { WaveUnlockOrder } from '../commercial/schemas/wave-unlock-order.schema';
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
  discoverPublishedAt?: string | null;
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
    private readonly studio: StudioService,
    @InjectModel(VideoJob.name)
    private readonly videoJobModel: Model<VideoJob>,
    @InjectModel(WaveUnlockOrder.name)
    private readonly waveUnlockOrderModel: Model<WaveUnlockOrder>,
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
        discoverPublishedAt: doc.discoverPublishedAt ?? null,
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

  async deleteJob(userId: string, jobId: string): Promise<{ jobId: string }> {
    const doc = await this.videoJobModel
      .findOne({ jobId, userId })
      .lean()
      .exec();
    if (!doc) {
      throw new NotFoundException(`Video job not found: ${jobId}`);
    }

    const sessionId =
      typeof doc.surfSessionId === 'string' && doc.surfSessionId.trim()
        ? doc.surfSessionId.trim()
        : null;
    if (sessionId) {
      await this.studio.assertSessionOpenForUpload(userId, sessionId);
    }

    if (doc.discoverPublishedAt) {
      throw new BadRequestException(
        'Cannot remove a wave that is on the discover feed',
      );
    }
    if (doc.claimedByUserId || doc.videoUnlockedForUserId) {
      throw new BadRequestException(
        'Cannot remove a wave that has been claimed or unlocked',
      );
    }

    const prefix = `videos/${userId}/${jobId}/`;
    await Promise.all([
      this.s3.deletePrefix(prefix),
      this.s3.deletePrefixRaw(prefix),
    ]);

    // Best-effort: remove any wave_unlock_orders that reference this job. In
    // the new model these are per-checkout-session and may include unrelated
    // jobs, so we pull just this jobId out rather than deleting whole orders.
    await this.waveUnlockOrderModel
      .updateMany({ jobIds: jobId }, { $pull: { jobIds: jobId } })
      .exec();
    await this.videoJobModel.deleteOne({ jobId, userId }).exec();

    return { jobId };
  }
}
