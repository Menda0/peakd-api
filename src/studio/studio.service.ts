import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { Region } from './schemas/region.schema';
import { Spot } from './schemas/spot.schema';
import {
  parseCommercialSettings,
  resolveEffectiveCommercialSettings,
  validateCommercialSettings,
} from '../commercial/commercial-pricing';
import type { CommercialSettings } from '../commercial/commercial-settings.types';
import { PartnerProfile } from '../partner/schemas/partner-profile.schema';
import { SurfSession } from './schemas/surf-session.schema';
import { VideoJob } from '../video/schemas/video-job.schema';
import { S3Service } from '../s3/s3.service';
import { WAVE_TYPE_ID_SET } from './studio.constants';
import {
  UNDISCLOSED_DISPLAY_NAME,
  UNDISCLOSED_SYSTEM_USER_ID,
  isUndisclosedRegionId,
  isUndisclosedSpotId,
  undisclosedRegionId,
  undisclosedSpotId,
} from './geo-undisclosed';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const COUNTRY_CODE = /^[A-Z]{2}$/;
const SESSION_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function normalizeCountryCode(code: string): string {
  return code.trim().toUpperCase();
}

export type RegionListItemDto = {
  regionId: string;
  countryCode: string;
  name: string;
  verified: boolean;
};

export type SpotListItemDto = {
  spotId: string;
  regionId: string;
  name: string;
  verified: boolean;
};

export type SurfSessionStatus = 'open' | 'closed';
export type SurfSessionExportStatus =
  | 'idle'
  | 'processing'
  | 'ready'
  | 'failed';

export type SurfSessionListItemDto = {
  sessionId: string;
  sessionKind: 'studio' | 'personal';
  countryCode: string;
  regionId: string;
  spotId: string;
  sessionDate: string;
  sessionTime: string;
  durationMinutes: number;
  conditionsRating: number | null;
  waveTypes: string[];
  createdAt: string;
  status: SurfSessionStatus;
  closedAt: string | null;
  exportStatus: SurfSessionExportStatus;
  exportErrorMessage: string | null;
  rawExportStatus: SurfSessionExportStatus;
  rawExportErrorMessage: string | null;
  rawExportExpiresAt: string | null;
  shareToken: string | null;
  isCommercial: boolean;
  commercialSettings: CommercialSettings | null;
  effectiveCommercialSettings: CommercialSettings | null;
  spotName?: string;
  regionName?: string;
  videoCount: number;
  previewThumbnailUrls: string[];
};

export type SurfSessionDetailDto = SurfSessionListItemDto;

export type SessionShareDto = {
  shareToken: string;
};

@Injectable()
export class StudioService {
  constructor(
    @InjectModel(Region.name)
    private readonly regionModel: Model<Region>,
    @InjectModel(Spot.name)
    private readonly spotModel: Model<Spot>,
    @InjectModel(SurfSession.name)
    private readonly surfSessionModel: Model<SurfSession>,
    @InjectModel(VideoJob.name)
    private readonly videoJobModel: Model<VideoJob>,
    @InjectModel(PartnerProfile.name)
    private readonly partnerProfileModel: Model<PartnerProfile>,
    private readonly s3: S3Service,
  ) {}

  /** Documents without `disabled: true` (missing field = enabled). */
  private static readonly notDisabled = { disabled: { $ne: true } };

  private static readonly verifiedTrue = { verified: true as const };

  private static isVerifiedValue(verified: unknown): boolean {
    return verified === true || verified === 1 || verified === 'true';
  }

  private regionVisibleQuery(userId: string, countryCode: string) {
    return {
      countryCode,
      ...StudioService.notDisabled,
      $or: [{ createdByUserId: userId }, StudioService.verifiedTrue],
    };
  }

  private spotVisibleQuery(userId: string, regionId: string) {
    return {
      regionId,
      ...StudioService.notDisabled,
      $or: [{ createdByUserId: userId }, StudioService.verifiedTrue],
    };
  }

