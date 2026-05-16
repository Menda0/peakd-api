import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { Spot } from '../studio/schemas/spot.schema';
import { Region } from '../studio/schemas/region.schema';

export type AdminSpotDto = {
  spotId: string;
  regionId: string;
  name: string;
  level: string | null;
  breakType: string | null;
  consistency: string | null;
  verified: boolean;
  verifiedAt: string | null;
  verifierCount: number;
  disabled: boolean;
  createdByUserId: string;
  createdAt: string;
};

@Injectable()
export class AdminSpotsService {
  constructor(
    @InjectModel(Spot.name)
    private readonly spotModel: Model<Spot>,
    @InjectModel(Region.name)
    private readonly regionModel: Model<Region>,
  ) {}

  private toDto(d: Spot): AdminSpotDto {
    return {
      spotId: d.spotId,
      regionId: d.regionId,
      name: d.name,
      level: d.level ?? null,
      breakType: d.breakType ?? null,
      consistency: d.consistency ?? null,
      verified: Boolean(d.verified),
      verifiedAt: d.verifiedAt ?? null,
      verifierCount: d.verifierCount ?? 0,
      disabled: Boolean(d.disabled),
      createdByUserId: d.createdByUserId,
      createdAt: d.createdAt,
    };
  }

  private async requireRegion(regionIdRaw: string): Promise<Region> {
    const regionId =
      typeof regionIdRaw === 'string' ? regionIdRaw.trim() : '';
    if (!regionId) {
      throw new BadRequestException('regionId is required');
    }
    const region = await this.regionModel.findOne({ regionId }).exec();
    if (!region) {
      throw new NotFoundException('Region not found');
    }
    return region;
  }

  async listSpots(regionIdRaw: string): Promise<AdminSpotDto[]> {
    const region = await this.requireRegion(regionIdRaw);
    const docs = await this.spotModel
      .find({ regionId: region.regionId })
      .sort({ disabled: 1, verified: -1, name: 1 })
      .lean()
      .exec();
    return docs.map((d) => this.toDto(d as Spot));
  }

  async createSpot(
    regionIdRaw: string,
    userId: string,
    body: {
      name?: string;
      level?: string | null;
      breakType?: string | null;
      consistency?: string | null;
      verified?: boolean;
    },
  ): Promise<AdminSpotDto> {
    const region = await this.requireRegion(regionIdRaw);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      throw new BadRequestException('name is required');
    }
    const verified = body.verified === true;
    const now = new Date().toISOString();
    const spotId = uuidv4();
    const doc = await this.spotModel.create({
      spotId,
      regionId: region.regionId,
      name,
      level:
        body.level === undefined || body.level === null
          ? null
          : String(body.level).trim() || null,
      breakType:
        body.breakType === undefined || body.breakType === null
          ? null
          : String(body.breakType).trim() || null,
      consistency:
        body.consistency === undefined || body.consistency === null
          ? null
          : String(body.consistency).trim() || null,
      verified,
      disabled: false,
      verifiedAt: verified ? now : null,
      verifierCount: verified ? 1 : 0,
      createdByUserId: userId,
      createdAt: now,
    });
    return this.toDto(doc.toObject());
  }

  async updateSpot(
    regionIdRaw: string,
    spotIdRaw: string,
    body: {
      name?: string;
      level?: string | null;
      breakType?: string | null;
      consistency?: string | null;
      verified?: boolean;
      disabled?: boolean;
    },
  ): Promise<AdminSpotDto> {
    const region = await this.requireRegion(regionIdRaw);
    const spotId = typeof spotIdRaw === 'string' ? spotIdRaw.trim() : '';
    if (!spotId) {
      throw new BadRequestException('spotId is required');
    }
    const spot = await this.spotModel
      .findOne({ spotId, regionId: region.regionId })
      .exec();
    if (!spot) {
      throw new NotFoundException('Spot not found');
    }

    const updates: Partial<Spot> = {};

    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) {
        throw new BadRequestException('name cannot be empty');
      }
      updates.name = name;
    }

    if (body.level !== undefined) {
      updates.level =
        body.level === null
          ? null
          : String(body.level).trim() || null;
    }
    if (body.breakType !== undefined) {
      updates.breakType =
        body.breakType === null
          ? null
          : String(body.breakType).trim() || null;
    }
    if (body.consistency !== undefined) {
      updates.consistency =
        body.consistency === null
          ? null
          : String(body.consistency).trim() || null;
    }

    if (body.disabled !== undefined) {
      updates.disabled = body.disabled === true;
    }

    if (body.verified !== undefined) {
      const verified = body.verified === true;
      const now = new Date().toISOString();
      updates.verified = verified;
      if (verified) {
        updates.verifiedAt = now;
        updates.verifierCount = Math.max(spot.verifierCount ?? 0, 1);
      } else {
        updates.verifiedAt = null;
        updates.verifierCount = 0;
      }
    }

    if (Object.keys(updates).length === 0) {
      return this.toDto(spot.toObject());
    }

    spot.set(updates);
    await spot.save();
    return this.toDto(spot.toObject());
  }

  async disableSpot(
    regionIdRaw: string,
    spotIdRaw: string,
  ): Promise<AdminSpotDto> {
    return this.updateSpot(regionIdRaw, spotIdRaw, { disabled: true });
  }
}
