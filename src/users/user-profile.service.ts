import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { Model } from 'mongoose';
import { S3Service } from '../s3/s3.service';
import { StudioService } from '../studio/studio.service';
import { UserProfile } from './schemas/user-profile.schema';
import {
  handleCandidatesFromBase,
  normalizeHandleInput,
  sanitizeEmailLocalPartToHandleBase,
  validateHandleFormat,
} from './handle.utils';

export type SurfLevel = 'beginner' | 'intermediate' | 'advanced';

export interface UserProfileResponseDto {
  displayName: string | null;
  nickname: string | null;
  handle: string | null;
  countryCode: string | null;
  homeRegionId: string | null;
  homeRegionName: string | null;
  surfLevel: SurfLevel | null;
  avatarUrl: string | null;
}

export interface UserProfilePatchBody {
  displayName?: string | null;
  nickname?: string | null;
  handle?: string | null;
  countryCode?: string | null;
  homeRegionId?: string | null;
  surfLevel?: string | null;
  avatarKey?: string | null;
}

const SURF_LEVELS: SurfLevel[] = ['beginner', 'intermediate', 'advanced'];

const AVATAR_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

@Injectable()
export class UserProfileService {
  constructor(
    private readonly config: ConfigService,
    private readonly s3: S3Service,
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

  private avatarKeyPrefix(userId: string): string {
    const safe = encodeURIComponent(userId);
    return `users/avatars/${safe}/`;
  }

  private isValidAvatarKeyForUser(userId: string, key: string | null): boolean {
    if (key === null) return true;
    const prefix = this.avatarKeyPrefix(userId);
    return key.startsWith(prefix) && key.length > prefix.length;
  }

  private getAvatarGetExpirySeconds(): number {
    return Number(
      this.config.get<string>('USER_AVATAR_GET_URL_EXPIRY_SECONDS') ??
        this.config.get<string>('PARTNER_AVATAR_GET_URL_EXPIRY_SECONDS') ??
        '604800',
    );
  }

  private async resolveAvatarUrl(avatarKey: string | null): Promise<string | null> {
    if (!avatarKey) return null;
    const publicBase = this.config.get<string>('S3_PUBLIC_BASE_URL')?.trim();
    if (publicBase) {
      return `${publicBase.replace(/\/+$/, '')}/${avatarKey}`;
    }
    return this.s3.presignedGetUrl(
      avatarKey,
      this.getAvatarGetExpirySeconds(),
    );
  }

  private async resolveHomeRegionName(
    countryCode: string | null,
    homeRegionId: string | null,
  ): Promise<string | null> {
    if (!countryCode || !homeRegionId) return null;
    const region = await this.studio.findRegionForCountry(
      homeRegionId,
      countryCode,
    );
    return region?.name?.trim() || null;
  }

  private async toDto(doc: {
    userId?: string;
    displayName: string | null;
    nickname: string | null;
    handle?: string | null;
    countryCode: string | null;
    homeRegionId: string | null;
    surfLevel: string | null;
    avatarKey?: string | null;
  }): Promise<UserProfileResponseDto> {
    const sl = doc.surfLevel;
    const surfLevel =
      sl && (SURF_LEVELS as string[]).includes(sl) ? (sl as SurfLevel) : null;
    const avatarKey = doc.avatarKey ?? null;
    return {
      displayName: doc.displayName,
      nickname: doc.nickname,
      handle: doc.handle ?? null,
      countryCode: doc.countryCode,
      homeRegionId: doc.homeRegionId,
      homeRegionName: await this.resolveHomeRegionName(
        doc.countryCode,
        doc.homeRegionId,
      ),
      surfLevel,
      avatarUrl: await this.resolveAvatarUrl(avatarKey),
    };
  }

  private parseHandle(raw: unknown): string {
    if (typeof raw !== 'string') {
      throw new BadRequestException('handle must be a string');
    }
    const handle = normalizeHandleInput(raw);
    if (!handle) {
      throw new BadRequestException('handle cannot be empty');
    }
    try {
      validateHandleFormat(handle);
    } catch (e) {
      throw new BadRequestException(
        e instanceof Error ? e.message : 'Invalid handle',
      );
    }
    return handle;
  }

  private async isHandleTaken(
    handle: string,
    excludeUserId?: string,
  ): Promise<boolean> {
    const filter: Record<string, unknown> = { handle };
    if (excludeUserId) {
      filter.userId = { $ne: excludeUserId };
    }
    const existing = await this.userProfileModel.findOne(filter).lean().exec();
    return Boolean(existing);
  }

  async generateUniqueHandleFromEmail(
    email: string,
    userId?: string,
  ): Promise<string> {
    const base = sanitizeEmailLocalPartToHandleBase(email);
    const candidates = handleCandidatesFromBase(base);
    for (const candidate of candidates) {
      if (!(await this.isHandleTaken(candidate, userId))) {
        return candidate;
      }
    }
    const fallback = `user_${userId ? userId.replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase() : Date.now().toString(36)}`;
    const trimmed =
      fallback.length > 30 ? fallback.slice(0, 30) : fallback;
    if (!(await this.isHandleTaken(trimmed, userId))) {
      return trimmed;
    }
    return `${trimmed.slice(0, 24)}_${Date.now().toString(36).slice(-5)}`;
  }

  private async ensureHandleForProfile(
    userId: string,
    email: string | null | undefined,
  ): Promise<void> {
    if (!email?.trim()) return;
    const doc = await this.userProfileModel.findOne({ userId }).lean().exec();
    if (!doc || doc.handle) return;
    const handle = await this.generateUniqueHandleFromEmail(email.trim(), userId);
    try {
      await this.userProfileModel
        .updateOne({ userId, handle: null }, { $set: { handle } })
        .exec();
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code === 11000) {
        const retry = await this.generateUniqueHandleFromEmail(
          `${email.trim()}.${Date.now()}`,
          userId,
        );
        await this.userProfileModel
          .updateOne({ userId, handle: null }, { $set: { handle: retry } })
          .exec();
      }
    }
  }

