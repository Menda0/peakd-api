import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage } from 'mongoose';
import { S3Service } from '../s3/s3.service';
import {
  isUndisclosedRegionId,
  isUndisclosedSpotId,
} from '../studio/geo-undisclosed';
import { SurfSession } from '../studio/schemas/surf-session.schema';
import { UserProfile } from '../users/schemas/user-profile.schema';
import { VideoJob } from '../video/schemas/video-job.schema';
import {
  buildCursorMatchFilter,
  buildRelevanceTierExpression,
  decodeDiscoverCursor,
  encodeDiscoverCursor,
  type DiscoverCursor,
} from './discover-ranking';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export interface DiscoverFeedAuthorDto {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  isPartner: boolean;
}

export interface DiscoverFeedLocationDto {
  countryCode: string;
  regionName: string;
  spotName: string | null;
  isUndisclosed: boolean;
}

export interface DiscoverFeedItemDto {
  jobId: string;
  createdAt: string;
  videoUrl: string;
  thumbnailUrl: string | null;
  title: string;
  author: DiscoverFeedAuthorDto;
  location: DiscoverFeedLocationDto;
  shakaCount: number;
  followedByViewer: boolean;
}

export interface DiscoverFeedPageDto {
  items: DiscoverFeedItemDto[];
  nextCursor: string | null;
  hasMore: boolean;
}

type AggregatedRow = {
  jobId: string;
  userId: string;
  originalFilename: string;
  createdAt: string;
  processedKey?: string;
  snapshotKeys?: string[];
  relevanceTier: number;
  session: {
    countryCode: string;
    regionId: string;
    spotId: string;
  };
  authorProfile?: Array<{
    displayName: string | null;
    avatarKey: string | null;
  }>;
  partnerProfile?: Array<Record<string, unknown>>;
  region?: Array<{ name: string }>;
  spot?: Array<{ name: string }>;
};

@Injectable()
export class FeedService {
  constructor(
    @InjectModel(VideoJob.name)
    private readonly videoJobModel: Model<VideoJob>,
    @InjectModel(SurfSession.name)
    private readonly surfSessionModel: Model<SurfSession>,
    @InjectModel(UserProfile.name)
    private readonly userProfileModel: Model<UserProfile>,
    private readonly s3: S3Service,
    private readonly config: ConfigService,
  ) {}

  private parseLimit(raw: string | undefined): number {
    if (!raw?.trim()) return DEFAULT_LIMIT;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
    return Math.min(n, MAX_LIMIT);
  }

  private async resolveAvatarUrl(avatarKey: string | null): Promise<string | null> {
    if (!avatarKey) return null;
    const publicBase = this.config.get<string>('S3_PUBLIC_BASE_URL')?.trim();
    if (publicBase) {
      return `${publicBase.replace(/\/+$/, '')}/${avatarKey}`;
    }
    const expiry = Number(
      this.config.get<string>('USER_AVATAR_GET_URL_EXPIRY_SECONDS') ?? '604800',
    );
    return this.s3.presignedGetUrl(avatarKey, expiry);
  }

  private isCompleted(doc: { status?: string; processedKey?: string | null }): boolean {
    if (doc.status === 'completed') return true;
    return Boolean(doc.processedKey?.trim());
  }

  async publishVideoToDiscover(
    userId: string,
    jobId: string,
  ): Promise<{ jobId: string; discoverPublishedAt: string }> {
    const doc = await this.videoJobModel.findOne({ jobId, userId }).lean().exec();
    if (!doc) {
      throw new NotFoundException(`Video job not found: ${jobId}`);
    }
    if (!this.isCompleted(doc)) {
      throw new BadRequestException('Only completed videos can be published to discover');
    }
    if (doc.discoverPublishedAt) {
      throw new ConflictException('Video is already published to discover');
    }
    const sessionId = doc.surfSessionId?.trim();
    if (!sessionId) {
      throw new BadRequestException('Video must belong to a surf session');
    }
    const session = await this.surfSessionModel
      .findOne({ sessionId, userId })
      .lean()
      .exec();
    if (!session) {
      throw new NotFoundException('Surf session not found for this video');
    }
    if (session.status !== 'closed') {
      throw new BadRequestException(
        'Close the surf session before publishing to discover',
      );
    }

    const discoverPublishedAt = new Date().toISOString();
    await this.videoJobModel
      .updateOne({ jobId, userId }, { $set: { discoverPublishedAt } })
      .exec();

    return { jobId, discoverPublishedAt };
  }

