import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { Region } from '../studio/schemas/region.schema';

const COUNTRY_CODE = /^[A-Z]{2}$/;

function normalizeCountryCode(code: string): string {
  return code.trim().toUpperCase();
}

export type AdminRegionDto = {
  regionId: string;
  countryCode: string;
  name: string;
  verified: boolean;
  verifiedAt: string | null;
  verifierCount: number;
  disabled: boolean;
  createdByUserId: string;
  createdAt: string;
};

@Injectable()
export class AdminRegionsService {
  constructor(
    @InjectModel(Region.name)
    private readonly regionModel: Model<Region>,
  ) {}

  private toDto(d: Region): AdminRegionDto {
    return {
      regionId: d.regionId,
      countryCode: d.countryCode,
      name: d.name,
      verified: Boolean(d.verified),
      verifiedAt: d.verifiedAt ?? null,
      verifierCount: d.verifierCount ?? 0,
      disabled: Boolean(d.disabled),
      createdByUserId: d.createdByUserId,
      createdAt: d.createdAt,
    };
  }

  async listRegions(countryCodeRaw: string): Promise<AdminRegionDto[]> {
    const countryCode = normalizeCountryCode(countryCodeRaw);
    if (!COUNTRY_CODE.test(countryCode)) {
      throw new BadRequestException('Invalid countryCode');
    }
    const docs = await this.regionModel
      .find({ countryCode })
      .sort({ disabled: 1, verified: -1, name: 1 })
      .lean()
      .exec();
    return docs.map((d) => this.toDto(d as Region));
  }

  async createRegion(
    userId: string,
    body: { countryCode?: string; name?: string; verified?: boolean },
  ): Promise<AdminRegionDto> {
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
    const verified = body.verified === true;
    const now = new Date().toISOString();
    const regionId = uuidv4();
    const doc = await this.regionModel.create({
      regionId,
      countryCode,
      name,
      verified,
      disabled: false,
      verifiedAt: verified ? now : null,
      verifierCount: verified ? 1 : 0,
      createdByUserId: userId,
      createdAt: now,
    });
    return this.toDto(doc.toObject());
  }

  async updateRegion(
    regionIdRaw: string,
    body: {
      name?: string;
      countryCode?: string;
      verified?: boolean;
      disabled?: boolean;
    },
  ): Promise<AdminRegionDto> {
    const regionId =
      typeof regionIdRaw === 'string' ? regionIdRaw.trim() : '';
    if (!regionId) {
      throw new BadRequestException('regionId is required');
    }
    const region = await this.regionModel.findOne({ regionId }).exec();
    if (!region) {
      throw new NotFoundException('Region not found');
    }

    const updates: Partial<Region> = {};

    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) {
        throw new BadRequestException('name cannot be empty');
      }
      updates.name = name;
    }

    if (body.countryCode !== undefined) {
      const countryCode = normalizeCountryCode(
        typeof body.countryCode === 'string' ? body.countryCode : '',
      );
      if (!COUNTRY_CODE.test(countryCode)) {
        throw new BadRequestException('Invalid countryCode');
      }
      updates.countryCode = countryCode;
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
        updates.verifierCount = Math.max(region.verifierCount ?? 0, 1);
      } else {
        updates.verifiedAt = null;
        updates.verifierCount = 0;
      }
    }

    if (Object.keys(updates).length === 0) {
      return this.toDto(region.toObject());
    }

    region.set(updates);
    await region.save();
    return this.toDto(region.toObject());
  }

  async disableRegion(regionIdRaw: string): Promise<AdminRegionDto> {
    return this.updateRegion(regionIdRaw, { disabled: true });
  }
}