  async findByHandle(handle: string): Promise<{
    userId: string;
    displayName: string | null;
    nickname: string | null;
    handle: string;
    countryCode: string | null;
    homeRegionId: string | null;
    surfLevel: string | null;
    avatarKey: string | null;
  } | null> {
    const normalized = normalizeHandleInput(handle);
    if (!normalized) return null;
    const doc = await this.userProfileModel
      .findOne({ handle: normalized })
      .lean()
      .exec();
    if (!doc?.handle) return null;
    return {
      userId: doc.userId,
      displayName: doc.displayName,
      nickname: doc.nickname,
      handle: doc.handle,
      countryCode: doc.countryCode,
      homeRegionId: doc.homeRegionId,
      surfLevel: doc.surfLevel,
      avatarKey: doc.avatarKey ?? null,
    };
  }

  async getMe(
    userId: string,
    email?: string | null,
  ): Promise<UserProfileResponseDto> {
    let doc = await this.userProfileModel.findOne({ userId }).lean().exec();
    if (!doc) {
      await this.userProfileModel.create({
        userId,
        displayName: null,
        nickname: null,
        handle: null,
        countryCode: null,
        homeRegionId: null,
        surfLevel: null,
        avatarKey: null,
      });
      doc = await this.userProfileModel.findOne({ userId }).lean().exec();
    }
    if (!doc) {
      throw new NotFoundException('User profile');
    }
    if (!doc.handle) {
      await this.ensureHandleForProfile(userId, email);
      doc = await this.userProfileModel.findOne({ userId }).lean().exec();
    }
    if (!doc) {
      throw new NotFoundException('User profile');
    }
    return this.toDto(doc);
  }

  async getProfileDto(userId: string): Promise<UserProfileResponseDto> {
    const doc = await this.userProfileModel.findOne({ userId }).lean().exec();
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

    if ('handle' in body) {
      if (body.handle === null || body.handle === undefined) {
        throw new BadRequestException('handle cannot be null');
      }
      const handle = this.parseHandle(body.handle);
      if (handle !== base.handle) {
        if (await this.isHandleTaken(handle, userId)) {
          throw new ConflictException('Handle already taken');
        }
        patch.handle = handle;
      }
    }

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

    if ('avatarKey' in body) {
      if (body.avatarKey === null || body.avatarKey === undefined) {
        patch.avatarKey = null;
      } else if (typeof body.avatarKey === 'string') {
        if (!this.isValidAvatarKeyForUser(userId, body.avatarKey)) {
          throw new BadRequestException('Invalid avatarKey');
        }
        patch.avatarKey = body.avatarKey;
      } else {
        throw new BadRequestException('avatarKey must be a string or null');
      }
    }

    if (Object.keys(patch).length === 0) {
      return this.toDto(base);
    }

    const defaultsOnInsert: Record<string, unknown> = {
      userId,
      displayName: null,
      nickname: null,
      handle: null,
      countryCode: null,
      homeRegionId: null,
      surfLevel: null,
      avatarKey: null,
    };
    const setOnInsert = Object.fromEntries(
      Object.entries(defaultsOnInsert).filter(([key]) => !(key in patch)),
    );

    let updated;
    try {
      updated = await this.userProfileModel
        .findOneAndUpdate(
          { userId },
          { $set: patch, $setOnInsert: setOnInsert },
          { upsert: true, returnDocument: 'after' },
        )
        .lean()
        .exec();
    } catch (e) {
      if ((e as { code?: number }).code === 11000 && 'handle' in patch) {
        throw new ConflictException('Handle already taken');
      }
      throw e;
    }

    if (!updated) {
      throw new NotFoundException('User profile');
    }
    return this.toDto(updated);
  }

  /** Multipart upload: stores object in S3 and persists `avatarKey` (avoids browser PUT to S3 / CORS). */
  async uploadAvatarMultipart(
    userId: string,
    file: Express.Multer.File,
  ): Promise<UserProfileResponseDto> {
    const ct = file.mimetype.trim().toLowerCase();
    if (!AVATAR_MIME_TO_EXT[ct]) {
      throw new BadRequestException(
        'Avatar must be image/jpeg, image/png, image/webp, or image/gif',
      );
    }
    if (!file.buffer?.length) {
      throw new BadRequestException('Empty file');
    }
    const ext = AVATAR_MIME_TO_EXT[ct];
    const avatarKey = `${this.avatarKeyPrefix(userId)}${randomUUID()}.${ext}`;
    await this.s3.putObjectBytes({
      key: avatarKey,
      body: file.buffer,
      contentType: ct,
    });
    return this.patchMe(userId, { avatarKey });
  }
}