  async listDiscoverFeed(
    viewerUserId: string,
    options: { limit?: string; cursor?: string },
  ): Promise<DiscoverFeedPageDto> {
    const limit = this.parseLimit(options.limit);
    const cursorRaw = options.cursor?.trim();
    let cursor: DiscoverCursor | null = null;
    if (cursorRaw) {
      cursor = decodeDiscoverCursor(cursorRaw);
      if (!cursor) {
        throw new BadRequestException('Invalid cursor');
      }
    }

    const profile = await this.userProfileModel
      .findOne({ userId: viewerUserId })
      .lean()
      .exec();

    const viewerCountryCode =
      profile?.countryCode?.trim().toUpperCase() || null;
    const viewerHomeRegionId = profile?.homeRegionId?.trim() || null;

    const pipeline: PipelineStage[] = [
      {
        $match: {
          discoverPublishedAt: { $ne: null },
          status: 'completed',
          processedKey: { $exists: true, $ne: null },
          surfSessionId: { $ne: null },
        },
      },
      {
        $lookup: {
          from: 'surf_sessions',
          localField: 'surfSessionId',
          foreignField: 'sessionId',
          as: 'session',
        },
      },
      { $unwind: { path: '$session', preserveNullAndEmptyArrays: false } },
      {
        $lookup: {
          from: 'user_profiles',
          localField: 'userId',
          foreignField: 'userId',
          as: 'authorProfile',
        },
      },
      {
        $lookup: {
          from: 'partner_profiles',
          localField: 'userId',
          foreignField: 'userId',
          as: 'partnerProfile',
        },
      },
      {
        $lookup: {
          from: 'regions',
          localField: 'session.regionId',
          foreignField: 'regionId',
          as: 'region',
        },
      },
      {
        $lookup: {
          from: 'spots',
          localField: 'session.spotId',
          foreignField: 'spotId',
          as: 'spot',
        },
      },
      {
        $addFields: {
          relevanceTier: buildRelevanceTierExpression(
            viewerCountryCode,
            viewerHomeRegionId,
          ),
        },
      },
    ];

    if (cursor) {
      pipeline.push({
        $match: buildCursorMatchFilter(cursor),
      } as PipelineStage);
    }

    pipeline.push(
      { $sort: { relevanceTier: 1, createdAt: -1, jobId: -1 } },
      { $limit: limit + 1 },
    );

    const rows = (await this.videoJobModel
      .aggregate(pipeline)
      .exec()) as AggregatedRow[];

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const items: DiscoverFeedItemDto[] = [];
    for (const row of pageRows) {
      items.push(await this.rowToDto(row));
    }

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1]!;
      nextCursor = encodeDiscoverCursor({
        tier: last.relevanceTier,
        createdAt: last.createdAt,
        jobId: last.jobId,
      });
    }

    return { items, nextCursor, hasMore };
  }

  private async rowToDto(row: AggregatedRow): Promise<DiscoverFeedItemDto> {
    const session = row.session;
    const countryCode = session.countryCode;
    const isUndisclosed =
      isUndisclosedRegionId(session.regionId, countryCode) ||
      isUndisclosedSpotId(session.spotId, countryCode);

    const regionName =
      row.region?.[0]?.name?.trim() ||
      (isUndisclosedRegionId(session.regionId, countryCode) ? 'Undisclosed' : '');

    const spotName = isUndisclosed
      ? null
      : row.spot?.[0]?.name?.trim() || null;

    const authorDoc = row.authorProfile?.[0];
    const avatarUrl = await this.resolveAvatarUrl(authorDoc?.avatarKey ?? null);

    const processedKey = row.processedKey!;
    const videoUrl = await this.s3.presignedGetUrl(processedKey);
    const snapKey = row.snapshotKeys?.[0];
    const thumbnailUrl = snapKey
      ? await this.s3.presignedGetUrl(snapKey)
      : null;

    return {
      jobId: row.jobId,
      createdAt: row.createdAt,
      videoUrl,
      thumbnailUrl,
      title: row.originalFilename?.replace(/\.[^.]+$/, '') || 'Surf video',
      author: {
        userId: row.userId,
        displayName: authorDoc?.displayName ?? null,
        avatarUrl,
        isPartner: (row.partnerProfile?.length ?? 0) > 0,
      },
      location: {
        countryCode,
        regionName: regionName || 'Unknown',
        spotName,
        isUndisclosed,
      },
      shakaCount: 0,
      followedByViewer: false,
    };
  }
}
