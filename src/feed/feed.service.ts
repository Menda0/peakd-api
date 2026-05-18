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

export interface DiscoverFeedSessionDto {
  sessionDate: string;
  sessionTime: string;
  durationMinutes: number;
  conditionsRating: number | null;
  waveTypes: string[];
}

export interface DiscoverFeedItemDto {
  jobId: string;
  createdAt: string;
  status: VideoJobStatus;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  author: DiscoverFeedAuthorDto;
  location: DiscoverFeedLocationDto;
  session: DiscoverFeedSessionDto;
  shakaCount: number;
  followedByViewer: boolean;
  claimStatus: VideoClaimStatus;
  uploadSource: 'studio' | 'personal';
  claimedByViewer: boolean;
  isOwnUpload: boolean;
  surfer: SurferProfileDto | null;
}

export interface SurferProfileDto {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  surfLevel: string | null;
  countryCode: string | null;
  regionName: string | null;
}

export interface FilmedByDto {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface MyVideoItemDto {
  jobId: string;
  createdAt: string;
  status: VideoJobStatus;
  thumbnailUrl: string | null;
  videoUrl: string | null;
  location: DiscoverFeedLocationDto;
  session: DiscoverFeedSessionDto;
  claimStatus: VideoClaimStatus;
  discoverPublishedAt: string | null;
  uploadSource: 'studio' | 'personal';
  surfer: SurferProfileDto | null;
  filmedBy: FilmedByDto | null;
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
  claimedByUserId?: string | null;
  discoverPublishedAt?: string | null;
  session: {
    countryCode: string;
    regionId: string;
    spotId: string;
    sessionDate: string;
    sessionTime?: string;
    durationMinutes?: number;
    conditionsRating?: number | null;
    waveTypes?: string[];
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

  async claimVideoWave(
    viewerUserId: string,
    jobId: string,
  ): Promise<{
    jobId: string;
    claimStatus: VideoClaimStatus;
    claimedAt: string;
    surfer: SurferProfileDto;
  }> {
    const doc = await this.videoJobModel.findOne({ jobId }).lean().exec();
    if (!doc) {
      throw new NotFoundException(`Video job not found: ${jobId}`);
    }
    if (doc.uploadSource !== 'studio') {
      throw new BadRequestException('Only partner studio uploads can be claimed');
    }
    if (!this.isCompleted(doc)) {
      throw new BadRequestException('Only completed videos can be claimed');
    }
    if (!doc.discoverPublishedAt) {
      throw new BadRequestException('Video must be published to discover before claiming');
    }
    if (doc.claimStatus === 'claimed') {
      if (doc.claimedByUserId === viewerUserId) {
        throw new ConflictException('You have already claimed this wave');
      }
      throw new ConflictException('This wave has already been claimed');
    }
    if (doc.claimStatus === 'auto') {
      throw new BadRequestException('Personal uploads are auto-claimed');
    }

    const claimedAt = new Date().toISOString();
    await this.videoJobModel
      .updateOne(
        { jobId, claimStatus: 'none' },
        {
          $set: {
            claimStatus: 'claimed',
            claimedAt,
            claimedByUserId: viewerUserId,
          },
        },
      )
      .exec();

    const updated = await this.videoJobModel.findOne({ jobId }).lean().exec();
    if (updated?.claimStatus !== 'claimed') {
      throw new ConflictException('This wave has already been claimed');
    }

    const surfer = await this.buildSurferDto(viewerUserId);
    return { jobId, claimStatus: 'claimed', claimedAt, surfer };
  }

  private async buildSurferDto(userId: string): Promise<SurferProfileDto> {
    const profile = await this.userProfileModel.findOne({ userId }).lean().exec();
    const avatarUrl = await this.resolveAvatarUrl(profile?.avatarKey ?? null);
    const homeRegionId = profile?.homeRegionId?.trim() || null;
    let regionName: string | null = null;
    if (homeRegionId) {
      const region = await this.regionModel
        .findOne({ regionId: homeRegionId })
        .lean()
        .exec();
      regionName = region?.name?.trim() || null;
    }
    return {
      userId,
      displayName: profile?.displayName ?? null,
      avatarUrl,
      surfLevel: profile?.surfLevel ?? null,
      countryCode: profile?.countryCode?.trim().toUpperCase() || null,
      regionName,
    };
  }

  private surferUserIdFromDoc(doc: {
    userId: string;
    claimStatus?: VideoClaimStatus;
    claimedByUserId?: string | null;
  }): string | null {
    const claimStatus = doc.claimStatus ?? 'none';
    if (claimStatus === 'claimed') {
      const claimedBy = doc.claimedByUserId?.trim();
      if (claimedBy) return claimedBy;
    }
    if (claimStatus === 'auto') {
      const uploader = doc.userId?.trim();
      if (uploader) return uploader;
    }
    return null;
  }

  private async resolveFeedSurfer(doc: {
    userId: string;
    claimStatus?: VideoClaimStatus;
    claimedByUserId?: string | null;
  }): Promise<SurferProfileDto | null> {
    const surferId = this.surferUserIdFromDoc(doc);
    if (!surferId) return null;
    return this.buildSurferDto(surferId);
  }

  private async buildDiscoverAuthor(
    userId: string,
    uploadSource: 'studio' | 'personal' | undefined,
    authorProfile: {
      displayName?: string | null;
      avatarKey?: string | null;
    } | null,
    partnerProfile: {
      partnerName?: string | null;
      avatarKey?: string | null;
    } | null,
  ): Promise<DiscoverFeedAuthorDto> {
    const isStudio = uploadSource !== 'personal';
    const displayName =
      isStudio && partnerProfile?.partnerName?.trim()
        ? partnerProfile.partnerName.trim()
        : authorProfile?.displayName?.trim() || null;
    const avatarKey =
      (isStudio
        ? partnerProfile?.avatarKey?.trim() || authorProfile?.avatarKey?.trim()
        : authorProfile?.avatarKey?.trim()) || null;
    const avatarUrl = await this.resolveAvatarUrl(avatarKey);
    return {
      userId,
      displayName,
      avatarUrl,
      isPartner: Boolean(partnerProfile),
    };
  }

  private async buildFilmedByDto(userId: string): Promise<FilmedByDto> {
    const [userProfile, partnerProfile] = await Promise.all([
      this.userProfileModel.findOne({ userId }).lean().exec(),
      this.partnerProfileModel.findOne({ userId }).lean().exec(),
    ]);
    const partner = partnerProfile as {
      partnerName?: string;
      avatarKey?: string | null;
    } | null;
    const displayName =
      partner?.partnerName?.trim() ||
      userProfile?.displayName?.trim() ||
      null;
    const avatarKey =
      partner?.avatarKey?.trim() || userProfile?.avatarKey?.trim() || null;
    const avatarUrl = await this.resolveAvatarUrl(avatarKey);
    return {
      userId,
      displayName,
      avatarUrl,
    };
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
      items.push(await this.docToDiscoverDto(doc, 'processing', viewerUserId));
    }
    return items;
  }

