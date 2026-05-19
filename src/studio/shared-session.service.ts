import { Injectable, NotFoundException } from '@nestjs/common';
import type { OpenedSessionExportDownload } from './session-export.service';
import { SessionExportService } from './session-export.service';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { SurferProfileDto } from '../feed/feed.service';
import { PartnerProfile } from '../partner/schemas/partner-profile.schema';
import { UserProfile } from '../users/schemas/user-profile.schema';
import { S3Service } from '../s3/s3.service';
import { VideoJob } from '../video/schemas/video-job.schema';
import {
  isUndisclosedRegionId,
  isUndisclosedSpotId,
} from './geo-undisclosed';
import { Region } from './schemas/region.schema';
import { Spot } from './schemas/spot.schema';
import { SurfSession } from './schemas/surf-session.schema';
import { WAVE_TYPE_ID_SET } from './studio.constants';

const LIST_THUMBNAIL_MAX = 4;
const SESSION_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export type PublicSharedSessionWaveDto = {
  jobId: string;
  originalFilename: string;
  createdAt: string;
  thumbnailUrls: string[];
  thumbnailUrl: string | null;
  videoUrl: string;
  processedDownloadUrl: string;
  hasOriginal: boolean;
  originalDownloadUrl: string | null;
  claimStatus: 'none' | 'claimed' | 'auto';
  canClaim: boolean;
  surfer: SurferProfileDto | null;
};

export type PublicSharedSessionDto = {
  shareToken: string;
  partnerName: string | null;
  partnerAvatarUrl: string | null;
  exports: {
    processedReady: boolean;
    processedExportStatus: string;
  };
  session: {
    sessionDate: string;
    sessionTime: string;
    durationMinutes: number;
    conditionsRating: number | null;
    waveTypes: string[];
    countryCode: string;
    regionName: string;
    spotName: string | null;
    isUndisclosed: boolean;
  };
  waves: PublicSharedSessionWaveDto[];
};

@Injectable()
export class SharedSessionService {
  constructor(
    private readonly config: ConfigService,
    private readonly s3: S3Service,
    private readonly sessionExport: SessionExportService,
    @InjectModel(SurfSession.name)
    private readonly surfSessionModel: Model<SurfSession>,
    @InjectModel(VideoJob.name)
    private readonly videoJobModel: Model<VideoJob>,
    @InjectModel(Region.name)
    private readonly regionModel: Model<Region>,
    @InjectModel(Spot.name)
    private readonly spotModel: Model<Spot>,
    @InjectModel(PartnerProfile.name)
    private readonly partnerProfileModel: Model<PartnerProfile>,
    @InjectModel(UserProfile.name)
    private readonly userProfileModel: Model<UserProfile>,
  ) {}

