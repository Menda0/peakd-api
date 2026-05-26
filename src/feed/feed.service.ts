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
  isSessionLocationUndisclosed,
  isUndisclosedRegionId,
  isUndisclosedSpotId,
} from '../studio/geo-undisclosed';
import type { CheckoutOptions } from '../commercial/commercial-pricing';
import { Region } from '../studio/schemas/region.schema';
import { Spot } from '../studio/schemas/spot.schema';
import { SurfSession } from '../studio/schemas/surf-session.schema';
import { PartnerProfile } from '../partner/schemas/partner-profile.schema';
import { UserProfile } from '../users/schemas/user-profile.schema';
import { CommercialWaveService } from '../commercial/commercial-wave.service';
import {
  allocateBuyClaimLineBreakdowns,
  checkoutBreakdownWithDiscount,
  computeBuyClaimPeaks,
  computeCheckoutTotal,
  computeSponsorPeaks,
  COMMUNITY_FEE_PERCENT,
  resolveEffectiveCommercialSettings,
} from '../commercial/commercial-pricing';
import type { CommercialSettings } from '../commercial/commercial-settings.types';
import { VideoJob } from '../video/schemas/video-job.schema';
import type { VideoJobStatus } from '../video/schemas/video-job.schema';
import type { VideoClaimStatus } from '../video/schemas/video-job.schema';
import { VideoShaka } from './schemas/video-shaka.schema';
import {
  buildCursorMatchFilter,
  decodeDiscoverCursor,
  decodeSearchSessionsCursor,
  encodeDiscoverCursor,
  encodeSearchSessionsCursor,
  searchSessionsCursorKey,
  type SearchSessionsCursor,
  type DiscoverCursor,
} from './discover-ranking';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const SNAPSHOT_URL_MAX = 4;
const DEFAULT_GEO_SUGGEST_LIMIT = 12;
const MAX_GEO_SUGGEST_LIMIT = 24;
const SEARCH_PREVIEW_THUMBS = 3;
const COUNTRY_CODE = /^[A-Z]{2}$/;
const SESSION_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_YM = /^\d{4}-\d{2}$/;
const UNDISCLOSED_REGION_PREFIX = 'undisclosed:region:';
const UNDISCLOSED_SPOT_PREFIX = 'undisclosed:spot:';

export interface GeoSuggestItemDto {
  type: 'country' | 'region' | 'spot';
  countryCode: string;
  regionId?: string;
  spotId?: string;
  label: string;
  name: string;
  verified: boolean;
}

export interface SearchSessionAuthorDto {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  isPartner: boolean;
  partnerType: 'videographer' | 'coach' | 'other' | null;
}

export interface SearchSessionSurferDto {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface SearchSessionDto {
  sessionId: string;
  shareToken: string | null;
  isCommercial: boolean;
  countryCode: string;
  regionId: string;
  spotId: string;
  sessionDate: string;
  sessionTime: string;
  durationMinutes: number;
  conditionsRating: number | null;
  waveTypes: string[];
  regionName: string;
  spotName: string | null;
  author: SearchSessionAuthorDto;
  surfers: SearchSessionSurferDto[];
  videoCount: number;
  previewThumbnailUrls: string[];
}

export interface SearchSessionsPageDto {
  sessions: SearchSessionDto[];
  nextCursor: string | null;
  hasMore: boolean;
}

const SEARCH_SESSIONS_DEFAULT_LIMIT = 10;
const SEARCH_SESSIONS_MAX_LIMIT = 50;

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
  shakaedByViewer: boolean;
  followedByViewer: boolean;
  claimStatus: VideoClaimStatus;
  uploadSource: 'studio' | 'personal';
  claimedByViewer: boolean;
  isOwnUpload: boolean;
  surfer: SurferProfileDto | null;
  isCommercial: boolean;
  snapshotUrls: string[];
  videoUnlockedByViewer: boolean;
  wavePricePeaks: number | null;
  buyClaimPricePeaks: number | null;
  sponsorPricePeaks: number | null;
  canClaim: boolean;
  canBuyClaim: boolean;
  canSponsor: boolean;
}

export interface SurferProfileDto {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  surfLevel: string | null;
  countryCode: string | null;
  regionName: string | null;
}

export interface CheckoutPeaksBreakdownDto {
  basePeaks: number;
  communityFeePeaks: number;
  totalPeaks: number;
  communityFeePercent: number;
  listPricePeaks: number;
  discountPercent: number;
  discountPeaksSaved: number;
}

export interface WaveCheckoutSessionWaveDto {
  jobId: string;
  originalFilename: string;
  thumbnailUrl: string | null;
  isCurrent: boolean;
  canBuyClaim: boolean;
  canSponsor: boolean;
  buyClaimTotalPeaks: number | null;
  sponsorTotalPeaks: number | null;
}

export type UnlockCartIntent = 'buy_claim' | 'sponsor';

export interface UnlockCartQuoteRequestItem {
  jobId: string;
  intent: UnlockCartIntent;
}

export interface UnlockCartQuoteLineDto {
  jobId: string;
  intent: UnlockCartIntent;
  videoName: string;
  sessionId: string;
  sessionLabel: string;
  thumbnailUrl: string | null;
  listPricePeaks: number;
  discountPercent: number;
  discountPeaksSaved: number;
  basePeaks: number;
  communityFeePeaks: number;
  totalPeaks: number;
  communityFeePercent: number;
}

export interface UnlockCartQuoteDto {
  lines: UnlockCartQuoteLineDto[];
  totalPeaks: number;
}