  async listMyVideos(userId: string): Promise<MyVideoItemDto[]> {
    const [personalRows, claimedRows] = await Promise.all([
      this.videoJobModel
        .find({ userId, uploadSource: 'personal' })
        .sort({ createdAt: -1 })
        .lean()
        .exec(),
      this.videoJobModel
        .find({ claimedByUserId: userId, claimStatus: 'claimed' })
        .sort({ createdAt: -1 })
        .lean()
        .exec(),
    ]);

    const surfer = await this.buildSurferDto(userId);
    const byJobId = new Map<string, (typeof personalRows)[number]>();
    for (const doc of personalRows) {
      byJobId.set(doc.jobId, doc);
    }
    for (const doc of claimedRows) {
      byJobId.set(doc.jobId, doc);
    }

    const sorted = [...byJobId.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    const items: MyVideoItemDto[] = [];
    for (const doc of sorted) {
      const dto = await this.docToDiscoverDto(
        doc,
        this.normalizeStatus(doc),
        userId,
      );
      const isViewerSurfer =
        (doc.uploadSource === 'personal' && doc.claimStatus === 'auto') ||
        (doc.uploadSource === 'studio' &&
          doc.claimStatus === 'claimed' &&
          doc.claimedByUserId === userId);
      const filmedBy =
        doc.uploadSource === 'studio' &&
        doc.claimStatus === 'claimed' &&
        doc.userId !== userId
          ? await this.buildFilmedByDto(doc.userId)
          : null;
      items.push({
        jobId: dto.jobId,
        createdAt: dto.createdAt,
        status: dto.status,
        thumbnailUrl: dto.thumbnailUrl,
        videoUrl: dto.videoUrl,
        location: dto.location,
        session: dto.session,
        claimStatus: dto.claimStatus,
        discoverPublishedAt: doc.discoverPublishedAt ?? null,
        uploadSource: doc.uploadSource === 'personal' ? 'personal' : 'studio',
        surfer: isViewerSurfer ? surfer : null,
        filmedBy,
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
      {
        $addFields: {
          surferUserId: {
            $switch: {
              branches: [
                {
                  case: { $eq: ['$claimStatus', 'claimed'] },
                  then: '$claimedByUserId',
                },
                {
                  case: { $eq: ['$claimStatus', 'auto'] },
                  then: '$userId',
                },
              ],
              default: null,
            },
          },
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
      items.push(await this.rowToDto(row, viewerUserId));
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

  private sessionToDto(session: {
    sessionDate: string;
    sessionTime?: string;
    durationMinutes?: number;
    conditionsRating?: number | null;
    waveTypes?: string[];
  }): DiscoverFeedSessionDto {
    const rating = session.conditionsRating;
    const conditionsRating =
      typeof rating === 'number' &&
      Number.isInteger(rating) &&
      rating >= 1 &&
      rating <= 5
        ? rating
        : null;
    return {
      sessionDate: session.sessionDate,
      sessionTime: session.sessionTime?.trim() || '12:00',
      durationMinutes:
        typeof session.durationMinutes === 'number' &&
        session.durationMinutes >= 15
          ? session.durationMinutes
          : 120,
      conditionsRating,
      waveTypes: Array.isArray(session.waveTypes)
        ? session.waveTypes.filter((w) => typeof w === 'string')
        : [],
    };
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
      claimedByUserId?: string | null;
    },
    status: VideoJobStatus,
    viewerUserId: string,
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

    let videoUrl: string | null = null;
    let thumbnailUrl: string | null = null;
    if (status === 'completed' && doc.processedKey) {
      videoUrl = await this.s3.presignedGetUrl(doc.processedKey);
      const snapKey = doc.snapshotKeys?.[0];
      if (snapKey) {
        thumbnailUrl = await this.s3.presignedGetUrl(snapKey);
      }
    }

    const [author, surfer] = await Promise.all([
      this.buildDiscoverAuthor(
        doc.userId,
        doc.uploadSource,
        authorProfile,
        partnerProfile as { partnerName?: string | null; avatarKey?: string | null } | null,
      ),
      this.resolveFeedSurfer(doc),
    ]);

    return {
      jobId: doc.jobId,
      createdAt: doc.createdAt,
      status,
      videoUrl,
      thumbnailUrl,
      author,
      location: {
        countryCode,
        regionName: regionName || 'Unknown',
        spotName,
        isUndisclosed,
      },
      session: this.sessionToDto(session),
      shakaCount: 0,
      followedByViewer: false,
      claimStatus: doc.claimStatus ?? 'none',
      uploadSource: doc.uploadSource === 'personal' ? 'personal' : 'studio',
      claimedByViewer: doc.claimedByUserId === viewerUserId,
      isOwnUpload: doc.userId === viewerUserId,
      surfer,
    };
  }

  private async rowToDto(
    row: AggregatedRow,
    viewerUserId: string,
  ): Promise<DiscoverFeedItemDto> {
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
    const partnerDoc = row.partnerProfile?.[0] as
      | { partnerName?: string | null; avatarKey?: string | null }
      | undefined;

    const processedKey = row.processedKey!;
    const videoUrl = await this.s3.presignedGetUrl(processedKey);
    const snapKey = row.snapshotKeys?.[0];
    const thumbnailUrl = snapKey
      ? await this.s3.presignedGetUrl(snapKey)
      : null;

    const [author, surfer] = await Promise.all([
      this.buildDiscoverAuthor(
        row.userId,
        row.uploadSource,
        authorDoc ?? null,
        partnerDoc ?? null,
      ),
      this.resolveFeedSurfer(row),
    ]);

    return {
      jobId: row.jobId,
      createdAt: row.createdAt,
      status: this.normalizeStatus(row),
      videoUrl,
      thumbnailUrl,
      author,
      location: {
        countryCode,
        regionName: regionName || 'Unknown',
        spotName,
        isUndisclosed,
      },
      session: this.sessionToDto(session),
      shakaCount: 0,
      followedByViewer: false,
      claimStatus: row.claimStatus ?? 'none',
      uploadSource: row.uploadSource === 'personal' ? 'personal' : 'studio',
      claimedByViewer: row.claimedByUserId === viewerUserId,
      isOwnUpload: row.userId === viewerUserId,
      surfer,
    };
  }
}
