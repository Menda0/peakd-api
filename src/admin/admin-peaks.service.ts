import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { WaveUnlockPurchase } from '../commercial/schemas/wave-unlock-purchase.schema';
import { Region } from '../studio/schemas/region.schema';
import { UserProfile } from '../users/schemas/user-profile.schema';

const COUNTRY_CODE = /^[A-Z]{2}$/;

function normalizeCountryCode(code: string): string {
  return code.trim().toUpperCase();
}

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

@Injectable()
export class AdminPeaksService {
  constructor(
    @InjectModel(WaveUnlockPurchase.name)
    private readonly waveUnlockPurchaseModel: Model<WaveUnlockPurchase>,
    @InjectModel(UserProfile.name)
    private readonly userProfileModel: Model<UserProfile>,
    @InjectModel(Region.name)
    private readonly regionModel: Model<Region>,
  ) {}

  async getSummary(): Promise<AdminPeaksSummaryDto> {
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
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              totalPeaksCharged: { $sum: { $ifNull: ['$peaksCharged', 0] } },
              totalPartnerPeaks: { $sum: { $ifNull: ['$basePeaks', 0] } },
              totalCommunityFeePeaks: {
                $sum: { $ifNull: ['$communityFeePeaks', 0] },
              },
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
  }): Promise<AdminPeaksTransactionsPageDto> {
    const limit = Math.min(100, Math.max(1, options.limit ?? 50));
    const filter: Record<string, unknown> = {};
    if (options.cursor?.trim()) {
      if (!Types.ObjectId.isValid(options.cursor.trim())) {
        throw new BadRequestException('Invalid cursor');
      }
      filter._id = { $lt: new Types.ObjectId(options.cursor.trim()) };
    }

    const rows = await this.waveUnlockPurchaseModel
      .find(filter)
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

    const items: AdminPeaksTransactionDto[] = page.map((row) => {
      const id = String(row._id);
      const regionId = row.regionId ?? '';
      return {
        id,
        jobId: row.jobId,
        sessionId: row.sessionId,
        type: row.type,
        buyerUserId: row.buyerUserId,
        partnerUserId: row.partnerUserId ?? '',
        beneficiaryUserId: row.beneficiaryUserId,
        peaksCharged: row.peaksCharged ?? 0,
        basePeaks: row.basePeaks ?? 0,
        communityFeePeaks: row.communityFeePeaks ?? 0,
        discountPercent: row.discountPercent ?? 0,
        countryCode: row.countryCode ?? '',
        regionId,
        regionName: regionNameById.get(regionId) ?? null,
        createdAt: row.createdAt,
      };
    });

    const nextCursor = hasMore ? String(page[page.length - 1]!._id) : null;
    return { items, nextCursor };
  }

  async listByCountry(): Promise<AdminPeaksGeoRowDto[]> {
    const rows = await this.waveUnlockPurchaseModel
      .aggregate<{
        _id: string;
        transactionCount: number;
        communityFeePeaks: number;
        partnerPeaks: number;
        totalPeaksCharged: number;
      }>([
        { $match: { countryCode: { $exists: true, $ne: '' } } },
        {
          $group: {
            _id: '$countryCode',
            transactionCount: { $sum: 1 },
            communityFeePeaks: { $sum: { $ifNull: ['$communityFeePeaks', 0] } },
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

  async listByRegion(countryCodeRaw: string): Promise<AdminPeaksGeoRowDto[]> {
    const countryCode = normalizeCountryCode(countryCodeRaw);
    if (!COUNTRY_CODE.test(countryCode)) {
      throw new BadRequestException('countryCode must be a 2-letter ISO code');
    }

    const rows = await this.waveUnlockPurchaseModel
      .aggregate<{
        _id: string;
        transactionCount: number;
        communityFeePeaks: number;
        partnerPeaks: number;
        totalPeaksCharged: number;
      }>([
        { $match: { countryCode, regionId: { $exists: true, $ne: '' } } },
        {
          $group: {
            _id: '$regionId',
            transactionCount: { $sum: 1 },
            communityFeePeaks: { $sum: { $ifNull: ['$communityFeePeaks', 0] } },
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
