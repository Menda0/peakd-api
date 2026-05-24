import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { S3Service } from '../s3/s3.service';
import { WaveUnlockPurchase } from '../commercial/schemas/wave-unlock-purchase.schema';
import { Region } from '../studio/schemas/region.schema';
import {
  isUndisclosedRegionId,
  UNDISCLOSED_REGION_ID_PATTERN,
} from '../studio/geo-undisclosed';
import { UserProfile } from '../users/schemas/user-profile.schema';

const COUNTRY_CODE = /^[A-Z]{2}$/;

function normalizeCountryCode(code: string): string {
  return code.trim().toUpperCase();
}

export type AdminPeaksGeoFilter = {
  countryCode?: string;
  regionId?: string;
};

export type AdminPeaksSummaryDto = {
  circulatingPeaks: number;
  unlockTransactionCount: number;
  totalPeaksCharged: number;
  totalPartnerPeaks: number;
  totalCommunityFeePeaks: number;
};

export type AdminPeaksTransactionDto = {
  id: string;
  jobId: string;
  sessionId: string;
  type: string;
  buyerUserId: string;
  buyerDisplayName: string | null;
  buyerAvatarUrl: string | null;
  partnerUserId: string;
  beneficiaryUserId: string;
  peaksCharged: number;
  basePeaks: number;
  communityFeePeaks: number;
  discountPercent: number;
  countryCode: string;
  regionId: string;
  regionName: string | null;
  createdAt: string;
};

export type AdminPeaksTransactionsPageDto = {
  items: AdminPeaksTransactionDto[];
  nextCursor: string | null;
};

export type AdminPeaksGeoRowDto = {
  countryCode?: string;
  regionId?: string;
  regionName?: string | null;
  transactionCount: number;
  communityFeePeaks: number;
  partnerPeaks: number;
  totalPeaksCharged: number;
};

function parseGeoFilter(raw: {
  countryCode?: string;
  regionId?: string;
}): AdminPeaksGeoFilter {
  const countryCode = raw.countryCode?.trim()
    ? normalizeCountryCode(raw.countryCode)
    : undefined;
  const regionId = raw.regionId?.trim() || undefined;
  if (countryCode && !COUNTRY_CODE.test(countryCode)) {
    throw new BadRequestException('countryCode must be a 2-letter ISO code');
  }
  if (regionId && countryCode && isUndisclosedRegionId(regionId, countryCode)) {
    throw new BadRequestException(
      'Cannot filter community fees by undisclosed region',
    );
  }
  if (regionId && !countryCode) {
    throw new BadRequestException('countryCode is required when regionId is set');
  }
  return { countryCode, regionId };
}

function purchaseMatchFilter(filter: AdminPeaksGeoFilter): Record<string, unknown> {
  const match: Record<string, unknown> = {};
  if (filter.countryCode) {
    match.countryCode = filter.countryCode;
  }
  if (filter.regionId) {
    match.regionId = filter.regionId;
  }
  return match;
}

/** Community fees are not attributed to undisclosed synthetic regions. */
function attributedCommunityFeePeaksExpr() {
  return {
    $sum: {
      $cond: [
        {
          $regexMatch: {
            input: { $ifNull: ['$regionId', ''] },
            regex: UNDISCLOSED_REGION_ID_PATTERN,
          },
        },
        0,
        { $ifNull: ['$communityFeePeaks', 0] },
      ],
    },
  };
}

@Injectable()
export class AdminPeaksService {
  constructor(
    @InjectModel(WaveUnlockPurchase.name)
    private readonly waveUnlockPurchaseModel: Model<WaveUnlockPurchase>,
    @InjectModel(UserProfile.name)
    private readonly userProfileModel: Model<UserProfile>,
    @InjectModel(Region.name)
    private readonly regionModel: Model<Region>,
    private readonly config: ConfigService,
    private readonly s3: S3Service,
  ) {}

