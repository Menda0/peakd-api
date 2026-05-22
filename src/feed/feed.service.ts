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
import {
  buildCursorMatchFilter,
  decodeDiscoverCursor,
  encodeDiscoverCursor,
  type DiscoverCursor,
} from './discover-ranking';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const SNAPSHOT_URL_MAX = 4;

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
    private readonly s3: S3Service,
    private readonly config: ConfigService,
    private readonly commercialWave: CommercialWaveService,
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

  private commercialExtras(
    session: {
      isCommercial?: boolean;
      commercialSettings?: unknown;
      userId: string;
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
    const wavePricePeaks = settings?.videoPricePeaks ?? null;
    const buyClaimPricePeaks = settings
      ? computeCheckoutTotal(computeBuyClaimPeaks(settings, 1).totalPeaks).totalPeaks
      : null;
    const sponsorPricePeaks = settings
      ? computeCheckoutTotal(computeSponsorPeaks(settings, 1)).totalPeaks
      : null;
    const canClaim =
      claimStatus === 'none' && !unlockedFor;
    const canBuyClaim = Boolean(settings && buyClaimPricePeaks != null);
    const canSponsor =
      Boolean(settings) &&
      !unlockedFor &&
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
      if (row.intent === 'sponsor') {
        const sponsorBase = computeSponsorPeaks(row.ctx.settings, 1);
        const priced = checkoutBreakdownWithDiscount(
          sponsorBase,
          row.ctx.settings.videoPricePeaks,
          0,
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
      const pricedLines = allocateBuyClaimLineBreakdowns(settings, group.length);
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
    const buyClaimPriced = computeBuyClaimPeaks(settings, 1);
    const sponsorBase = computeSponsorPeaks(settings, 1);
    const buyClaim = checkoutBreakdownWithDiscount(
      buyClaimPriced.totalPeaks,
      settings.videoPricePeaks,
      buyClaimPriced.discountPercent,
    );
    const sponsor = checkoutBreakdownWithDiscount(
      sponsorBase,
      settings.videoPricePeaks,
      0,
    );

    const countryCode = session.countryCode;
    const isUndisclosed =
      isUndisclosedRegionId(session.regionId, countryCode) ||
      isUndisclosedSpotId(session.spotId, countryCode);
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
          ? computeCheckoutTotal(rowBuyBase).totalPeaks
          : null,
        sponsorTotalPeaks: rowExtras.canSponsor
          ? computeCheckoutTotal(rowSponsorBase).totalPeaks
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

    const discoverItems: DiscoverFeedItemDto[] = [];
    for (const row of pageRows) {
      discoverItems.push(await this.rowToDto(row, viewerUserId));
    }

    let items = discoverItems;
    let mergedHasMore = hasMore;

    if (cursor === null) {
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
      ...extras,
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
      shakaCount: 0,
      followedByViewer: false,
      claimStatus: row.claimStatus ?? 'none',
      uploadSource: row.uploadSource === 'personal' ? 'personal' : 'studio',
      claimedByViewer: row.claimedByUserId === viewerUserId,
      isOwnUpload: row.userId === viewerUserId,
      surfer,
      ...extras,
    };
  }
}