  private isRegionVisibleToUser(
    userId: string,
    region: { createdByUserId: string; verified: unknown; disabled?: boolean },
  ): boolean {
    if (region.disabled === true) return false;
    return (
      region.createdByUserId === userId ||
      StudioService.isVerifiedValue(region.verified)
    );
  }

  private isSpotVisibleToUser(
    userId: string,
    spot: { createdByUserId: string; verified: unknown; disabled?: boolean },
  ): boolean {
    if (spot.disabled === true) return false;
    return (
      spot.createdByUserId === userId ||
      StudioService.isVerifiedValue(spot.verified)
    );
  }

  private async ensureUndisclosedGeo(countryCode: string): Promise<void> {
    const cc = normalizeCountryCode(countryCode);
    const regionId = undisclosedRegionId(cc);
    const spotId = undisclosedSpotId(cc);
    const now = new Date().toISOString();
    await this.regionModel.updateOne(
      { regionId },
      {
        $setOnInsert: {
          regionId,
          countryCode: cc,
          name: UNDISCLOSED_DISPLAY_NAME,
          verified: true,
          disabled: false,
          verifiedAt: now,
          verifierCount: 0,
          createdByUserId: UNDISCLOSED_SYSTEM_USER_ID,
          createdAt: now,
        },
      },
      { upsert: true },
    );
    await this.spotModel.updateOne(
      { spotId },
      {
        $setOnInsert: {
          spotId,
          regionId,
          name: UNDISCLOSED_DISPLAY_NAME,
          level: null,
          breakType: null,
          consistency: null,
          verified: true,
          disabled: false,
          verifiedAt: now,
          verifierCount: 0,
          createdByUserId: UNDISCLOSED_SYSTEM_USER_ID,
          createdAt: now,
        },
      },
      { upsert: true },
    );
  }

  private prependUndisclosedRegion(
    items: RegionListItemDto[],
    countryCode: string,
  ): RegionListItemDto[] {
    const id = undisclosedRegionId(countryCode);
    const undisclosed: RegionListItemDto = {
      regionId: id,
      countryCode,
      name: UNDISCLOSED_DISPLAY_NAME,
      verified: false,
    };
    const rest = items.filter((r) => r.regionId !== id);
    return [undisclosed, ...rest];
  }

  private normalizeWaveTypes(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const out: string[] = [];
    for (const x of raw) {
      if (typeof x !== 'string') {
        continue;
      }
      const id = x.trim();
      if (WAVE_TYPE_ID_SET.has(id) && !out.includes(id)) {
        out.push(id);
      }
    }
    return out;
  }