  async getSummary(filterRaw?: AdminPeaksGeoFilter): Promise<AdminPeaksSummaryDto> {
    const filter = parseGeoFilter(filterRaw ?? {});
    const purchaseMatch = purchaseMatchFilter(filter);

    const [balanceAgg, unlockAgg] = await Promise.all([
      this.userProfileModel
        .aggregate<{ total: number }>([
          { $group: { _id: null, total: { $sum: '$peaksBalance' } } },
        ])
        .exec(),
      this.waveUnlockPurchaseModel
        .aggregate<{
          count: number;
          totalPeaksCharged: number;
          totalPartnerPeaks: number;
          totalCommunityFeePeaks: number;
        }>([
          ...(Object.keys(purchaseMatch).length > 0
            ? [{ $match: purchaseMatch }]
            : []),
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              totalPeaksCharged: { $sum: { $ifNull: ['$peaksCharged', 0] } },
              totalPartnerPeaks: { $sum: { $ifNull: ['$basePeaks', 0] } },
              totalCommunityFeePeaks: attributedCommunityFeePeaksExpr(),
            },
          },
        ])
        .exec(),
    ]);

    const unlock = unlockAgg[0];
    return {
      circulatingPeaks: Math.max(0, Math.round(balanceAgg[0]?.total ?? 0)),
      unlockTransactionCount: unlock?.count ?? 0,
      totalPeaksCharged: unlock?.totalPeaksCharged ?? 0,
      totalPartnerPeaks: unlock?.totalPartnerPeaks ?? 0,
      totalCommunityFeePeaks: unlock?.totalCommunityFeePeaks ?? 0,
    };
  }

  async listTransactions(options: {
    limit?: number;
    cursor?: string;
    countryCode?: string;
    regionId?: string;
  }): Promise<AdminPeaksTransactionsPageDto> {
    const filter = parseGeoFilter({
      countryCode: options.countryCode,
      regionId: options.regionId,
    });
    const limit = Math.min(100, Math.max(1, options.limit ?? 50));
    const query: Record<string, unknown> = { ...purchaseMatchFilter(filter) };
    if (options.cursor?.trim()) {
      if (!Types.ObjectId.isValid(options.cursor.trim())) {
        throw new BadRequestException('Invalid cursor');
      }
      query._id = { $lt: new Types.ObjectId(options.cursor.trim()) };
    }

    const rows = await this.waveUnlockPurchaseModel
      .find(query)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean()
      .exec();

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const regionIds = [
      ...new Set(
        page
          .map((r) => r.regionId?.trim())
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const regionNameById = await this.regionNamesById(regionIds);
    const buyerUserIds = [
      ...new Set(
        page
          .map((r) => r.buyerUserId?.trim())
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const buyerByUserId = await this.buyerSummariesByUserId(buyerUserIds);

    const items: AdminPeaksTransactionDto[] = page.map((row) => {
      const id = String(row._id);
      const regionId = row.regionId ?? '';
      const countryCode = row.countryCode ?? '';
      const isUndisclosed = isUndisclosedRegionId(regionId, countryCode);
      const buyer = buyerByUserId.get(row.buyerUserId) ?? {
        displayName: null,
        avatarUrl: null,
      };
      return {
        id,
        jobId: row.jobId,
        sessionId: row.sessionId,
        type: row.type,
        buyerUserId: row.buyerUserId,
        buyerDisplayName: buyer.displayName,
        buyerAvatarUrl: buyer.avatarUrl,
        partnerUserId: row.partnerUserId ?? '',
        beneficiaryUserId: row.beneficiaryUserId,
        peaksCharged: row.peaksCharged ?? 0,
        basePeaks: row.basePeaks ?? 0,
        communityFeePeaks: isUndisclosed ? 0 : (row.communityFeePeaks ?? 0),
        discountPercent: row.discountPercent ?? 0,
        countryCode,
        regionId,
        regionName: regionNameById.get(regionId) ?? null,
        createdAt: row.createdAt,
      };
    });

    const nextCursor = hasMore ? String(page[page.length - 1]!._id) : null;
    return { items, nextCursor };
  }

  async listByCountry(filterRaw?: AdminPeaksGeoFilter): Promise<AdminPeaksGeoRowDto[]> {
    const filter = parseGeoFilter(filterRaw ?? {});
    const match: Record<string, unknown> = {
      countryCode: { $exists: true, $ne: '' },
      ...purchaseMatchFilter(
        filter.countryCode
          ? { countryCode: filter.countryCode, regionId: filter.regionId }
          : { regionId: filter.regionId },
      ),
    };

    const rows = await this.waveUnlockPurchaseModel
      .aggregate<{
        _id: string;
        transactionCount: number;
        communityFeePeaks: number;
        partnerPeaks: number;
        totalPeaksCharged: number;
      }>([
        { $match: match },
        {
          $group: {
            _id: '$countryCode',
            transactionCount: { $sum: 1 },
            communityFeePeaks: attributedCommunityFeePeaksExpr(),
            partnerPeaks: { $sum: { $ifNull: ['$basePeaks', 0] } },
            totalPeaksCharged: { $sum: { $ifNull: ['$peaksCharged', 0] } },
          },
        },
        { $sort: { communityFeePeaks: -1 } },
      ])
      .exec();

    return rows.map((row) => ({
      countryCode: row._id,
      transactionCount: row.transactionCount,
      communityFeePeaks: row.communityFeePeaks,
      partnerPeaks: row.partnerPeaks,
      totalPeaksCharged: row.totalPeaksCharged,
    }));
  }

  async listByRegion(
    countryCodeRaw: string,
    filterRaw?: { regionId?: string },
  ): Promise<AdminPeaksGeoRowDto[]> {
    const filter = parseGeoFilter({
      countryCode: countryCodeRaw,
      regionId: filterRaw?.regionId,
    });
    const countryCode = filter.countryCode!;

    const rows = await this.waveUnlockPurchaseModel
      .aggregate<{
        _id: string;
        transactionCount: number;
        communityFeePeaks: number;
        partnerPeaks: number;
        totalPeaksCharged: number;
      }>([
        {
          $match: {
            countryCode,
            regionId: filter.regionId
              ? filter.regionId
              : { $exists: true, $ne: '', $not: UNDISCLOSED_REGION_ID_PATTERN },
          },
        },
        {
          $group: {
            _id: '$regionId',
            transactionCount: { $sum: 1 },
            communityFeePeaks: attributedCommunityFeePeaksExpr(),
            partnerPeaks: { $sum: { $ifNull: ['$basePeaks', 0] } },
            totalPeaksCharged: { $sum: { $ifNull: ['$peaksCharged', 0] } },
          },
        },
        { $sort: { communityFeePeaks: -1 } },
      ])
      .exec();

    const regionIds = rows.map((r) => r._id);
    const regionNameById = await this.regionNamesById(regionIds);

    return rows.map((row) => ({
      countryCode,
      regionId: row._id,
      regionName: regionNameById.get(row._id) ?? null,
      transactionCount: row.transactionCount,
      communityFeePeaks: row.communityFeePeaks,
      partnerPeaks: row.partnerPeaks,
      totalPeaksCharged: row.totalPeaksCharged,
    }));
  }

  private async resolveAvatarUrl(avatarKey: string | null): Promise<string | null> {
    if (!avatarKey?.trim()) return null;
    const publicBase = this.config.get<string>('S3_PUBLIC_BASE_URL')?.trim();
    if (publicBase) {
      return `${publicBase.replace(/\/+$/, '')}/${avatarKey.trim()}`;
    }
    const expiry = Number(
      this.config.get<string>('USER_AVATAR_GET_URL_EXPIRY_SECONDS') ?? '604800',
    );
    return this.s3.presignedGetUrl(avatarKey.trim(), expiry);
  }

  private async buyerSummariesByUserId(
    userIds: string[],
  ): Promise<Map<string, { displayName: string | null; avatarUrl: string | null }>> {
    const out = new Map<string, { displayName: string | null; avatarUrl: string | null }>();
    if (userIds.length === 0) return out;

    const profiles = await this.userProfileModel
      .find({ userId: { $in: userIds } })
      .select({ userId: 1, displayName: 1, nickname: 1, avatarKey: 1 })
      .lean()
      .exec();

    const avatarUrlByKey = new Map<string, string | null>();
    for (const profile of profiles) {
      const key = profile.avatarKey?.trim();
      if (key && !avatarUrlByKey.has(key)) {
        avatarUrlByKey.set(key, await this.resolveAvatarUrl(key));
      }
      const displayName =
        profile.displayName?.trim() || profile.nickname?.trim() || null;
      out.set(profile.userId, {
        displayName,
        avatarUrl: key ? (avatarUrlByKey.get(key) ?? null) : null,
      });
    }

    for (const userId of userIds) {
      if (!out.has(userId)) {
        out.set(userId, { displayName: null, avatarUrl: null });
      }
    }
    return out;
  }

  private async regionNamesById(regionIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (regionIds.length === 0) return out;
    const regions = await this.regionModel
      .find({ regionId: { $in: regionIds } })
      .select({ regionId: 1, name: 1 })
      .lean()
      .exec();
    for (const r of regions) {
      out.set(r.regionId, r.name);
    }
    return out;
  }
}
