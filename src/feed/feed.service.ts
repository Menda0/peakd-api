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
import { Region } from '../studio/schemas/region.schema';
import { Spot } from '../studio/schemas/spot.schema';
import { SurfSession } from '../studio/schemas/surf-session.schema';
import { PartnerProfile } from '../partner/schemas/partner-profile.schema';
import { UserProfile } from '../users/schemas/user-profile.schema';
import { VideoJob } from '../video/schemas/video-job.schema';
import type { VideoJobStatus } from '../video/schemas/video-job.schema';
import type { VideoClaimStatus } from '../video/schemas/video-job.schema';
import {
  buildCursorMatchFilter,
  buildFeedSortTierExpression,
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
  status: VideoJobStatus;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  title: string;
  author: DiscoverFeedAuthorDto;
  location: DiscoverFeedLocationDto;
  shakaCount: number;
  followedByViewer: boolean;
  claimStatus: VideoClaimStatus;
  uploadSource: 'studio' | 'personal';
}

export interface MyVideoItemDto {
  jobId: string;
  createdAt: string;
  status: VideoJobStatus;
  title: string;
  thumbnailUrl: string | null;
  videoUrl: string | null;
  location: DiscoverFeedLocationDto;
  claimStatus: VideoClaimStatus;
  discoverPublishedAt: string | null;
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
  feedSortTier: number;
  status: VideoJobStatus;
  uploadSource: 'studio' | 'personal';
  claimStatus: VideoClaimStatus;
  discoverPublishedAt?: string | null;
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
    @InjectModel(PartnerProfile.name)
    private readonly partnerProfileModel: Model<PartnerProfile>,
    @InjectModel(Region.name)
    private readonly regionModel: Model<Region>,
    @InjectModel(Spot.name)
    private readonly spotModel: Model<Spot>,
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
    if (doc.uploadSource === 'personal') {
      throw new BadRequestException(
        'Personal uploads are published automatically when processing completes',
      );
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

  private async listViewerProcessingPersonal(
    viewerUserId: string,
  ): Promise<DiscoverFeedItemDto[]> {
    const rows = await this.videoJobModel
      .find({
        userId: viewerUserId,
        uploadSource: 'personal',
        status: 'processing',
      })
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    const items: DiscoverFeedItemDto[] = [];
    for (const doc of rows) {
      items.push(await this.docToDiscoverDto(doc, 'processing'));
    }
    return items;
  }

  async listMyVideos(userId: string): Promise<MyVideoItemDto[]> {
    const rows = await this.videoJobModel
      .find({ userId, uploadSource: 'personal' })
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    const items: MyVideoItemDto[] = [];
    for (const doc of rows) {
      const dto = await this.docToDiscoverDto(
        doc,
        this.normalizeStatus(doc),
      );
      items.push({
        jobId: dto.jobId,
        createdAt: dto.createdAt,
        status: dto.status,
        title: dto.title,
        thumbnailUrl: dto.thumbnailUrl,
        videoUrl: dto.videoUrl,
        location: dto.location,
        claimStatus: dto.claimStatus,
        discoverPublishedAt: doc.discoverPublishedAt ?? null,
      });
    }
    return items;
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

    const pending =
      cursor === null
        ? await this.listViewerProcessingPersonal(viewerUserId)
        : [];

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
      {
        $addFields: {
          feedSortTier: buildFeedSortTierExpression(
            viewerUserId,
            '$relevanceTier',
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
      { $sort: { feedSortTier: 1, createdAt: -1, jobId: -1 } },
      { $limit: limit + 1 },
    );

    const rows = (await this.videoJobModel
      .aggregate(pipeline)
      .exec()) as AggregatedRow[];

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const items: DiscoverFeedItemDto[] = [...pending];
    for (const row of pageRows) {
      items.push(await this.rowToDto(row));
    }

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1]!;
      nextCursor = encodeDiscoverCursor({
        tier: last.feedSortTier,
        createdAt: last.createdAt,
        jobId: last.jobId,
      });
    }

    return { items, nextCursor, hasMore };
  }

  private normalizeStatus(doc: {
    status?: VideoJobStatus;
    processedKey?: string | null;
  }): VideoJobStatus {
    if (doc.status === 'failed' || doc.status === 'processing') {
      return doc.status;
    }
    if (doc.status === 'completed' || doc.processedKey?.trim()) {
      return 'completed';
    }
    return 'processing';
  }

  private async docToDiscoverDto(
    doc: {
      jobId: string;
      userId: string;
      originalFilename: string;
      createdAt: string;
      processedKey?: string;
      snapshotKeys?: string[];
      surfSessionId?: string | null;
      status?: VideoJobStatus;
      uploadSource?: 'studio' | 'personal';
      claimStatus?: VideoClaimStatus;
    },
    status: VideoJobStatus,
  ): Promise<DiscoverFeedItemDto> {
    const sessionId = doc.surfSessionId?.trim();
    if (!sessionId) {
      throw new Error('Video missing surf session');
    }
    const session = await this.surfSessionModel
      .findOne({ sessionId })
      .lean()
      .exec();
    if (!session) {
      throw new Error('Surf session not found');
    }
    const [authorProfile, partnerProfile, region, spot] = await Promise.all([
      this.userProfileModel.findOne({ userId: doc.userId }).lean().exec(),
      this.partnerProfileModel.findOne({ userId: doc.userId }).lean().exec(),
      this.regionModel.findOne({ regionId: session.regionId }).lean().exec(),
      this.spotModel.findOne({ spotId: session.spotId }).lean().exec(),
    ]);

    const countryCode = session.countryCode;
    const isUndisclosed =
      isUndisclosedRegionId(session.regionId, countryCode) ||
      isUndisclosedSpotId(session.spotId, countryCode);
    const regionName =
      region?.name?.trim() ||
      (isUndisclosedRegionId(session.regionId, countryCode) ? 'Undisclosed' : '');
    const spotName = isUndisclosed ? null : spot?.name?.trim() || null;

    const avatarUrl = await this.resolveAvatarUrl(
      authorProfile?.avatarKey ?? null,
    );

    let videoUrl: string | null = null;
    let thumbnailUrl: string | null = null;
    if (status === 'completed' && doc.processedKey) {
      videoUrl = await this.s3.presignedGetUrl(doc.processedKey);
      const snapKey = doc.snapshotKeys?.[0];
      if (snapKey) {
        thumbnailUrl = await this.s3.presignedGetUrl(snapKey);
      }
    }

    return {
      jobId: doc.jobId,
      createdAt: doc.createdAt,
      status,
      videoUrl,
      thumbnailUrl,
      title: doc.originalFilename?.replace(/\.[^.]+$/, '') || 'Surf video',
      author: {
        userId: doc.userId,
        displayName: authorProfile?.displayName ?? null,
        avatarUrl,
        isPartner: Boolean(partnerProfile),
      },
      location: {
        countryCode,
        regionName: regionName || 'Unknown',
        spotName,
        isUndisclosed,
      },
      shakaCount: 0,
      followedByViewer: false,
      claimStatus: doc.claimStatus ?? 'none',
      uploadSource: doc.uploadSource === 'personal' ? 'personal' : 'studio',
    };
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
      status: this.normalizeStatus(row),
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
      claimStatus: row.claimStatus ?? 'none',
      uploadSource: row.uploadSource === 'personal' ? 'personal' : 'studio',
    };
  }
}