  private parseConditionsRating(raw: unknown): number | null {
    if (raw === undefined || raw === null || raw === '') {
      return null;
    }
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      throw new BadRequestException('conditionsRating must be an integer 1–5');
    }
    return n;
  }

  private sessionCoreDto(d: {
    sessionId: string;
    userId: string;
    countryCode: string;
    regionId: string;
    spotId: string;
    sessionDate: string;
    sessionTime?: string;
    durationMinutes?: number;
    conditionsRating?: number | null;
    waveTypes?: string[];
    createdAt: string;
    status?: string;
    closedAt?: string | null;
    exportStatus?: string;
    exportErrorMessage?: string | null;
    rawExportStatus?: string;
    rawExportErrorMessage?: string | null;
    rawExportExpiresAt?: string | null;
    sessionKind?: string;
    shareToken?: string | null;
    isCommercial?: boolean;
    commercialSettings?: unknown;
  }): Omit<
    SurfSessionListItemDto,
    | 'spotName'
    | 'regionName'
    | 'videoCount'
    | 'previewThumbnailUrls'
    | 'effectiveCommercialSettings'
  > {
    const isCommercial = d.isCommercial === true;
    const commercialSettings = parseCommercialSettings(d.commercialSettings);
    return {
      sessionId: d.sessionId,
      sessionKind: d.sessionKind === 'personal' ? 'personal' : 'studio',
      countryCode: d.countryCode,
      regionId: d.regionId,
      spotId: d.spotId,
      sessionDate: d.sessionDate,
      sessionTime:
        typeof d.sessionTime === 'string' && SESSION_TIME.test(d.sessionTime)
          ? d.sessionTime
          : '12:00',
      durationMinutes:
        typeof d.durationMinutes === 'number' &&
        Number.isFinite(d.durationMinutes) &&
        d.durationMinutes > 0
          ? Math.round(d.durationMinutes)
          : 120,
      conditionsRating:
        typeof d.conditionsRating === 'number' &&
        Number.isInteger(d.conditionsRating) &&
        d.conditionsRating >= 1 &&
        d.conditionsRating <= 5
          ? d.conditionsRating
          : null,
      waveTypes: this.normalizeWaveTypes(d.waveTypes),
      createdAt: d.createdAt,
      status: d.status === 'closed' ? 'closed' : 'open',
      closedAt:
        typeof d.closedAt === 'string' && d.closedAt.trim()
          ? d.closedAt
          : null,
      exportStatus: this.normalizeExportStatus(d.exportStatus),
      exportErrorMessage:
        typeof d.exportErrorMessage === 'string' && d.exportErrorMessage.trim()
          ? d.exportErrorMessage
          : null,
      rawExportStatus: this.normalizeExportStatus(d.rawExportStatus),
      rawExportErrorMessage:
        typeof d.rawExportErrorMessage === 'string' &&
        d.rawExportErrorMessage.trim()
          ? d.rawExportErrorMessage
          : null,
      rawExportExpiresAt:
        typeof d.rawExportExpiresAt === 'string' &&
        d.rawExportExpiresAt.trim()
          ? d.rawExportExpiresAt
          : null,
      shareToken:
        typeof d.shareToken === 'string' && d.shareToken.trim()
          ? d.shareToken.trim()
          : null,
      isCommercial,
      commercialSettings,
    };
  }

  private async enrichSessionCommercial(
    userId: string,
    core: Omit<
      SurfSessionListItemDto,
      | 'spotName'
      | 'regionName'
      | 'videoCount'
      | 'previewThumbnailUrls'
      | 'effectiveCommercialSettings'
    >,
  ): Promise<
    Omit<
      SurfSessionListItemDto,
      'spotName' | 'regionName' | 'videoCount' | 'previewThumbnailUrls'
    >
  > {
    const partner = await this.partnerProfileModel
      .findOne({ userId })
      .lean()
      .exec();
    const effectiveCommercialSettings = core.isCommercial
      ? resolveEffectiveCommercialSettings(
          {
            isCommercial: true,
            commercialSettings: core.commercialSettings,
          },
          partner,
        )
      : null;
    return { ...core, effectiveCommercialSettings };
  }

  private async countCompletedSessionVideos(
    userId: string,
    sessionId: string,
  ): Promise<number> {
    return this.videoJobModel
      .countDocuments({
        userId,
        surfSessionId: sessionId,
        status: 'completed',
        processedKey: { $exists: true, $ne: null },
      })
      .exec();
  }

  async ensureSessionShareToken(
    userId: string,
    sessionId: string,
  ): Promise<SessionShareDto> {
    const session = await this.surfSessionModel
      .findOne({ sessionId, userId })
      .lean()
      .exec();
    if (!session) {
      throw new NotFoundException('Session not found');
    }
    if (session.sessionKind === 'personal') {
      throw new BadRequestException('Personal sessions cannot be shared');
    }
    if (session.status !== 'closed') {
      throw new BadRequestException(
        'Publish the session before sharing',
      );
    }
    const completedCount = await this.countCompletedSessionVideos(
      userId,
      sessionId,
    );
    if (completedCount < 1) {
      throw new BadRequestException(
        'At least one completed wave is required to share',
      );
    }

    let shareToken =
      typeof session.shareToken === 'string' && session.shareToken.trim()
        ? session.shareToken.trim()
        : null;

    if (!shareToken) {
      shareToken = randomUUID();
      await this.surfSessionModel
        .updateOne({ sessionId, userId }, { $set: { shareToken } })
        .exec();
    }

    return { shareToken };
  }

  private normalizeExportStatus(raw: unknown): SurfSessionExportStatus {
    if (
      raw === 'processing' ||
      raw === 'ready' ||
      raw === 'failed' ||
      raw === 'idle'
    ) {
      return raw;
    }
    return 'idle';
  }

  /** Region by id+country for display (e.g. resolving a user's stored homeRegionId name). */
  async findRegionForCountry(
    regionIdRaw: string,
    countryCodeRaw: string,
  ): Promise<RegionListItemDto | null> {
    const countryCode = normalizeCountryCode(countryCodeRaw);
    if (!COUNTRY_CODE.test(countryCode)) return null;
    const regionId = typeof regionIdRaw === 'string' ? regionIdRaw.trim() : '';
    if (!regionId) return null;
    const region = await this.regionModel
      .findOne({ regionId, countryCode })
      .lean()
      .exec();
    if (!region || region.disabled === true) return null;
    return {
      regionId: region.regionId,
      countryCode: region.countryCode,
      name: region.name,
      verified: Boolean(region.verified),
    };
  }

  /**
   * Verified region for a country, visible to the user (verified regions are public;
   * unverified regions only visible to creator — must still be verified here).
   */
  async findVerifiedRegionForCountry(
    userId: string,
    regionIdRaw: string,
    countryCodeRaw: string,
  ): Promise<RegionListItemDto | null> {
    const countryCode = normalizeCountryCode(countryCodeRaw);
    if (!COUNTRY_CODE.test(countryCode)) {
      throw new BadRequestException('Invalid countryCode');
    }
    const regionId = typeof regionIdRaw === 'string' ? regionIdRaw.trim() : '';
    if (!regionId) {
      return null;
    }
    const region = await this.regionModel
      .findOne({ regionId, countryCode })
      .lean()
      .exec();
    if (
      !region ||
      region.disabled === true ||
      !StudioService.isVerifiedValue(region.verified)
    ) {
      return null;
    }
    if (!this.isRegionVisibleToUser(userId, region)) {
      return null;
    }
    return {
      regionId: region.regionId,
      countryCode: region.countryCode,
      name: region.name,
      verified: Boolean(region.verified),
    };
  }

  async listRegions(
    userId: string,
    countryCodeRaw: string,
    verifiedOnly = false,
  ): Promise<RegionListItemDto[]> {
    const countryCode = normalizeCountryCode(countryCodeRaw);
    if (!COUNTRY_CODE.test(countryCode)) {
      throw new BadRequestException('Invalid countryCode');
    }
    const query = verifiedOnly
      ? {
          countryCode,
          ...StudioService.notDisabled,
          ...StudioService.verifiedTrue,
        }
      : this.regionVisibleQuery(userId, countryCode);
    await this.ensureUndisclosedGeo(countryCode);
    const docs = await this.regionModel
      .find(query)
      .sort({ verified: -1, name: 1 })
      .lean()
      .exec();
    const items = docs.map((d) => ({
      regionId: d.regionId,
      countryCode: d.countryCode,
      name: d.name,
      verified: Boolean(d.verified),
    }));
    return this.prependUndisclosedRegion(items, countryCode);
  }

  async createRegion(
    userId: string,
    body: { countryCode?: string; name?: string },
  ): Promise<RegionListItemDto> {
    const countryCode = normalizeCountryCode(
      typeof body.countryCode === 'string' ? body.countryCode : '',
    );
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!COUNTRY_CODE.test(countryCode)) {
      throw new BadRequestException('Invalid countryCode');
    }
    if (!name) {
      throw new BadRequestException('name is required');
    }
    const regionId = uuidv4();
    const createdAt = new Date().toISOString();
    await this.regionModel.create({
      regionId,
      countryCode,
      name,
      verified: false,
      disabled: false,
      verifiedAt: null,
      verifierCount: 0,
      createdByUserId: userId,
      createdAt,
    });
    return {
      regionId,
      countryCode,
      name,
      verified: false,
    };
  }

  async listSpots(
    userId: string,
    regionId: string,
    verifiedOnly = false,
  ): Promise<SpotListItemDto[]> {
    if (!regionId?.trim()) {
      throw new BadRequestException('regionId is required');
    }
    const region = await this.regionModel
      .findOne({ regionId: regionId.trim() })
      .lean()
      .exec();
    if (!region) {
      throw new NotFoundException('Region not found');
    }
    if (!this.isRegionVisibleToUser(userId, region)) {
      throw new ForbiddenException('Region not accessible');
    }
    if (isUndisclosedRegionId(region.regionId, region.countryCode)) {
      await this.ensureUndisclosedGeo(region.countryCode);
      const spotId = undisclosedSpotId(region.countryCode);
      return [
        {
          spotId,
          regionId: region.regionId,
          name: UNDISCLOSED_DISPLAY_NAME,
          verified: false,
        },
      ];
    }
    const query = verifiedOnly
      ? {
          regionId: region.regionId,
          ...StudioService.notDisabled,
          ...StudioService.verifiedTrue,
        }
      : this.spotVisibleQuery(userId, region.regionId);
    const docs = await this.spotModel
      .find(query)
      .sort({ verified: -1, name: 1 })
      .lean()
      .exec();
    return docs.map((d) => ({
      spotId: d.spotId,
      regionId: d.regionId,
      name: d.name,
      verified: Boolean(d.verified),
    }));
  }

  async createSpot(
    userId: string,
    body: { regionId?: string; name?: string },
  ): Promise<SpotListItemDto> {
    const regionId =
      typeof body.regionId === 'string' ? body.regionId.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!regionId) {
      throw new BadRequestException('regionId is required');
    }
    if (!name) {
      throw new BadRequestException('name is required');
    }
    const region = await this.regionModel
      .findOne({ regionId })
      .lean()
      .exec();
    if (!region) {
      throw new NotFoundException('Region not found');
    }
    if (!this.isRegionVisibleToUser(userId, region)) {
      throw new ForbiddenException('Region not accessible');
    }
    if (isUndisclosedRegionId(regionId, region.countryCode)) {
      throw new BadRequestException(
        'Cannot create spots on undisclosed region',
      );
    }
    const spotId = uuidv4();
    const createdAt = new Date().toISOString();
    await this.spotModel.create({
      spotId,
      regionId,
      name,
      verified: false,
      disabled: false,
      verifiedAt: null,
      verifierCount: 0,
      createdByUserId: userId,
      createdAt,
    });
    return {
      spotId,
      regionId,
      name,
      verified: false,
    };
  }

  private async sessionVideoPreviews(
    userId: string,
    sessionIds: string[],
  ): Promise<
    Map<string, { videoCount: number; previewThumbnailUrls: string[] }>
  > {
    const out = new Map<
      string,
      { videoCount: number; previewThumbnailUrls: string[] }
    >();
    for (const sid of sessionIds) {
      out.set(sid, { videoCount: 0, previewThumbnailUrls: [] });
    }
    if (sessionIds.length === 0) {
      return out;
    }

    const jobs = await this.videoJobModel
      .find({
        userId,
        surfSessionId: { $in: sessionIds },
      })
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    const counts = new Map<string, number>();
    const thumbJobsBySession = new Map<
      string,
      Array<{ snapshotKey: string }>
    >();

    for (const job of jobs) {
      const sid = job.surfSessionId;
      if (!sid) continue;
      counts.set(sid, (counts.get(sid) ?? 0) + 1);

      const status = job.status ?? (job.processedKey ? 'completed' : 'processing');
      const firstSnap = job.snapshotKeys?.[0];
      if (status === 'completed' && firstSnap) {
        const list = thumbJobsBySession.get(sid) ?? [];
        if (list.length < 4) {
          list.push({ snapshotKey: firstSnap });
          thumbJobsBySession.set(sid, list);
        }
      }
    }

    for (const sid of sessionIds) {
      const videoCount = counts.get(sid) ?? 0;
      const picks = thumbJobsBySession.get(sid) ?? [];
      const previewThumbnailUrls: string[] = [];
      for (const pick of picks) {
        previewThumbnailUrls.push(
          await this.s3.presignedGetUrl(pick.snapshotKey),
        );
      }
      out.set(sid, { videoCount, previewThumbnailUrls });
    }

    return out;
  }

  async listSessions(userId: string): Promise<SurfSessionListItemDto[]> {
    const docs = await this.surfSessionModel
      .find({ userId, sessionKind: { $ne: 'personal' } })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    const sessionIds = docs.map((d) => d.sessionId);
    const previews = await this.sessionVideoPreviews(userId, sessionIds);

    const items: SurfSessionListItemDto[] = [];
    for (const d of docs) {
      const [spot, region] = await Promise.all([
        this.spotModel.findOne({ spotId: d.spotId }).lean().exec(),
        this.regionModel.findOne({ regionId: d.regionId }).lean().exec(),
      ]);
      const preview = previews.get(d.sessionId) ?? {
        videoCount: 0,
        previewThumbnailUrls: [],
      };
      const core = await this.enrichSessionCommercial(
        userId,
        this.sessionCoreDto(d),
      );
      items.push({
        ...core,
        spotName: spot?.name,
        regionName: region?.name,
        videoCount: preview.videoCount,
        previewThumbnailUrls: preview.previewThumbnailUrls,
      });
    }
    return items;
  }

  async getSession(
    userId: string,
    sessionId: string,
  ): Promise<SurfSessionDetailDto> {
    const d = await this.surfSessionModel
      .findOne({ sessionId, userId })
      .lean()
      .exec();
    if (!d) {
      throw new NotFoundException('Session not found');
    }
    const [spot, region] = await Promise.all([
      this.spotModel.findOne({ spotId: d.spotId }).lean().exec(),
      this.regionModel.findOne({ regionId: d.regionId }).lean().exec(),
    ]);
    const preview = (
      await this.sessionVideoPreviews(userId, [sessionId])
    ).get(sessionId) ?? { videoCount: 0, previewThumbnailUrls: [] };
    const core = await this.enrichSessionCommercial(
      userId,
      this.sessionCoreDto(d),
    );
    return {
      ...core,
      spotName: spot?.name,
      regionName: region?.name,
      videoCount: preview.videoCount,
      previewThumbnailUrls: preview.previewThumbnailUrls,
    };
  }

  private async ensurePartnerForCommercial(userId: string): Promise<void> {
    const partner = await this.partnerProfileModel
      .findOne({ userId })
      .lean()
      .exec();
    if (!partner) {
      throw new BadRequestException(
        'Only partners can create or edit commercial sessions',
      );
    }
  }

  private parseSessionCommercialFields(
    body: {
      isCommercial?: unknown;
      commercialSettings?: unknown;
    },
    existing?: { isCommercial?: boolean; commercialSettings?: unknown },
  ): { isCommercial: boolean; commercialSettings: CommercialSettings | null } {
    const isCommercial =
      'isCommercial' in body
        ? body.isCommercial === true
        : (existing?.isCommercial === true);
    let commercialSettings: CommercialSettings | null = null;
    if ('commercialSettings' in body) {
      if (body.commercialSettings == null) {
        commercialSettings = null;
      } else {
        commercialSettings = validateCommercialSettings(
          body.commercialSettings as CommercialSettings,
        );
      }
    } else if (existing) {
      commercialSettings = parseCommercialSettings(existing.commercialSettings);
    }
    return { isCommercial, commercialSettings };
  }

  async createSession(
    userId: string,
    body: {
      countryCode?: string;
      regionId?: string;
      spotId?: string;
      sessionDate?: string;
      sessionTime?: string;
      durationMinutes?: number | string;
      conditionsRating?: number | string | null;
      waveTypes?: unknown;
      sessionKind?: 'studio' | 'personal';
      isCommercial?: boolean;
      commercialSettings?: unknown;
    },
  ): Promise<SurfSessionDetailDto> {
    const payload = await this.resolveSessionPayload(userId, body);
    const sessionKind =
      body.sessionKind === 'personal' ? 'personal' : 'studio';
    if (sessionKind === 'personal' && body.isCommercial === true) {
      throw new BadRequestException('Personal sessions cannot be commercial');
    }
    let commercialFields = { isCommercial: false, commercialSettings: null as CommercialSettings | null };
    if (body.isCommercial === true || body.commercialSettings != null) {
      await this.ensurePartnerForCommercial(userId);
      commercialFields = this.parseSessionCommercialFields(body);
      if (commercialFields.isCommercial) {
        const partner = await this.partnerProfileModel
          .findOne({ userId })
          .lean()
          .exec();
        const effective = resolveEffectiveCommercialSettings(
          {
            isCommercial: true,
            commercialSettings: commercialFields.commercialSettings,
          },
          partner,
        );
        if (!effective) {
          throw new BadRequestException(
            'Configure commercial pricing on your partner profile first',
          );
        }
      }
    }
    const sessionId = uuidv4();
    const createdAt = new Date().toISOString();
    await this.surfSessionModel.create({
      sessionId,
      userId,
      ...payload,
      sessionKind,
      isCommercial: commercialFields.isCommercial,
      commercialSettings: commercialFields.commercialSettings,
      createdAt,
    });
    return this.getSession(userId, sessionId);
  }

  async updateSession(
    userId: string,
    sessionId: string,
    body: {
      countryCode?: string;
      regionId?: string;
      spotId?: string;
      sessionDate?: string;
      sessionTime?: string;
      durationMinutes?: number | string;
      conditionsRating?: number | string | null;
      waveTypes?: unknown;
      isCommercial?: boolean;
      commercialSettings?: unknown;
    },
  ): Promise<SurfSessionDetailDto> {
    const existing = await this.surfSessionModel
      .findOne({ sessionId, userId })
      .lean()
      .exec();
    if (!existing) {
      throw new NotFoundException('Session not found');
    }
    if (existing.status === 'closed') {
      throw new BadRequestException('Cannot edit a published session');
    }
    if (existing.sessionKind === 'personal' && body.isCommercial === true) {
      throw new BadRequestException('Personal sessions cannot be commercial');
    }

    const payload = await this.resolveSessionPayload(userId, body);

    const setFields: Record<string, unknown> = {
      countryCode: payload.countryCode,
      regionId: payload.regionId,
      spotId: payload.spotId,
      sessionDate: payload.sessionDate,
      sessionTime: payload.sessionTime,
      durationMinutes: payload.durationMinutes,
      conditionsRating: payload.conditionsRating,
      waveTypes: payload.waveTypes,
    };

    if ('isCommercial' in body || 'commercialSettings' in body) {
      await this.ensurePartnerForCommercial(userId);
      const commercialFields = this.parseSessionCommercialFields(body, existing);
      if (commercialFields.isCommercial) {
        const partner = await this.partnerProfileModel
          .findOne({ userId })
          .lean()
          .exec();
        const effective = resolveEffectiveCommercialSettings(
          {
            isCommercial: true,
            commercialSettings: commercialFields.commercialSettings,
          },
          partner,
        );
        if (!effective) {
          throw new BadRequestException(
            'Configure commercial pricing on your partner profile first',
          );
        }
      }
      setFields.isCommercial = commercialFields.isCommercial;
      setFields.commercialSettings = commercialFields.commercialSettings;
    }

    await this.surfSessionModel
      .updateOne(
        { sessionId, userId },
        { $set: setFields },
      )
      .exec();

    return this.getSession(userId, sessionId);
  }

  private async resolveSessionPayload(
    userId: string,
    body: {
      countryCode?: string;
      regionId?: string;
      spotId?: string;
      sessionDate?: string;
      sessionTime?: string;
      durationMinutes?: number | string;
      conditionsRating?: number | string | null;
      waveTypes?: unknown;
    },
  ): Promise<{
    countryCode: string;
    regionId: string;
    spotId: string;
    sessionDate: string;
    sessionTime: string;
    durationMinutes: number;
    conditionsRating: number | null;
    waveTypes: string[];
  }> {
    const countryCode = normalizeCountryCode(
      typeof body.countryCode === 'string' ? body.countryCode : '',
    );
    const regionId =
      typeof body.regionId === 'string' ? body.regionId.trim() : '';
    const spotId = typeof body.spotId === 'string' ? body.spotId.trim() : '';
    const sessionDate =
      typeof body.sessionDate === 'string' ? body.sessionDate.trim() : '';
    const sessionTimeRaw =
      typeof body.sessionTime === 'string' ? body.sessionTime.trim() : '';
    const durationRaw = body.durationMinutes;
    const durationMinutes =
      typeof durationRaw === 'number'
        ? durationRaw
        : typeof durationRaw === 'string'
          ? parseInt(durationRaw, 10)
          : NaN;

    if (!COUNTRY_CODE.test(countryCode)) {
      throw new BadRequestException('Invalid countryCode');
    }
    if (!regionId || !spotId) {
      throw new BadRequestException('regionId and spotId are required');
    }
    if (!sessionDate || !ISO_DATE.test(sessionDate)) {
      throw new BadRequestException('sessionDate must be YYYY-MM-DD');
    }
    if (!sessionTimeRaw || !SESSION_TIME.test(sessionTimeRaw)) {
      throw new BadRequestException('sessionTime must be HH:mm (24-hour)');
    }
    if (
      !Number.isInteger(durationMinutes) ||
      durationMinutes < 15 ||
      durationMinutes > 24 * 60
    ) {
      throw new BadRequestException(
        'durationMinutes must be an integer between 15 and 1440',
      );
    }

    let conditionsRating: number | null = null;
    if (
      body.conditionsRating !== undefined &&
      body.conditionsRating !== null &&
      body.conditionsRating !== ''
    ) {
      conditionsRating = this.parseConditionsRating(body.conditionsRating);
    }

    const waveTypes = this.normalizeWaveTypes(body.waveTypes);

    await this.ensureUndisclosedGeo(countryCode);

    if (isUndisclosedRegionId(regionId, countryCode)) {
      if (!isUndisclosedSpotId(spotId, countryCode)) {
        throw new BadRequestException(
          'Undisclosed region requires undisclosed spot',
        );
      }
      return {
        countryCode,
        regionId,
        spotId,
        sessionDate,
        sessionTime: sessionTimeRaw,
        durationMinutes,
        conditionsRating,
        waveTypes,
      };
    }

    const region = await this.regionModel
      .findOne({ regionId })
      .lean()
      .exec();
    if (!region) {
      throw new NotFoundException('Region not found');
    }
    if (region.countryCode !== countryCode) {
      throw new BadRequestException('regionId does not match countryCode');
    }
    if (!this.isRegionVisibleToUser(userId, region)) {
      throw new ForbiddenException('Region not accessible');
    }
    const spot = await this.spotModel.findOne({ spotId }).lean().exec();
    if (!spot) {
      throw new NotFoundException('Spot not found');
    }
    if (spot.regionId !== regionId) {
      throw new BadRequestException('spotId does not belong to regionId');
    }
    if (!this.isSpotVisibleToUser(userId, spot)) {
      throw new ForbiddenException('Spot not accessible');
    }

    return {
      countryCode,
      regionId,
      spotId,
      sessionDate,
      sessionTime: sessionTimeRaw,
      durationMinutes,
      conditionsRating,
      waveTypes,
    };
  }

  async assertSessionOwnedByUser(
    userId: string,
    sessionId: string,
  ): Promise<void> {
    const doc = await this.surfSessionModel
      .findOne({ sessionId, userId })
      .lean()
      .exec();
    if (!doc) {
      throw new ForbiddenException('Invalid or unknown surf session');
    }
  }

  async assertSessionOpenForUpload(
    userId: string,
    sessionId: string,
  ): Promise<void> {
    const doc = await this.surfSessionModel
      .findOne({ sessionId, userId })
      .lean()
      .exec();
    if (!doc) {
      throw new ForbiddenException('Invalid or unknown surf session');
    }
    if (doc.status === 'closed') {
      throw new ForbiddenException('This surf session is published');
    }
  }

  async getSessionForExport(
    userId: string,
    sessionId: string,
  ): Promise<SurfSession> {
    const doc = await this.surfSessionModel
      .findOne({ sessionId, userId })
      .lean()
      .exec();
    if (!doc) {
      throw new NotFoundException('Session not found');
    }
    return doc as SurfSession;
  }
}
