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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const COUNTRY_CODE = /^[A-Z]{2}$/;

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
        sessionId: d.sessionId,
        countryCode: d.countryCode,
        regionId: d.regionId,
        spotId: d.spotId,
        sessionDate: d.sessionDate,
        createdAt: d.createdAt,
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
      sessionId: d.sessionId,
      countryCode: d.countryCode,
      regionId: d.regionId,
      spotId: d.spotId,
      sessionDate: d.sessionDate,
      createdAt: d.createdAt,
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
    if (!COUNTRY_CODE.test(countryCode)) {
      throw new BadRequestException('Invalid countryCode');
    }
    if (!regionId || !spotId) {
      throw new BadRequestException('regionId and spotId are required');
    }
    if (!sessionDate || !ISO_DATE.test(sessionDate)) {
      throw new BadRequestException('sessionDate must be YYYY-MM-DD');
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
    const sessionId = uuidv4();
    const createdAt = new Date().toISOString();
    await this.surfSessionModel.create({
      sessionId,
      userId,
      countryCode,
      regionId,
      spotId,
      sessionDate,
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
