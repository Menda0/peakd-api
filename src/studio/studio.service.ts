import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { Region } from './schemas/region.schema';
import { Spot } from './schemas/spot.schema';
import { SurfSession } from './schemas/surf-session.schema';
import { WAVE_TYPE_ID_SET } from './studio.constants';

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

export type SurfSessionListItemDto = {
  sessionId: string;
  countryCode: string;
  regionId: string;
  spotId: string;
  sessionDate: string;
  sessionTime: string;
  durationMinutes: number;
  conditionsRating: number | null;
  waveTypes: string[];
  createdAt: string;
  spotName?: string;
  regionName?: string;
};

export type SurfSessionDetailDto = SurfSessionListItemDto;

@Injectable()
export class StudioService {
  constructor(
    @InjectModel(Region.name)
    private readonly regionModel: Model<Region>,
    @InjectModel(Spot.name)
    private readonly spotModel: Model<Spot>,
    @InjectModel(SurfSession.name)
    private readonly surfSessionModel: Model<SurfSession>,
  ) {}

  private regionVisibleQuery(userId: string, countryCode: string) {
    return {
      countryCode,
      $or: [{ createdByUserId: userId }, { verified: true }],
    };
  }

  private spotVisibleQuery(userId: string, regionId: string) {
    return {
      regionId,
      $or: [{ createdByUserId: userId }, { verified: true }],
    };
  }

  private isRegionVisibleToUser(
    userId: string,
    region: { createdByUserId: string; verified: boolean },
  ): boolean {
    return region.createdByUserId === userId || region.verified === true;
  }

  private isSpotVisibleToUser(
    userId: string,
    spot: { createdByUserId: string; verified: boolean },
  ): boolean {
    return spot.createdByUserId === userId || spot.verified === true;
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
  }): Omit<SurfSessionListItemDto, 'spotName' | 'regionName'> {
    return {
      sessionId: d.sessionId,
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
    };
  }

  async listRegions(
    userId: string,
    countryCodeRaw: string,
  ): Promise<RegionListItemDto[]> {
    const countryCode = normalizeCountryCode(countryCodeRaw);
    if (!COUNTRY_CODE.test(countryCode)) {
      throw new BadRequestException('Invalid countryCode');
    }
    const docs = await this.regionModel
      .find(this.regionVisibleQuery(userId, countryCode))
      .sort({ verified: -1, name: 1 })
      .lean()
      .exec();
    return docs.map((d) => ({
      regionId: d.regionId,
      countryCode: d.countryCode,
      name: d.name,
      verified: Boolean(d.verified),
    }));
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
    const docs = await this.spotModel
      .find(this.spotVisibleQuery(userId, region.regionId))
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
    const spotId = uuidv4();
    const createdAt = new Date().toISOString();
    await this.spotModel.create({
      spotId,
      regionId,
      name,
      verified: false,
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

  async listSessions(userId: string): Promise<SurfSessionListItemDto[]> {
    const docs = await this.surfSessionModel
      .find({ userId })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    const items: SurfSessionListItemDto[] = [];
    for (const d of docs) {
      const [spot, region] = await Promise.all([
        this.spotModel.findOne({ spotId: d.spotId }).lean().exec(),
        this.regionModel.findOne({ regionId: d.regionId }).lean().exec(),
      ]);
      items.push({
        ...this.sessionCoreDto(d),
        spotName: spot?.name,
        regionName: region?.name,
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
    return {
      ...this.sessionCoreDto(d),
      spotName: spot?.name,
      regionName: region?.name,
    };
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
    },
  ): Promise<SurfSessionDetailDto> {
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
    const sessionId = uuidv4();
    const createdAt = new Date().toISOString();
    await this.surfSessionModel.create({
      sessionId,
      userId,
      countryCode,
      regionId,
      spotId,
      sessionDate,
      sessionTime: sessionTimeRaw,
      durationMinutes,
      conditionsRating,
      waveTypes,
      createdAt,
    });
    return this.getSession(userId, sessionId);
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
}