export interface WaveCheckoutContextDto {
  jobId: string;
  sessionId: string;
  shareToken: string | null;
  location: DiscoverFeedLocationDto;
  sessionSummary: DiscoverFeedSessionDto;
  partner: {
    partnerName: string;
    avatarUrl: string | null;
    descriptionMarkdown: string | null;
  };
  commercialSettings: CommercialSettings;
  communityFeePercent: number;
  canClaim: boolean;
  canBuyClaim: boolean;
  canSponsor: boolean;
  claimStatus: VideoClaimStatus;
  buyClaim: CheckoutPeaksBreakdownDto;
  sponsor: CheckoutPeaksBreakdownDto;
  surfer: SurferProfileDto | null;
  sessionWaves: WaveCheckoutSessionWaveDto[];
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
  isCommercial: boolean;
  snapshotUrls: string[];
  videoUnlockedByViewer: boolean;
  wavePricePeaks: number | null;
  buyClaimPricePeaks: number | null;
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
    isCommercial?: boolean;
    commercialSettings?: unknown;
  };
  videoUnlockedForUserId?: string | null;
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
    @InjectModel(VideoShaka.name)
    private readonly videoShakaModel: Model<VideoShaka>,
    private readonly s3: S3Service,
    private readonly config: ConfigService,
    private readonly commercialWave: CommercialWaveService,
  ) {}

  private async getShakaInfo(
    jobIds: string[],
    viewerUserId: string,
  ): Promise<Map<string, { count: number; viewerShaka: boolean }>> {
    const result = new Map<string, { count: number; viewerShaka: boolean }>();
    const ids = Array.from(new Set(jobIds.filter((id) => id?.trim())));
    if (ids.length === 0) return result;
    for (const id of ids) {
      result.set(id, { count: 0, viewerShaka: false });
    }
    const [counts, viewerRows] = await Promise.all([
      this.videoShakaModel
        .aggregate<{ _id: string; count: number }>([
          { $match: { jobId: { $in: ids } } },
          { $group: { _id: '$jobId', count: { $sum: 1 } } },
        ])
        .exec(),
      this.videoShakaModel
        .find({ jobId: { $in: ids }, userId: viewerUserId })
        .lean()
        .exec(),
    ]);
    for (const row of counts) {
      const entry = result.get(row._id);
      if (entry) entry.count = row.count;
    }
    for (const row of viewerRows) {
      const entry = result.get(row.jobId);
      if (entry) entry.viewerShaka = true;
    }
    return result;
  }

  private shakaInfoFor(
    map: Map<string, { count: number; viewerShaka: boolean }> | null,
    jobId: string,
  ): { count: number; viewerShaka: boolean } {
    return map?.get(jobId) ?? { count: 0, viewerShaka: false };
  }

  async shakaVideo(
    userId: string,
    jobId: string,
  ): Promise<{ shakaCount: number; shakaedByViewer: boolean }> {
    const trimmedJobId = jobId?.trim();
    if (!trimmedJobId) {
      throw new BadRequestException('jobId is required');
    }
    const job = await this.videoJobModel
      .findOne({ jobId: trimmedJobId })
      .lean()
      .exec();
    if (!job) {
      throw new NotFoundException('Video not found');
    }
    try {
      await this.videoShakaModel.create({
        jobId: trimmedJobId,
        userId,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      const code = (err as { code?: number } | null)?.code;
      if (code !== 11000) throw err;
    }
    const count = await this.videoShakaModel
      .countDocuments({ jobId: trimmedJobId })
      .exec();
    return { shakaCount: count, shakaedByViewer: true };
  }

  async unshakaVideo(
    userId: string,
    jobId: string,
  ): Promise<{ shakaCount: number; shakaedByViewer: boolean }> {
    const trimmedJobId = jobId?.trim();
    if (!trimmedJobId) {
      throw new BadRequestException('jobId is required');
    }
    await this.videoShakaModel
      .deleteOne({ jobId: trimmedJobId, userId })
      .exec();
    const count = await this.videoShakaModel
      .countDocuments({ jobId: trimmedJobId })
      .exec();
    return { shakaCount: count, shakaedByViewer: false };
  }

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

  private async presignSnapshotUrls(
    snapshotKeys?: string[],
  ): Promise<string[]> {
    const keys = (snapshotKeys ?? []).slice(0, SNAPSHOT_URL_MAX);
    const urls: string[] = [];
    for (const key of keys) {
      if (key?.trim()) {
        urls.push(await this.s3.presignedGetUrl(key));
      }
    }
    return urls;
  }

  private checkoutOptionsForSession(session: {
    countryCode: string;
    regionId: string;
    spotId: string;
  }): CheckoutOptions {
    return {
      waiveCommunityFee: isSessionLocationUndisclosed(
        session.countryCode,
        session.regionId,
        session.spotId,
      ),
    };
  }

  private commercialExtras(
    session: {
      isCommercial?: boolean;
      commercialSettings?: unknown;
      userId: string;
      countryCode: string;
      regionId: string;
      spotId: string;
    },
    partner: { commercialSettings?: unknown } | null,
    job: {
      claimStatus?: VideoClaimStatus;
      claimedByUserId?: string | null;
      videoUnlockedForUserId?: string | null;
    },
    viewerUserId: string,
  ): {
    isCommercial: boolean;
    snapshotUrls: string[];
    videoUnlockedByViewer: boolean;
    wavePricePeaks: number | null;
    buyClaimPricePeaks: number | null;
    sponsorPricePeaks: number | null;
    canClaim: boolean;
    canBuyClaim: boolean;
    canSponsor: boolean;
  } {
    const isCommercial = session.isCommercial === true;
    if (!isCommercial) {
      return {
        isCommercial: false,
        snapshotUrls: [],
        videoUnlockedByViewer: true,
        wavePricePeaks: null,
        buyClaimPricePeaks: null,
        sponsorPricePeaks: null,
        canClaim: false,
        canBuyClaim: false,
        canSponsor: false,
      };
    }
    const settings = resolveEffectiveCommercialSettings(
      {
        isCommercial: session.isCommercial,
        commercialSettings:
          session.commercialSettings as CommercialSettings | null,
      },
      partner as { commercialSettings?: CommercialSettings | null } | null,
    );
    const claimStatus = job.claimStatus ?? 'none';
    const unlockedFor = job.videoUnlockedForUserId?.trim() || null;
    const claimedBy = job.claimedByUserId?.trim() || null;
    const videoUnlockedByViewer = unlockedFor === viewerUserId;
    const checkoutOpts = this.checkoutOptionsForSession(session);
    const wavePricePeaks = settings?.videoPricePeaks ?? null;
    const buyClaimPricePeaks = settings
      ? computeCheckoutTotal(
          computeBuyClaimPeaks(settings, 1).totalPeaks,
          checkoutOpts,
        ).totalPeaks
      : null;
    const sponsorPricePeaks = settings
      ? computeCheckoutTotal(computeSponsorPeaks(settings, 1), checkoutOpts).totalPeaks
      : null;
    // The session owner (partner) can't buy or sponsor their own wave: the
    // backend rejects it because debit and credit would hit the same account
    // and effectively make the purchase free (and not change their balance).
    const viewerIsPartner = session.userId === viewerUserId;
    const canClaim =
      claimStatus === 'none' && !unlockedFor && !viewerIsPartner;
    const canBuyClaim =
      Boolean(settings && buyClaimPricePeaks != null) && !viewerIsPartner;
    const canSponsor =
      Boolean(settings) &&
      !unlockedFor &&
      !viewerIsPartner &&
      (claimStatus !== 'claimed' ||
        (Boolean(claimedBy) && claimedBy !== viewerUserId));
    return {
      isCommercial: true,
      snapshotUrls: [],
      videoUnlockedByViewer,
      wavePricePeaks,
      buyClaimPricePeaks,
      sponsorPricePeaks,
      canClaim,
      canBuyClaim,
      canSponsor,
    };
  }

  private formatUnlockCartSessionLabel(
    session: {
      sessionDate: string;
      sessionTime: string;
      countryCode: string;
      regionId: string;
      spotId: string;
    },
    regionName: string,
    spotName: string | null,
    isUndisclosed: boolean,
  ): string {
    const place = isUndisclosed
      ? regionName
      : spotName
        ? `${spotName}, ${regionName}`
        : regionName;
    return `${place} · ${session.sessionDate} · ${session.sessionTime}`;
  }

  async quoteUnlockCart(
    _viewerUserId: string,
    items: UnlockCartQuoteRequestItem[],
  ): Promise<UnlockCartQuoteDto> {
    if (!Array.isArray(items) || items.length === 0) {
      return { lines: [], totalPeaks: 0 };
    }

    type SessionMeta = {
      sessionLabel: string;
      regionName: string;
      spotName: string | null;
      isUndisclosed: boolean;
    };

    type Loaded = {
      jobId: string;
      intent: UnlockCartIntent;
      ctx: Awaited<ReturnType<CommercialWaveService['loadCommercialContext']>>;
      videoName: string;
      thumbnailUrl: string | null;
      sessionMeta: SessionMeta;
    };

    const sessionMetaCache = new Map<string, SessionMeta>();
    const loaded: Loaded[] = [];

    for (const item of items) {
      const jobId = item.jobId?.trim();
      if (!jobId) continue;
      const intent: UnlockCartIntent =
        item.intent === 'sponsor' ? 'sponsor' : 'buy_claim';
      const ctx = await this.commercialWave.loadCommercialContext(jobId);
      const sessionId = ctx.session.sessionId;

      let sessionMeta = sessionMetaCache.get(sessionId);
      if (!sessionMeta) {
        const fullSession = await this.surfSessionModel
          .findOne({ sessionId })
          .lean()
          .exec();
        if (!fullSession) {
          throw new BadRequestException('Session not found');
        }
        const cc = fullSession.countryCode;
        const isUndisclosed =
          isUndisclosedRegionId(fullSession.regionId, cc) ||
          isUndisclosedSpotId(fullSession.spotId, cc);
        const region = await this.regionModel
          .findOne({ regionId: fullSession.regionId })
          .lean()
          .exec();
        const spot = isUndisclosed
          ? null
          : await this.spotModel.findOne({ spotId: fullSession.spotId }).lean().exec();
        const regionName =
          region?.name?.trim() ||
          (isUndisclosedRegionId(fullSession.regionId, cc)
            ? 'Undisclosed'
            : 'Unknown');
        const spotName = isUndisclosed ? null : spot?.name?.trim() || null;
        sessionMeta = {
          regionName,
          spotName,
          isUndisclosed,
          sessionLabel: this.formatUnlockCartSessionLabel(
            fullSession,
            regionName,
            spotName,
            isUndisclosed,
          ),
        };
        sessionMetaCache.set(sessionId, sessionMeta);
      }

      const doc = await this.videoJobModel.findOne({ jobId }).lean().exec();
      let thumbnailUrl: string | null = null;
      const thumbKey = doc?.snapshotKeys?.[0];
      if (thumbKey) {
        thumbnailUrl = await this.s3.presignedGetUrl(thumbKey);
      }

      loaded.push({
        jobId,
        intent,
        ctx,
        videoName: doc?.originalFilename ?? 'video',
        thumbnailUrl,
        sessionMeta,
      });
    }

    const lines: UnlockCartQuoteLineDto[] = [];
    const buyClaimBySession = new Map<string, Loaded[]>();

    for (const row of loaded) {
      const checkoutOpts: CheckoutOptions = {
        waiveCommunityFee: row.sessionMeta.isUndisclosed,
      };
      if (row.intent === 'sponsor') {
        const sponsorBase = computeSponsorPeaks(row.ctx.settings, 1);
        const priced = checkoutBreakdownWithDiscount(
          sponsorBase,
          row.ctx.settings.videoPricePeaks,
          0,
          checkoutOpts,
        );
        lines.push({
          jobId: row.jobId,
          intent: 'sponsor',
          videoName: row.videoName,
          sessionId: row.ctx.session.sessionId,
          sessionLabel: row.sessionMeta.sessionLabel,
          thumbnailUrl: row.thumbnailUrl,
          listPricePeaks: priced.listPricePeaks,
          discountPercent: priced.discountPercent,
          discountPeaksSaved: priced.discountPeaksSaved,
          basePeaks: priced.basePeaks,
          communityFeePeaks: priced.communityFeePeaks,
          totalPeaks: priced.totalPeaks,
          communityFeePercent: priced.communityFeePercent,
        });
        continue;
      }
      const sid = row.ctx.session.sessionId;
      const bucket = buyClaimBySession.get(sid) ?? [];
      bucket.push(row);
      buyClaimBySession.set(sid, bucket);
    }

    for (const [, group] of buyClaimBySession) {
      group.sort((a, b) => a.jobId.localeCompare(b.jobId));
      const settings = group[0]!.ctx.settings;
      const checkoutOpts: CheckoutOptions = {
        waiveCommunityFee: group[0]!.sessionMeta.isUndisclosed,
      };
      const pricedLines = allocateBuyClaimLineBreakdowns(
        settings,
        group.length,
        checkoutOpts,
      );
      for (let i = 0; i < group.length; i += 1) {
        const row = group[i]!;
        const priced = pricedLines[i]!;
        lines.push({
          jobId: row.jobId,
          intent: 'buy_claim',
          videoName: row.videoName,
          sessionId: row.ctx.session.sessionId,
          sessionLabel: row.sessionMeta.sessionLabel,
          thumbnailUrl: row.thumbnailUrl,
          listPricePeaks: priced.listPricePeaks,
          discountPercent: priced.discountPercent,
          discountPeaksSaved: priced.discountPeaksSaved,
          basePeaks: priced.basePeaks,
          communityFeePeaks: priced.communityFeePeaks,
          totalPeaks: priced.totalPeaks,
          communityFeePercent: priced.communityFeePercent,
        });
      }
    }

    lines.sort((a, b) => a.jobId.localeCompare(b.jobId));
    const totalPeaks = lines.reduce((sum, line) => sum + line.totalPeaks, 0);
    return { lines, totalPeaks };
  }

  async buyAndClaimVideoWaves(
    viewerUserId: string,
    jobIds: string[],
  ): Promise<{
    jobIds: string[];
    peaksCharged: number;
    discountPercent: number;
    surfer: SurferProfileDto;
  }> {
    const result = await this.commercialWave.buyAndClaimWaves(
      viewerUserId,
      jobIds,
    );
    const surfer = await this.buildSurferDto(viewerUserId);
    return { ...result, surfer };
  }

  async buyAndClaimVideoWave(
    viewerUserId: string,
    jobId: string,
    quantity = 1,
  ): Promise<{
    jobId: string;
    claimStatus: VideoClaimStatus;
    claimedAt: string;
    peaksCharged: number;
    discountPercent: number;
    surfer: SurferProfileDto;
  }> {
    const result = await this.commercialWave.buyAndClaimWave(
      viewerUserId,
      jobId,
      quantity,
    );
    const surfer = await this.buildSurferDto(viewerUserId);
    return { ...result, surfer };
  }

  async sponsorVideoWave(
    sponsorUserId: string,
    jobId: string,
  ): Promise<{
    jobId: string;
    peaksCharged: number;
    beneficiaryUserId: string;
  }> {
    return this.commercialWave.sponsorWaveUnlock(sponsorUserId, jobId);
  }

  async getWaveCheckoutContext(
    viewerUserId: string,
    jobId: string,
  ): Promise<WaveCheckoutContextDto> {
    const doc = await this.videoJobModel.findOne({ jobId }).lean().exec();
    if (!doc) {
      throw new NotFoundException(`Video job not found: ${jobId}`);
    }
    const sessionId = doc.surfSessionId?.trim();
    if (!sessionId) {
      throw new BadRequestException('Video is not part of a commercial session');
    }
    const session = await this.surfSessionModel.findOne({ sessionId }).lean().exec();
    if (!session || session.isCommercial !== true) {
      throw new BadRequestException('Session is not commercial');
    }
    const [partnerProfile, region, spot, authorProfile] = await Promise.all([
      this.partnerProfileModel.findOne({ userId: doc.userId }).lean().exec(),
      this.regionModel.findOne({ regionId: session.regionId }).lean().exec(),
      this.spotModel.findOne({ spotId: session.spotId }).lean().exec(),
      this.userProfileModel.findOne({ userId: doc.userId }).lean().exec(),
    ]);
    const settings = resolveEffectiveCommercialSettings(
      session,
      partnerProfile as { commercialSettings?: CommercialSettings | null } | null,
    );
    if (!settings) {
      throw new BadRequestException('Commercial pricing is not configured');
    }
    const extras = this.commercialExtras(
      session,
      partnerProfile,
      doc,
      viewerUserId,
    );
    const countryCode = session.countryCode;
    const isUndisclosed = isSessionLocationUndisclosed(
      countryCode,
      session.regionId,
      session.spotId,
    );
    const checkoutOpts: CheckoutOptions = { waiveCommunityFee: isUndisclosed };
    const buyClaimPriced = computeBuyClaimPeaks(settings, 1);
    const sponsorBase = computeSponsorPeaks(settings, 1);
    const buyClaim = checkoutBreakdownWithDiscount(
      buyClaimPriced.totalPeaks,
      settings.videoPricePeaks,
      buyClaimPriced.discountPercent,
      checkoutOpts,
    );
    const sponsor = checkoutBreakdownWithDiscount(
      sponsorBase,
      settings.videoPricePeaks,
      0,
      checkoutOpts,
    );
    const regionName =
      region?.name?.trim() ||
      (isUndisclosedRegionId(session.regionId, countryCode) ? 'Undisclosed' : 'Unknown');
    const spotName = isUndisclosed ? null : spot?.name?.trim() || null;

    const partnerName =
      partnerProfile?.partnerName?.trim() ||
      authorProfile?.displayName?.trim() ||
      'Partner';
    const partnerAvatarUrl = await this.resolveAvatarUrl(
      partnerProfile?.avatarKey?.trim() || authorProfile?.avatarKey?.trim() || null,
    );

    const sessionJobs = await this.videoJobModel
      .find({
        surfSessionId: sessionId,
        status: 'completed',
        discoverPublishedAt: { $type: 'string' },
      })
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    const sessionWaves: WaveCheckoutSessionWaveDto[] = [];
    for (const row of sessionJobs) {
      const rowExtras = this.commercialExtras(session, partnerProfile, row, viewerUserId);
      if (rowExtras.videoUnlockedByViewer) continue;
      const thumbKey = row.snapshotKeys?.[0];
      let thumbnailUrl: string | null = null;
      if (thumbKey) {
        thumbnailUrl = await this.s3.presignedGetUrl(thumbKey);
      }
      const rowBuyBase = computeBuyClaimPeaks(settings, 1).totalPeaks;
      const rowSponsorBase = computeSponsorPeaks(settings, 1);
      sessionWaves.push({
        jobId: row.jobId,
        originalFilename: row.originalFilename ?? 'video',
        thumbnailUrl,
        isCurrent: row.jobId === jobId,
        canBuyClaim: rowExtras.canBuyClaim,
        canSponsor: rowExtras.canSponsor,
        buyClaimTotalPeaks: rowExtras.canBuyClaim
          ? computeCheckoutTotal(rowBuyBase, checkoutOpts).totalPeaks
          : null,
        sponsorTotalPeaks: rowExtras.canSponsor
          ? computeCheckoutTotal(rowSponsorBase, checkoutOpts).totalPeaks
          : null,
      });
    }

    const surfer = await this.resolveFeedSurfer(doc);
    const shareToken =
      typeof session.shareToken === 'string' && session.shareToken.trim()
        ? session.shareToken.trim()
        : null;

    return {
      jobId,
      sessionId,
      shareToken,
      location: {
        countryCode,
        regionName,
        spotName,
        isUndisclosed,
      },
      sessionSummary: this.sessionToDto(session),
      partner: {
        partnerName,
        avatarUrl: partnerAvatarUrl,
        descriptionMarkdown: partnerProfile?.descriptionMarkdown ?? null,
      },
      commercialSettings: settings,
      communityFeePercent: COMMUNITY_FEE_PERCENT,
      canClaim: extras.canClaim,
      canBuyClaim: extras.canBuyClaim,
      canSponsor: extras.canSponsor,
      claimStatus: doc.claimStatus ?? 'none',
      buyClaim,
      sponsor,
      surfer,
      sessionWaves,
    };
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
        'Publish the surf session before waves appear on Discover',
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

  private async resolveDiscoverPlaybackUrl(
    processedKey: string | null | undefined,
    status: VideoJobStatus,
    isCommercial: boolean,
    videoUnlockedByViewer: boolean,
  ): Promise<string | null> {
    if (status !== 'completed' || !processedKey?.trim()) {
      return null;
    }
    if (isCommercial && !videoUnlockedByViewer) {
      return null;
    }
    return this.s3.presignedGetUrl(processedKey);
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

    const shakaInfo = await this.getShakaInfo(
      rows.map((r) => r.jobId),
      viewerUserId,
    );
    const items: DiscoverFeedItemDto[] = [];
    for (const doc of rows) {
      items.push(
        await this.docToDiscoverDto(doc, 'processing', viewerUserId, shakaInfo),
      );
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

    const shakaInfo = await this.getShakaInfo(
      sorted.map((d) => d.jobId),
      userId,
    );
    const items: MyVideoItemDto[] = [];
    for (const doc of sorted) {
      const dto = await this.docToDiscoverDto(
        doc,
        this.normalizeStatus(doc),
        userId,
        shakaInfo,
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
      const playbackUrl =
        !dto.isCommercial || dto.videoUnlockedByViewer ? dto.videoUrl : null;
      items.push({
        jobId: dto.jobId,
        createdAt: dto.createdAt,
        status: dto.status,
        thumbnailUrl: dto.thumbnailUrl,
        videoUrl: playbackUrl,
        location: dto.location,
        session: dto.session,
        claimStatus: dto.claimStatus,
        discoverPublishedAt: doc.discoverPublishedAt ?? null,
        uploadSource: doc.uploadSource === 'personal' ? 'personal' : 'studio',
        surfer: dto.surfer ?? (isViewerSurfer ? surfer : null),
        filmedBy,
        isCommercial: dto.isCommercial,
        snapshotUrls: dto.snapshotUrls,
        videoUnlockedByViewer: dto.videoUnlockedByViewer,
        wavePricePeaks: dto.wavePricePeaks,
        buyClaimPricePeaks: dto.buyClaimPricePeaks,
      });
    }
    return items;
  }

  async listDiscoverFeed(
    viewerUserId: string,
    options: {
      limit?: string;
      cursor?: string;
      countryCode?: string;
      regionId?: string;
      regionIds?: string;
      spotIds?: string;
    },
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

    const countryFilter = options.countryCode?.trim().toUpperCase();
    const regionFilterMulti = options.regionIds
      ? options.regionIds
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];
    const regionFilterSingle = options.regionId?.trim();
    const regionFilter =
      regionFilterMulti.length > 0
        ? regionFilterMulti
        : regionFilterSingle
          ? [regionFilterSingle]
          : [];
    const spotFilter = options.spotIds
      ? options.spotIds
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];
    if (countryFilter && !COUNTRY_CODE.test(countryFilter)) {
      throw new BadRequestException('Invalid countryCode');
    }
    if (regionFilter.length > 0 && !countryFilter) {
      throw new BadRequestException(
        'countryCode is required when filtering by region',
      );
    }
    const hasGeoFilter = Boolean(
      countryFilter || regionFilter.length > 0 || spotFilter.length > 0,
    );

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

    if (hasGeoFilter) {
      const geoMatch: Record<string, unknown> = {};
      if (countryFilter) geoMatch['session.countryCode'] = countryFilter;
      if (regionFilter.length > 0) {
        geoMatch['session.regionId'] =
          regionFilter.length === 1 ? regionFilter[0] : { $in: regionFilter };
      }
      if (spotFilter.length > 0) {
        geoMatch['session.spotId'] =
          spotFilter.length === 1 ? spotFilter[0] : { $in: spotFilter };
      }
      pipeline.push({ $match: geoMatch } as PipelineStage);
    }

    if (cursor) {
      pipeline.push({
        $match: buildCursorMatchFilter(cursor),
      } as PipelineStage);
    }

    pipeline.push(
      { $sort: { createdAt: -1, jobId: -1 } },
      { $limit: limit + 1 },
    );

    const rows = (await this.videoJobModel
      .aggregate(pipeline)
      .exec()) as AggregatedRow[];

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const shakaInfo = await this.getShakaInfo(
      pageRows.map((r) => r.jobId),
      viewerUserId,
    );
    const discoverItems: DiscoverFeedItemDto[] = [];
    for (const row of pageRows) {
      discoverItems.push(await this.rowToDto(row, viewerUserId, shakaInfo));
    }

    let items = discoverItems;
    let mergedHasMore = hasMore;

    if (cursor === null && !hasGeoFilter) {
      const pending = await this.listViewerProcessingPersonal(viewerUserId);
      const merged = [...pending, ...discoverItems].sort((a, b) => {
        const t = b.createdAt.localeCompare(a.createdAt);
        if (t !== 0) return t;
        return b.jobId.localeCompare(a.jobId);
      });
      mergedHasMore = merged.length > limit || hasMore;
      items = merged.slice(0, limit);
    }

    let nextCursor: string | null = null;
    if (mergedHasMore && discoverItems.length > 0) {
      const lastDiscover = pageRows[pageRows.length - 1]!;
      nextCursor = encodeDiscoverCursor({
        createdAt: lastDiscover.createdAt,
        jobId: lastDiscover.jobId,
      });
    }

    return { items, nextCursor, hasMore: mergedHasMore };
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
    shakaInfoMap?: Map<string, { count: number; viewerShaka: boolean }> | null,
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

    const isCommercial = session.isCommercial === true;
    const snapshotUrls = await this.presignSnapshotUrls(doc.snapshotKeys);
    const extras = this.commercialExtras(
      session,
      partnerProfile,
      doc,
      viewerUserId,
    );
    extras.snapshotUrls = snapshotUrls;

    const videoUrl = await this.resolveDiscoverPlaybackUrl(
      doc.processedKey,
      status,
      isCommercial,
      extras.videoUnlockedByViewer,
    );
    let thumbnailUrl: string | null = null;
    const snapKey = doc.snapshotKeys?.[0];
    if (snapKey) {
      thumbnailUrl = await this.s3.presignedGetUrl(snapKey);
    } else if (snapshotUrls[0]) {
      thumbnailUrl = snapshotUrls[0];
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

    const shakaInfo = shakaInfoMap
      ? this.shakaInfoFor(shakaInfoMap, doc.jobId)
      : await this.getShakaInfo([doc.jobId], viewerUserId).then((m) =>
          this.shakaInfoFor(m, doc.jobId),
        );

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
      shakaCount: shakaInfo.count,
      shakaedByViewer: shakaInfo.viewerShaka,
      followedByViewer: false,
      claimStatus: doc.claimStatus ?? 'none',
      uploadSource: doc.uploadSource === 'personal' ? 'personal' : 'studio',
      claimedByViewer: doc.claimedByUserId === viewerUserId,
      isOwnUpload: doc.userId === viewerUserId,
      surfer,
      ...extras,
    };
  }

  private async rowToDto(
    row: AggregatedRow,
    viewerUserId: string,
    shakaInfoMap?: Map<string, { count: number; viewerShaka: boolean }> | null,
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

    const isCommercial = session.isCommercial === true;
    const snapshotUrls = await this.presignSnapshotUrls(row.snapshotKeys);
    const extras = this.commercialExtras(
      { ...session, userId: row.userId },
      (partnerDoc as { commercialSettings?: unknown } | null) ?? null,
      row,
      viewerUserId,
    );
    extras.snapshotUrls = snapshotUrls;

    const status = this.normalizeStatus(row);
    const videoUrl = await this.resolveDiscoverPlaybackUrl(
      row.processedKey,
      status,
      isCommercial,
      extras.videoUnlockedByViewer,
    );
    let thumbnailUrl: string | null = null;
    const snapKey = row.snapshotKeys?.[0];
    if (snapKey) {
      thumbnailUrl = await this.s3.presignedGetUrl(snapKey);
    } else if (snapshotUrls[0]) {
      thumbnailUrl = snapshotUrls[0];
    }

    const [author, surfer] = await Promise.all([
      this.buildDiscoverAuthor(
        row.userId,
        row.uploadSource,
        authorDoc ?? null,
        partnerDoc ?? null,
      ),
      this.resolveFeedSurfer(row),
    ]);

    const shakaInfo = shakaInfoMap
      ? this.shakaInfoFor(shakaInfoMap, row.jobId)
      : await this.getShakaInfo([row.jobId], viewerUserId).then((m) =>
          this.shakaInfoFor(m, row.jobId),
        );

    return {
      jobId: row.jobId,
      createdAt: row.createdAt,
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
      shakaCount: shakaInfo.count,
      shakaedByViewer: shakaInfo.viewerShaka,
      followedByViewer: false,
      claimStatus: row.claimStatus ?? 'none',
      uploadSource: row.uploadSource === 'personal' ? 'personal' : 'studio',
      claimedByViewer: row.claimedByUserId === viewerUserId,
      isOwnUpload: row.userId === viewerUserId,
      surfer,
      ...extras,
    };
  }

  private parseGeoSuggestLimit(raw: string | undefined): number {
    if (!raw?.trim()) return DEFAULT_GEO_SUGGEST_LIMIT;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_GEO_SUGGEST_LIMIT;
    return Math.min(n, MAX_GEO_SUGGEST_LIMIT);
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private normalizeCountryCode(code: string): string {
    const c = code.trim().toUpperCase();
    if (!COUNTRY_CODE.test(c)) {
      throw new BadRequestException('Invalid countryCode');
    }
    return c;
  }

  private normalizeSessionDate(value: string): string {
    const d = value.trim();
    if (!SESSION_DATE.test(d)) {
      throw new BadRequestException('Invalid sessionDate');
    }
    return d;
  }

  private normalizeMonthYm(value: string): string {
    const m = value.trim();
    if (!MONTH_YM.test(m)) {
      throw new BadRequestException('Invalid month');
    }
    const [, mon] = m.split('-');
    const monthNum = Number.parseInt(mon!, 10);
    if (monthNum < 1 || monthNum > 12) {
      throw new BadRequestException('Invalid month');
    }
    return m;
  }

  private monthDateRange(month: string): { from: string; to: string } {
    const [yearStr, monStr] = month.split('-');
    const year = Number.parseInt(yearStr!, 10);
    const monthNum = Number.parseInt(monStr!, 10);
    const lastDay = new Date(year, monthNum, 0).getDate();
    return {
      from: `${month}-01`,
      to: `${month}-${String(lastDay).padStart(2, '0')}`,
    };
  }

  private discoverJobsWithSessionStages(): PipelineStage[] {
    return [
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
      // Join the session's region so country filters can fall back on the
      // canonical region.countryCode if the denormalized session.countryCode
      // is missing or has inconsistent casing in legacy data.
      {
        $lookup: {
          from: 'regions',
          localField: 'session.regionId',
          foreignField: 'regionId',
          as: 'region',
        },
      },
      {
        $unwind: { path: '$region', preserveNullAndEmptyArrays: true },
      },
    ];
  }

  private buildSessionGeoMatchNoDate(
    countryCode: string,
    regionId?: string,
    spotId?: string,
  ): Record<string, unknown> {
    const cc = countryCode.trim().toUpperCase();
    const ccRegex = new RegExp(`^${this.escapeRegex(cc)}$`, 'i');
    const match: Record<string, unknown> = {
      'session.status': 'closed',
      $or: [
        { 'session.countryCode': ccRegex },
        { 'region.countryCode': ccRegex },
      ],
    };
    if (regionId?.trim()) match['session.regionId'] = regionId.trim();
    if (spotId?.trim()) match['session.spotId'] = spotId.trim();
    return match;
  }

  private parseSearchSessionsLimit(raw: string | undefined): number {
    if (!raw?.trim()) return SEARCH_SESSIONS_DEFAULT_LIMIT;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new BadRequestException('Invalid limit');
    }
    return Math.min(parsed, SEARCH_SESSIONS_MAX_LIMIT);
  }

  private buildSessionGeoMatch(
    countryCode: string,
    sessionDate: string | { from: string; to: string },
    regionId?: string,
    spotId?: string,
  ): Record<string, unknown> {
    const cc = countryCode.trim().toUpperCase();
    const ccRegex = new RegExp(`^${this.escapeRegex(cc)}$`, 'i');
    // Match either the session's stored countryCode or the joined region's
    // countryCode (case-insensitive) so legacy/inconsistent data still surfaces.
    // Only published sessions (status === 'closed') are returned: open
    // sessions are still being filled by the partner and should not be
    // surfaced in search results.
    const match: Record<string, unknown> = {
      'session.status': 'closed',
      $or: [
        { 'session.countryCode': ccRegex },
        { 'region.countryCode': ccRegex },
      ],
    };
    if (typeof sessionDate === 'string') {
      match['session.sessionDate'] = sessionDate;
    } else {
      match['session.sessionDate'] = {
        $gte: sessionDate.from,
        $lte: sessionDate.to,
      };
    }
    if (regionId?.trim()) {
      match['session.regionId'] = regionId.trim();
    }
    if (spotId?.trim()) {
      match['session.spotId'] = spotId.trim();
    }
    return match;
  }

  async geoSuggest(
    q: string | undefined,
    limitRaw: string | undefined,
  ): Promise<{ items: GeoSuggestItemDto[] }> {
    const query = q?.trim() ?? '';
    if (!query) {
      throw new BadRequestException('q is required');
    }
    const limit = this.parseGeoSuggestLimit(limitRaw);
    const regex = new RegExp(this.escapeRegex(query), 'i');
    const regionCap = Math.ceil(limit / 2);
    const spotCap = Math.floor(limit / 2);

    const [regions, spotRows] = await Promise.all([
      this.regionModel
        .find({
          verified: true,
          disabled: { $ne: true },
          name: regex,
          regionId: { $not: new RegExp(`^${UNDISCLOSED_REGION_PREFIX}`) },
        })
        .sort({ name: 1 })
        .limit(regionCap)
        .lean()
        .exec(),
      this.spotModel
        .aggregate([
          {
            $match: {
              verified: true,
              disabled: { $ne: true },
              name: regex,
              spotId: { $not: new RegExp(`^${UNDISCLOSED_SPOT_PREFIX}`) },
            },
          },
          {
            $lookup: {
              from: 'regions',
              localField: 'regionId',
              foreignField: 'regionId',
              as: 'region',
            },
          },
          { $unwind: { path: '$region', preserveNullAndEmptyArrays: false } },
          {
            $match: {
              'region.disabled': { $ne: true },
              'region.regionId': {
                $not: new RegExp(`^${UNDISCLOSED_REGION_PREFIX}`),
              },
            },
          },
          { $sort: { name: 1 } },
          { $limit: spotCap },
        ])
        .exec(),
    ]);

    const items: GeoSuggestItemDto[] = [];

    for (const region of regions) {
      const cc = region.countryCode.trim().toUpperCase();
      items.push({
        type: 'region',
        countryCode: cc,
        regionId: region.regionId,
        label: `${region.name.trim()} · ${cc}`,
        name: region.name.trim(),
        verified: true,
      });
    }

    for (const row of spotRows as Array<{
      spotId: string;
      regionId: string;
      name: string;
      region: { countryCode: string; name: string };
    }>) {
      const cc = row.region.countryCode.trim().toUpperCase();
      const regionName = row.region.name.trim();
      items.push({
        type: 'spot',
        countryCode: cc,
        regionId: row.regionId,
        spotId: row.spotId,
        label: `${row.name.trim()} · ${regionName} · ${cc}`,
        name: row.name.trim(),
        verified: true,
      });
    }

    items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    return { items: items.slice(0, limit) };
  }

  async searchSessionDates(options: {
    countryCode?: string;
    regionId?: string;
    spotId?: string;
    month?: string;
  }): Promise<{ dates: string[] }> {
    if (!options.countryCode?.trim()) {
      throw new BadRequestException('countryCode is required');
    }
    if (!options.month?.trim()) {
      throw new BadRequestException('month is required');
    }
    const countryCode = this.normalizeCountryCode(options.countryCode);
    const month = this.normalizeMonthYm(options.month);
    const { from, to } = this.monthDateRange(month);

    const pipeline: PipelineStage[] = [
      ...this.discoverJobsWithSessionStages(),
      {
        $match: this.buildSessionGeoMatch(
          countryCode,
          { from, to },
          options.regionId,
          options.spotId,
        ),
      },
      { $group: { _id: '$session.sessionDate' } },
      { $sort: { _id: 1 } },
    ];

    const rows = (await this.videoJobModel.aggregate(pipeline).exec()) as Array<{
      _id: string;
    }>;

    return { dates: rows.map((r) => r._id).filter(Boolean) };
  }

  async searchSessions(
    _viewerUserId: string,
    options: {
      countryCode?: string;
      regionId?: string;
      spotId?: string;
      sessionDate?: string;
      limit?: string;
      cursor?: string;
    },
  ): Promise<SearchSessionsPageDto> {
    if (!options.countryCode?.trim()) {
      throw new BadRequestException('countryCode is required');
    }
    const countryCode = this.normalizeCountryCode(options.countryCode);
    const sessionDate = options.sessionDate?.trim()
      ? this.normalizeSessionDate(options.sessionDate)
      : null;
    const limit = this.parseSearchSessionsLimit(options.limit);

    let cursor: SearchSessionsCursor | null = null;
    if (options.cursor?.trim()) {
      cursor = decodeSearchSessionsCursor(options.cursor.trim());
      if (!cursor) {
        throw new BadRequestException('Invalid cursor');
      }
    }

    const match = sessionDate
      ? this.buildSessionGeoMatch(
          countryCode,
          sessionDate,
          options.regionId,
          options.spotId,
        )
      : this.buildSessionGeoMatchNoDate(
          countryCode,
          options.regionId,
          options.spotId,
        );

    const postGroupStages: PipelineStage[] = [
      {
        $addFields: {
          __sortKey: {
            $concat: [
              { $ifNull: ['$session.sessionDate', ''] },
              'T',
              {
                $ifNull: [{ $ifNull: ['$session.sessionTime', null] }, '12:00'],
              },
              '#',
              '$_id',
            ],
          },
        },
      },
      { $sort: { __sortKey: -1 } },
    ];

    if (cursor) {
      postGroupStages.push({
        $match: { __sortKey: { $lt: searchSessionsCursorKey(cursor) } },
      });
    }

    postGroupStages.push({ $limit: limit + 1 });

    const pipeline: PipelineStage[] = [
      ...this.discoverJobsWithSessionStages(),
      { $match: match },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$session.sessionId',
          session: { $first: '$session' },
          snapshotKeys: {
            $push: { $arrayElemAt: ['$snapshotKeys', 0] },
          },
          claimedSurferIds: {
            $addToSet: {
              $cond: [
                { $eq: ['$claimStatus', 'claimed'] },
                '$claimedByUserId',
                null,
              ],
            },
          },
          videoCount: { $sum: 1 },
        },
      },
      ...postGroupStages,
    ];

    const rows = (await this.videoJobModel.aggregate(pipeline).exec()) as Array<{
      _id: string;
      session: SurfSession;
      snapshotKeys: (string | null | undefined)[];
      claimedSurferIds: (string | null | undefined)[];
      videoCount: number;
    }>;

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const sessions: SearchSessionDto[] = [];
    for (const row of pageRows) {
      const session = row.session;
      const [region, spot, authorProfile, partnerProfile] = await Promise.all([
        this.regionModel.findOne({ regionId: session.regionId }).lean().exec(),
        this.spotModel.findOne({ spotId: session.spotId }).lean().exec(),
        this.userProfileModel.findOne({ userId: session.userId }).lean().exec(),
        this.partnerProfileModel
          .findOne({ userId: session.userId })
          .lean()
          .exec(),
      ]);

      const isUndisclosed =
        isUndisclosedRegionId(session.regionId, session.countryCode) ||
        isUndisclosedSpotId(session.spotId, session.countryCode);

      const regionName =
        region?.name?.trim() ||
        (isUndisclosedRegionId(session.regionId, session.countryCode)
          ? 'Undisclosed'
          : 'Unknown');
      const spotName = isUndisclosed ? null : spot?.name?.trim() || null;

      const previewThumbnailUrls: string[] = [];
      for (const key of row.snapshotKeys) {
        if (typeof key === 'string' && key.trim() && previewThumbnailUrls.length < SEARCH_PREVIEW_THUMBS) {
          previewThumbnailUrls.push(await this.s3.presignedGetUrl(key.trim()));
        }
      }

      const baseAuthor = await this.buildDiscoverAuthor(
        session.userId,
        'studio',
        authorProfile ?? null,
        (partnerProfile as {
          partnerName?: string | null;
          avatarKey?: string | null;
        } | null) ?? null,
      );
      const partnerTypeRaw = (partnerProfile as {
        partnerType?: string | null;
      } | null)?.partnerType;
      const partnerType: SearchSessionAuthorDto['partnerType'] =
        partnerTypeRaw === 'videographer' ||
        partnerTypeRaw === 'coach' ||
        partnerTypeRaw === 'other'
          ? partnerTypeRaw
          : null;
      const author: SearchSessionAuthorDto = {
        ...baseAuthor,
        partnerType: baseAuthor.isPartner ? partnerType ?? 'other' : null,
      };

      const surferIds = Array.from(
        new Set(
          row.claimedSurferIds.filter(
            (id): id is string => typeof id === 'string' && id.trim().length > 0,
          ),
        ),
      );
      const surferProfiles = surferIds.length
        ? await this.userProfileModel
            .find({ userId: { $in: surferIds } })
            .lean()
            .exec()
        : [];
      const surferProfileMap = new Map(
        surferProfiles.map((p) => [p.userId, p]),
      );
      const surfers: SearchSessionSurferDto[] = [];
      for (const surferId of surferIds) {
        const profile = surferProfileMap.get(surferId);
        const avatarUrl = await this.resolveAvatarUrl(
          profile?.avatarKey ?? null,
        );
        surfers.push({
          userId: surferId,
          displayName: profile?.displayName?.trim() || null,
          avatarUrl,
        });
      }

      const shareToken =
        typeof session.shareToken === 'string' && session.shareToken.trim()
          ? session.shareToken.trim()
          : null;

      sessions.push({
        sessionId: session.sessionId,
        shareToken,
        isCommercial: session.isCommercial === true,
        countryCode: session.countryCode,
        regionId: session.regionId,
        spotId: session.spotId,
        sessionDate: session.sessionDate,
        sessionTime: session.sessionTime?.trim() || '12:00',
        durationMinutes:
          typeof session.durationMinutes === 'number' &&
          session.durationMinutes >= 15
            ? session.durationMinutes
            : 120,
        conditionsRating: this.sessionToDto(session).conditionsRating,
        waveTypes: this.sessionToDto(session).waveTypes,
        regionName,
        spotName,
        author,
        surfers,
        videoCount: row.videoCount,
        previewThumbnailUrls,
      });
    }

    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeSearchSessionsCursor({
            sessionDate: last.session.sessionDate,
            sessionTime: last.session.sessionTime?.trim() || '12:00',
            sessionId: last._id,
          })
        : null;

    return { sessions, nextCursor, hasMore };
  }
}
