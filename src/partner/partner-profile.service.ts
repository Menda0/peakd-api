import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model } from 'mongoose';
import { S3Service } from '../s3/s3.service';
import { PartnerProfile } from './schemas/partner-profile.schema';

export type PartnerType = 'videographer' | 'coach' | 'other';

export interface PartnerProfileResponseDto {
  partnerName: string | null;
  partnerType: PartnerType;
  descriptionMarkdown: string | null;
  avatarUrl: string | null;
  countryCode: string | null;
}

export interface PartnerProfilePatchBody {
  partnerName?: string | null;
  partnerType?: string;
  descriptionMarkdown?: string | null;
  countryCode?: string | null;
  avatarKey?: string | null;
}

export interface AvatarPresignResponseDto {
  uploadUrl: string;
  method: string;
  headers: Record<string, string>;
  avatarKey: string;
  /** Same object as GET `avatarUrl` for this key (presigned or public base URL). */
  avatarUrl: string;
}

const PARTNER_TYPES: PartnerType[] = ['videographer', 'coach', 'other'];

const AVATAR_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

@Injectable()
export class PartnerProfileService {
  constructor(
    private readonly config: ConfigService,
    private readonly s3: S3Service,
    @InjectModel(PartnerProfile.name)
    private readonly partnerModel: Model<PartnerProfile>,
  ) {}

  private avatarKeyPrefix(userId: string): string {
    const safe = encodeURIComponent(userId);
    return `partners/avatars/${safe}/`;
  }

  private isValidAvatarKeyForUser(userId: string, key: string | null): boolean {
    if (key === null) return true;
    const prefix = this.avatarKeyPrefix(userId);
    return key.startsWith(prefix) && key.length > prefix.length;
  }

  private parsePartnerType(raw: unknown): PartnerType {
    if (typeof raw === 'string' && (PARTNER_TYPES as string[]).includes(raw)) {
      return raw as PartnerType;
    }
    return 'other';
  }

  private getAvatarGetExpirySeconds(): number {
    return Number(
      this.config.get<string>('PARTNER_AVATAR_GET_URL_EXPIRY_SECONDS') ??
        '604800',
    );
  }

  private getAvatarPutExpirySeconds(): number {
    return Number(
      this.config.get<string>('PARTNER_AVATAR_PUT_URL_EXPIRY_SECONDS') ??
        '600',
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

  private async toDto(doc: {
    partnerName: string | null;
    partnerType: string;
    descriptionMarkdown: string | null;
    avatarKey: string | null;
    countryCode: string | null;
  }): Promise<PartnerProfileResponseDto> {
    return {
      partnerName: doc.partnerName,
      partnerType: this.parsePartnerType(doc.partnerType),
      descriptionMarkdown: doc.descriptionMarkdown,
      avatarUrl: await this.resolveAvatarUrl(doc.avatarKey),
      countryCode: doc.countryCode,
    };
  }

  async getMe(userId: string): Promise<PartnerProfileResponseDto> {
    let doc = await this.partnerModel.findOne({ userId }).lean().exec();
    if (!doc) {
      await this.partnerModel.create({
        userId,
        partnerName: null,
        partnerType: 'videographer',
        descriptionMarkdown: null,
        avatarKey: null,
        countryCode: null,
      });
      doc = await this.partnerModel.findOne({ userId }).lean().exec();
    }
    if (!doc) {
      throw new NotFoundException('Partner profile');
    }
    return this.toDto(doc);
  }

  async patchMe(
    userId: string,
    body: PartnerProfilePatchBody,
  ): Promise<PartnerProfileResponseDto> {
    const patch: Record<string, unknown> = {};

    if ('partnerName' in body) {
      if (body.partnerName === null || body.partnerName === undefined) {
        patch.partnerName = null;
      } else if (typeof body.partnerName === 'string') {
        const t = body.partnerName.trim();
        patch.partnerName = t === '' ? null : t;
      } else {
        throw new BadRequestException('partnerName must be a string or null');
      }
    }

    if ('partnerType' in body && body.partnerType !== undefined) {
      patch.partnerType = this.parsePartnerType(body.partnerType);
    }

    if ('descriptionMarkdown' in body) {
      if (body.descriptionMarkdown === null || body.descriptionMarkdown === undefined) {
        patch.descriptionMarkdown = null;
      } else if (typeof body.descriptionMarkdown === 'string') {
        const t = body.descriptionMarkdown.trim();
        patch.descriptionMarkdown = t === '' ? null : t;
      } else {
        throw new BadRequestException('descriptionMarkdown must be a string or null');
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
      return this.getMe(userId);
    }

    const setOnInsert = {
      userId,
      partnerName: null,
      partnerType: 'videographer',
      descriptionMarkdown: null,
      avatarKey: null,
      countryCode: null,
    };

    const updated = await this.partnerModel
      .findOneAndUpdate(
        { userId },
        { $set: patch, $setOnInsert: setOnInsert },
        { new: true, upsert: true },
      )
      .lean()
      .exec();

    if (!updated) {
      throw new NotFoundException('Partner profile');
    }
    return this.toDto(updated);
  }

  async presignAvatar(
    userId: string,
    contentType: string,
    filename?: string,
  ): Promise<AvatarPresignResponseDto> {
    void filename;
    const ct = contentType.trim().toLowerCase();
    if (!AVATAR_MIME_TO_EXT[ct]) {
      throw new BadRequestException(
        'contentType must be image/jpeg, image/png, image/webp, or image/gif',
      );
    }
    const ext = AVATAR_MIME_TO_EXT[ct];
    const avatarKey = `${this.avatarKeyPrefix(userId)}${randomUUID()}.${ext}`;

    const putExpiry = this.getAvatarPutExpirySeconds();
    const uploadUrl = await this.s3.presignedPutUrl({
      key: avatarKey,
      contentType: ct,
      expiresInSeconds: putExpiry,
    });

    const avatarUrl = await this.resolveAvatarUrl(avatarKey);
    if (!avatarUrl) {
      throw new BadRequestException('Could not build avatar URL');
    }

    return {
      uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': ct },
      avatarKey,
      avatarUrl,
    };
  }
}