  private normalizeWaveTypes(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (w): w is string =>
        typeof w === 'string' && WAVE_TYPE_ID_SET.has(w as never),
    );
  }

  private async findSessionByShareToken(token: string): Promise<SurfSession> {
    const session = await this.surfSessionModel
      .findOne({ shareToken: token })
      .lean()
      .exec();
    if (!session || session.sessionKind === 'personal') {
      throw new NotFoundException('Shared session not found');
    }
    return session as SurfSession;
  }

  private isRawOriginalDownloadAllowed(session: SurfSession): boolean {
    if (session.rawExportStatus !== 'ready') {
      return false;
    }
    const expiresAt = session.rawExportExpiresAt
      ? Date.parse(session.rawExportExpiresAt)
      : NaN;
    if (!Number.isFinite(expiresAt)) {
      return true;
    }
    return expiresAt > Date.now();
  }

  async openPublicProcessedExportDownload(
    shareToken: string,
  ): Promise<OpenedSessionExportDownload> {
    const session = await this.findSessionByShareToken(shareToken.trim());
    return this.sessionExport.openProcessedExportDownload(
      session.userId,
      session.sessionId,
    );
  }

  private surferUserIdFromJob(doc: {
    userId: string;
    claimStatus?: string;
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

  private async buildSurferDto(userId: string): Promise<SurferProfileDto> {
    const profile = await this.userProfileModel
      .findOne({ userId })
      .lean()
      .exec();
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

  private async resolveWaveSurfer(doc: {
    userId: string;
    claimStatus?: string;
    claimedByUserId?: string | null;
  }): Promise<SurferProfileDto | null> {
    const surferId = this.surferUserIdFromJob(doc);
    if (!surferId) return null;
    return this.buildSurferDto(surferId);
  }

  private waveCanBeClaimed(doc: {
    uploadSource?: string;
    discoverPublishedAt?: string | null;
    claimStatus?: string;
  }): boolean {
    if (doc.uploadSource !== 'studio') return false;
    if (doc.claimStatus !== 'none') return false;
    return Boolean(
      typeof doc.discoverPublishedAt === 'string' &&
        doc.discoverPublishedAt.trim(),
    );
  }

  private async resolveAvatarUrl(
    avatarKey: string | null,
  ): Promise<string | null> {
    if (!avatarKey) return null;
    const publicBase = this.config.get<string>('S3_PUBLIC_BASE_URL')?.trim();
    if (publicBase) {
      return `${publicBase.replace(/\/+$/, '')}/${avatarKey}`;
    }
    return this.s3.presignedGetUrl(avatarKey);
  }

  async getPublicSharedSession(
    shareToken: string,
  ): Promise<PublicSharedSessionDto> {
    const token = shareToken.trim();
    if (!token) {
      throw new NotFoundException('Shared session not found');
    }

    const session = await this.findSessionByShareToken(token);
    const rawOriginalsAllowed = this.isRawOriginalDownloadAllowed(session);

    const [partner, region, spot, jobs] = await Promise.all([
      this.partnerProfileModel
        .findOne({ userId: session.userId })
        .lean()
        .exec(),
      this.regionModel.findOne({ regionId: session.regionId }).lean().exec(),
      this.spotModel.findOne({ spotId: session.spotId }).lean().exec(),
      this.videoJobModel
        .find({
          userId: session.userId,
          surfSessionId: session.sessionId,
          status: 'completed',
          processedKey: { $exists: true, $ne: null },
        })
        .sort({ createdAt: -1 })
        .lean()
        .exec(),
    ]);

    const countryCode = session.countryCode;
    const isUndisclosed =
      isUndisclosedRegionId(session.regionId, countryCode) ||
      isUndisclosedSpotId(session.spotId, countryCode);
    const regionName =
      region?.name?.trim() ||
      (isUndisclosedRegionId(session.regionId, countryCode)
        ? 'Undisclosed'
        : 'Unknown');
    const spotName = isUndisclosed ? null : spot?.name?.trim() || null;

    const partnerName =
      typeof partner?.partnerName === 'string' && partner.partnerName.trim()
        ? partner.partnerName.trim()
        : null;
    const partnerAvatarUrl = await this.resolveAvatarUrl(
      partner?.avatarKey ?? null,
    );

    const waves: PublicSharedSessionWaveDto[] = [];
    for (const doc of jobs) {
      if (!doc.processedKey) continue;
      const snapKeys = (doc.snapshotKeys ?? []).slice(0, LIST_THUMBNAIL_MAX);
      const thumbnailUrls: string[] = [];
      for (const key of snapKeys) {
        thumbnailUrls.push(await this.s3.presignedGetUrl(key));
      }
      const processedDownloadUrl = await this.s3.presignedGetUrl(
        doc.processedKey,
      );
      const rawKey =
        typeof doc.rawOriginalKey === 'string' && doc.rawOriginalKey.trim()
          ? doc.rawOriginalKey.trim()
          : null;
      const hasOriginal = Boolean(rawKey) && rawOriginalsAllowed;
      const claimStatus =
        doc.claimStatus === 'claimed' || doc.claimStatus === 'auto'
          ? doc.claimStatus
          : 'none';
      const surfer = await this.resolveWaveSurfer(doc);
      waves.push({
        jobId: doc.jobId,
        originalFilename: doc.originalFilename ?? 'video',
        createdAt: doc.createdAt,
        thumbnailUrls,
        thumbnailUrl: thumbnailUrls[0] ?? null,
        videoUrl: processedDownloadUrl,
        processedDownloadUrl,
        hasOriginal,
        originalDownloadUrl:
          hasOriginal && rawKey
            ? await this.s3.presignedGetUrlRaw(rawKey)
            : null,
        claimStatus,
        canClaim: this.waveCanBeClaimed(doc),
        surfer,
      });
    }

    return {
      shareToken: token,
      partnerName,
      partnerAvatarUrl,
      exports: {
        processedReady:
          session.exportStatus === 'ready' && Boolean(session.exportZipKey),
        processedExportStatus: session.exportStatus ?? 'idle',
      },
      session: {
        sessionDate: session.sessionDate,
        sessionTime:
          typeof session.sessionTime === 'string' &&
          SESSION_TIME.test(session.sessionTime)
            ? session.sessionTime
            : '12:00',
        durationMinutes:
          typeof session.durationMinutes === 'number' &&
          Number.isFinite(session.durationMinutes) &&
          session.durationMinutes > 0
            ? Math.round(session.durationMinutes)
            : 120,
        conditionsRating:
          typeof session.conditionsRating === 'number' &&
          Number.isInteger(session.conditionsRating) &&
          session.conditionsRating >= 1 &&
          session.conditionsRating <= 5
            ? session.conditionsRating
            : null,
        waveTypes: this.normalizeWaveTypes(session.waveTypes),
        countryCode,
        regionName,
        spotName,
        isUndisclosed,
      },
      waves,
    };
  }
}
