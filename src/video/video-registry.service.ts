import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { validate as uuidValidate, version as uuidVersion } from 'uuid';
import { S3Service } from '../s3/s3.service';
import { VideoJob } from './schemas/video-job.schema';

export interface VideoJobListItemDto {
  jobId: string;
  originalFilename: string;
  createdAt: string;
  thumbnailUrl?: string;
  surfSessionId?: string | null;
}

export interface VideoJobDetailDto {
  jobId: string;
  originalFilename: string;
  createdAt: string;
  processedKey: string;
  videoUrl: string;
  snapshots: Array<{ key: string; url: string }>;
  surfSessionId?: string | null;
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
      const firstSnap = doc.snapshotKeys?.[0];
      let thumbnailUrl: string | undefined;
      if (firstSnap) {
        thumbnailUrl = await this.s3.presignedGetUrl(firstSnap);
      }
      items.push({
        jobId: doc.jobId,
        originalFilename: doc.originalFilename ?? 'video',
        createdAt: doc.createdAt,
        thumbnailUrl,
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
      processedKey: doc.processedKey,
      videoUrl,
      snapshots,
      surfSessionId: doc.surfSessionId ?? null,
    };
  }
}
