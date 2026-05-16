import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { StudioService } from '../studio/studio.service';
import { UserProfile } from './schemas/user-profile.schema';

export type SurfLevel = 'beginner' | 'intermediate' | 'advanced';

export interface UserProfileResponseDto {
  displayName: string | null;
  nickname: string | null;
  countryCode: string | null;
  homeRegionId: string | null;
  surfLevel: SurfLevel | null;
}

export interface UserProfilePatchBody {
  displayName?: string | null;
  nickname?: string | null;
  countryCode?: string | null;
  homeRegionId?: string | null;
  surfLevel?: string | null;
}

const SURF_LEVELS: SurfLevel[] = ['beginner', 'intermediate', 'advanced'];

@Injectable()
export class UserProfileService {
  constructor(
    @InjectModel(UserProfile.name)
    private readonly userProfileModel: Model<UserProfile>,
    private readonly studio: StudioService,
  ) {}

  private parseSurfLevel(raw: unknown): SurfLevel | null {
    if (raw === null || raw === undefined || raw === '') {
      return null;
    }
    if (typeof raw === 'string' && (SURF_LEVELS as string[]).includes(raw)) {
      return raw as SurfLevel;
    }
    throw new BadRequestException(
      'surfLevel must be beginner, intermediate, advanced, or null',
    );
  }

  private toDto(doc: {
    displayName: string | null;
    nickname: string | null;
    countryCode: string | null;
    homeRegionId: string | null;
    surfLevel: string | null;
  }): UserProfileResponseDto {
    const sl = doc.surfLevel;
    const surfLevel =
      sl && (SURF_LEVELS as string[]).includes(sl) ? (sl as SurfLevel) : null;
    return {
      displayName: doc.displayName,
      nickname: doc.nickname,
      countryCode: doc.countryCode,
      homeRegionId: doc.homeRegionId,
      surfLevel,
    };
  }

  async getMe(userId: string): Promise<UserProfileResponseDto> {
    let doc = await this.userProfileModel.findOne({ userId }).lean().exec();
    if (!doc) {
      await this.userProfileModel.create({
        userId,
        displayName: null,
        nickname: null,
        countryCode: null,
        homeRegionId: null,
        surfLevel: null,
      });
      doc = await this.userProfileModel.findOne({ userId }).lean().exec();
    }
    if (!doc) {
      throw new NotFoundException('User profile');
    }
    return this.toDto(doc);
  }

  async patchMe(
    userId: string,
    body: UserProfilePatchBody,
  ): Promise<UserProfileResponseDto> {
    await this.getMe(userId);
    const base = await this.userProfileModel.findOne({ userId }).lean().exec();
    if (!base) {
      throw new NotFoundException('User profile');
    }

    const patch: Record<string, unknown> = {};

    if ('displayName' in body) {
      if (body.displayName === null || body.displayName === undefined) {
        patch.displayName = null;
      } else if (typeof body.displayName === 'string') {
        const t = body.displayName.trim();
        if (t === '') {
          throw new BadRequestException('displayName cannot be empty');
        }
        patch.displayName = t;
      } else {
        throw new BadRequestException('displayName must be a string or null');
      }
    }

    if ('nickname' in body) {
      if (body.nickname === null || body.nickname === undefined) {
        patch.nickname = null;
      } else if (typeof body.nickname === 'string') {
        const t = body.nickname.trim();
        patch.nickname = t === '' ? null : t;
      } else {
        throw new BadRequestException('nickname must be a string or null');
      }
    }

    if ('countryCode' in body) {
      if (body.countryCode === null || body.countryCode === undefined) {
        patch.countryCode = null;
      } else if (typeof body.countryCode === 'string') {
        const cc = body.countryCode.trim().toUpperCase();
        if (cc !== '' && !/^[A-Z]{2}$/.test(cc)) {
          throw new BadRequestException('countryCode must be ISO 3166-1 alpha-2');
        }
        patch.countryCode = cc === '' ? null : cc;
      } else {
        throw new BadRequestException('countryCode must be a string or null');
      }
    }

    if ('countryCode' in patch && !('homeRegionId' in body)) {
      if (patch.countryCode === null && base.homeRegionId) {
        patch.homeRegionId = null;
      } else if (
        typeof patch.countryCode === 'string' &&
        base.homeRegionId
      ) {
        const ok = await this.studio.findVerifiedRegionForCountry(
          userId,
          base.homeRegionId,
          patch.countryCode,
        );
        if (!ok) {
          patch.homeRegionId = null;
        }
      }
    }

    if ('homeRegionId' in body) {
      if (body.homeRegionId === null || body.homeRegionId === undefined) {
        patch.homeRegionId = null;
      } else if (typeof body.homeRegionId === 'string') {
        const rid = body.homeRegionId.trim();
        if (rid === '') {
          patch.homeRegionId = null;
        } else {
          const countryForRegion =
            (typeof patch.countryCode === 'string'
              ? patch.countryCode
              : null) ?? base.countryCode ?? '';
          if (!countryForRegion || !/^[A-Z]{2}$/.test(countryForRegion)) {
            throw new BadRequestException(
              'countryCode is required before setting homeRegionId',
            );
          }
          const region = await this.studio.findVerifiedRegionForCountry(
            userId,
            rid,
            countryForRegion,
          );
          if (!region) {
            throw new BadRequestException(
              'homeRegionId must be a verified region for the selected country',
            );
          }
          patch.homeRegionId = rid;
        }
      } else {
        throw new BadRequestException('homeRegionId must be a string or null');
      }
    }

    if ('surfLevel' in body) {
      patch.surfLevel = this.parseSurfLevel(body.surfLevel);
    }

    if (Object.keys(patch).length === 0) {
      return this.toDto(base);
    }

    const defaultsOnInsert: Record<string, unknown> = {
      userId,
      displayName: null,
      nickname: null,
      countryCode: null,
      homeRegionId: null,
      surfLevel: null,
    };
    const setOnInsert = Object.fromEntries(
      Object.entries(defaultsOnInsert).filter(([key]) => !(key in patch)),
    );

    const updated = await this.userProfileModel
      .findOneAndUpdate(
        { userId },
        { $set: patch, $setOnInsert: setOnInsert },
        { upsert: true, returnDocument: 'after' },
      )
      .lean()
      .exec();

    if (!updated) {
      throw new NotFoundException('User profile');
    }
    return this.toDto(updated);
  }
}
