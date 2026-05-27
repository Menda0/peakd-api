import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { S3Service } from '../s3/s3.service';
import { WaveUnlockOrder } from '../commercial/schemas/wave-unlock-order.schema';
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

export type AdminSalesGeoFilter = {
  countryCode?: string;
  regionId?: string;
  /** Optional ISO 4217 currency filter (case-insensitive). */
  currency?: string;
};

export type AdminSalesCurrencyTotalDto = {
  /** Uppercase ISO 4217. */
  currency: string;
  transactionCount: number;
  partnerSubtotalMinor: number;
  platformCommissionMinor: number;
  totalAmountMinor: number;
};

export type AdminSalesSummaryDto = {
  /** Total completed wave-unlock orders matching the geo filter. */
  unlockTransactionCount: number;
  /** Per-currency rollups across the matching orders. */
  byCurrency: AdminSalesCurrencyTotalDto[];
  /** Country-scoped per-currency commission attribution (no region filter). */
  countryCommissionByCurrency: AdminSalesCurrencyTotalDto[] | null;
  /** Region-scoped per-currency commission attribution. */
  regionsCommissionByCurrency: AdminSalesCurrencyTotalDto[] | null;
};

export type AdminSalesTransactionDto = {
  id: string;
  orderId: string;
  jobIds: string[];
  intent: 'buy_claim' | 'sponsor';
  buyerUserId: string;
  buyerDisplayName: string | null;
  buyerAvatarUrl: string | null;
  partnerUserId: string;
  currency: string;
  partnerSubtotalMinor: number;
  platformCommissionMinor: number;
  totalAmountMinor: number;
  discountPercent: number;
  countryCode: string;
  regionId: string;
  regionName: string | null;
  completedAt: string;
};

export type AdminSalesTransactionsPageDto = {
  items: AdminSalesTransactionDto[];
  nextCursor: string | null;
};

export type AdminSalesGeoRowDto = {
  countryCode?: string;
  regionId?: string;
  regionName?: string | null;
  currency: string;
  transactionCount: number;
  partnerSubtotalMinor: number;
  platformCommissionMinor: number;
  totalAmountMinor: number;
};

function parseGeoFilter(raw: {
  countryCode?: string;
  regionId?: string;
  currency?: string;
}): AdminSalesGeoFilter {
  const countryCode = raw.countryCode?.trim()
    ? normalizeCountryCode(raw.countryCode)
    : undefined;
  const regionId = raw.regionId?.trim() || undefined;
  const currency = raw.currency?.trim().toUpperCase() || undefined;
  if (countryCode && !COUNTRY_CODE.test(countryCode)) {
    throw new BadRequestException('countryCode must be a 2-letter ISO code');
  }
  if (currency && !/^[A-Z]{3}$/.test(currency)) {
    throw new BadRequestException('currency must be a 3-letter ISO code');
  }
  if (regionId && countryCode && isUndisclosedRegionId(regionId, countryCode)) {
    throw new BadRequestException(
      'Cannot filter commission by undisclosed region',
    );
  }
  if (regionId && !countryCode) {
    throw new BadRequestException('countryCode is required when regionId is set');
  }
  return { countryCode, regionId, currency };
}

function orderMatchFilter(
  filter: AdminSalesGeoFilter,
): Record<string, unknown> {
  const match: Record<string, unknown> = { status: 'completed' };
  if (filter.countryCode) {
    match.countryCode = filter.countryCode;
  }
  if (filter.regionId) {
    match.regionId = filter.regionId;
  }
  if (filter.currency) {
    match.currency = filter.currency;
  }
  return match;
}

/** Platform commission isn't attributed to undisclosed synthetic regions. */
function attributedCommissionMinorExpr() {
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
        { $ifNull: ['$platformCommissionMinor', 0] },
      ],
    },
  };
}

@Injectable()
export class AdminSalesService {
  constructor(
    @InjectModel(WaveUnlockOrder.name)
    private readonly waveUnlockOrderModel: Model<WaveUnlockOrder>,
    @InjectModel(UserProfile.name)
    private readonly userProfileModel: Model<UserProfile>,
    @InjectModel(Region.name)
    private readonly regionModel: Model<Region>,
    private readonly config: ConfigService,
    private readonly s3: S3Service,
  ) {}

  async getSummary(
    filterRaw?: AdminSalesGeoFilter,
  ): Promise<AdminSalesSummaryDto> {
    const filter = parseGeoFilter(filterRaw ?? {});
    const orderMatch = orderMatchFilter(filter);

    const byCurrencyAgg = await this.waveUnlockOrderModel
      .aggregate<{
        _id: string;
        transactionCount: number;
        partnerSubtotalMinor: number;
        platformCommissionMinor: number;
        totalAmountMinor: number;
      }>([
        { $match: orderMatch },
        {
          $group: {
            _id: '$currency',
            transactionCount: { $sum: 1 },
            partnerSubtotalMinor: {
              $sum: { $ifNull: ['$partnerSubtotalMinor', 0] },
            },
            platformCommissionMinor: attributedCommissionMinorExpr(),
            totalAmountMinor: {
              $sum: { $ifNull: ['$totalAmountMinor', 0] },
            },
          },
        },
        { $sort: { totalAmountMinor: -1 } },
      ])
      .exec();
    const byCurrency: AdminSalesCurrencyTotalDto[] = byCurrencyAgg.map(
      (row) => ({
        currency: row._id,
        transactionCount: row.transactionCount,
        partnerSubtotalMinor: row.partnerSubtotalMinor,
        platformCommissionMinor: row.platformCommissionMinor,
        totalAmountMinor: row.totalAmountMinor,
      }),
    );

    const unlockTransactionCount = byCurrency.reduce(
      (n, r) => n + r.transactionCount,
      0,
    );

    let countryCommissionByCurrency: AdminSalesCurrencyTotalDto[] | null = null;
    let regionsCommissionByCurrency: AdminSalesCurrencyTotalDto[] | null = null;
    if (filter.countryCode) {
      countryCommissionByCurrency = await this.commissionByCurrency({
        countryCode: filter.countryCode,
        currency: filter.currency,
      });
      regionsCommissionByCurrency = filter.regionId
        ? byCurrency
        : await this.commissionByCurrency({
            countryCode: filter.countryCode,
            currency: filter.currency,
            disclosedRegionsOnly: true,
          });
    }
    return {
      unlockTransactionCount,
      byCurrency,
      countryCommissionByCurrency,
      regionsCommissionByCurrency,
    };
  }

  private async commissionByCurrency(opts: {
    countryCode: string;
    currency?: string;
    disclosedRegionsOnly?: boolean;
  }): Promise<AdminSalesCurrencyTotalDto[]> {
    const match: Record<string, unknown> = {
      status: 'completed',
      countryCode: opts.countryCode,
    };
    if (opts.currency) match.currency = opts.currency;
    if (opts.disclosedRegionsOnly) {
      match.regionId = {
        $exists: true,
        $ne: '',
        $not: UNDISCLOSED_REGION_ID_PATTERN,
      };
    }
    const rows = await this.waveUnlockOrderModel
      .aggregate<{
        _id: string;
        transactionCount: number;
        partnerSubtotalMinor: number;
        platformCommissionMinor: number;
        totalAmountMinor: number;
      }>([
        { $match: match },
        {
          $group: {
            _id: '$currency',
            transactionCount: { $sum: 1 },
            partnerSubtotalMinor: {
              $sum: { $ifNull: ['$partnerSubtotalMinor', 0] },
            },
            platformCommissionMinor: attributedCommissionMinorExpr(),
            totalAmountMinor: {
              $sum: { $ifNull: ['$totalAmountMinor', 0] },
            },
          },
        },
        { $sort: { totalAmountMinor: -1 } },
      ])
      .exec();
    return rows.map((row) => ({
      currency: row._id,
      transactionCount: row.transactionCount,
      partnerSubtotalMinor: row.partnerSubtotalMinor,
      platformCommissionMinor: row.platformCommissionMinor,
      totalAmountMinor: row.totalAmountMinor,
    }));
  }

  async listTransactions(options: {
    limit?: number;
    cursor?: string;
    countryCode?: string;
    regionId?: string;
    currency?: string;
  }): Promise<AdminSalesTransactionsPageDto> {
    const filter = parseGeoFilter({
      countryCode: options.countryCode,
      regionId: options.regionId,
      currency: options.currency,
    });
    const limit = Math.min(100, Math.max(1, options.limit ?? 50));
    const query: Record<string, unknown> = { ...orderMatchFilter(filter) };
    if (options.cursor?.trim()) {
      const cursorDate = new Date(options.cursor.trim());
      if (Number.isNaN(cursorDate.getTime())) {
        throw new BadRequestException('Invalid cursor');
      }
      query.completedAt = { $lt: cursorDate };
    }
    const rows = await this.waveUnlockOrderModel
      .find(query)
      .sort({ completedAt: -1 })
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

    const items: AdminSalesTransactionDto[] = page.map((row) => {
      const id = String(row._id);
      const regionId = row.regionId ?? '';
      const countryCode = row.countryCode ?? '';
      const isUndisclosed = isUndisclosedRegionId(regionId, countryCode);
      const buyer = buyerByUserId.get(row.buyerUserId) ?? {
        displayName: null,
        avatarUrl: null,
      };
      const completedAt = row.completedAt ?? new Date();
      return {
        id,
        orderId: row.orderId,
        jobIds: row.jobIds ?? [],
        intent: row.intent,
        buyerUserId: row.buyerUserId,
        buyerDisplayName: buyer.displayName,
        buyerAvatarUrl: buyer.avatarUrl,
        partnerUserId: row.partnerUserId ?? '',
        currency: row.currency,
        partnerSubtotalMinor: row.partnerSubtotalMinor ?? 0,
        platformCommissionMinor: isUndisclosed
          ? 0
          : (row.platformCommissionMinor ?? 0),
        totalAmountMinor: row.totalAmountMinor ?? 0,
        discountPercent: row.discountPercent ?? 0,
        countryCode,
        regionId,
        regionName: regionNameById.get(regionId) ?? null,
        completedAt: completedAt.toISOString(),
      };
    });

    const nextCursor = hasMore
      ? (page[page.length - 1]!.completedAt?.toISOString() ?? null)
      : null;
    return { items, nextCursor };
  }

  async listByCountry(
    filterRaw?: AdminSalesGeoFilter,
  ): Promise<AdminSalesGeoRowDto[]> {
    const filter = parseGeoFilter(filterRaw ?? {});
    const match: Record<string, unknown> = {
      status: 'completed',
      countryCode: { $exists: true, $ne: '' },
      ...orderMatchFilter(
        filter.countryCode
          ? { countryCode: filter.countryCode, regionId: filter.regionId, currency: filter.currency }
          : { regionId: filter.regionId, currency: filter.currency },
      ),
    };
    delete (match as { status?: unknown }).status;
    match.status = 'completed';
    const rows = await this.waveUnlockOrderModel
      .aggregate<{
        _id: { countryCode: string; currency: string };
        transactionCount: number;
        partnerSubtotalMinor: number;
        platformCommissionMinor: number;
        totalAmountMinor: number;
      }>([
        { $match: match },
        {
          $group: {
            _id: { countryCode: '$countryCode', currency: '$currency' },
            transactionCount: { $sum: 1 },
            partnerSubtotalMinor: {
              $sum: { $ifNull: ['$partnerSubtotalMinor', 0] },
            },
            platformCommissionMinor: attributedCommissionMinorExpr(),
            totalAmountMinor: {
              $sum: { $ifNull: ['$totalAmountMinor', 0] },
            },
          },
        },
        { $sort: { totalAmountMinor: -1 } },
      ])
      .exec();
    return rows.map((row) => ({
      countryCode: row._id.countryCode,
      currency: row._id.currency,
      transactionCount: row.transactionCount,
      partnerSubtotalMinor: row.partnerSubtotalMinor,
      platformCommissionMinor: row.platformCommissionMinor,
      totalAmountMinor: row.totalAmountMinor,
    }));
  }

  async listByRegion(
    countryCodeRaw: string,
    filterRaw?: { regionId?: string; currency?: string },
  ): Promise<AdminSalesGeoRowDto[]> {
    const filter = parseGeoFilter({
      countryCode: countryCodeRaw,
      regionId: filterRaw?.regionId,
      currency: filterRaw?.currency,
    });
    const countryCode = filter.countryCode!;
    const match: Record<string, unknown> = {
      status: 'completed',
      countryCode,
      regionId: filter.regionId
        ? filter.regionId
        : { $exists: true, $ne: '', $not: UNDISCLOSED_REGION_ID_PATTERN },
    };
    if (filter.currency) match.currency = filter.currency;
    const rows = await this.waveUnlockOrderModel
      .aggregate<{
        _id: { regionId: string; currency: string };
        transactionCount: number;
        partnerSubtotalMinor: number;
        platformCommissionMinor: number;
        totalAmountMinor: number;
      }>([
        { $match: match },
        {
          $group: {
            _id: { regionId: '$regionId', currency: '$currency' },
            transactionCount: { $sum: 1 },
            partnerSubtotalMinor: {
              $sum: { $ifNull: ['$partnerSubtotalMinor', 0] },
            },
            platformCommissionMinor: attributedCommissionMinorExpr(),
            totalAmountMinor: {
              $sum: { $ifNull: ['$totalAmountMinor', 0] },
            },
          },
        },
        { $sort: { totalAmountMinor: -1 } },
      ])
      .exec();

    const regionIds = [...new Set(rows.map((r) => r._id.regionId))];
    const regionNameById = await this.regionNamesById(regionIds);

    return rows.map((row) => ({
      countryCode,
      regionId: row._id.regionId,
      regionName: regionNameById.get(row._id.regionId) ?? null,
      currency: row._id.currency,
      transactionCount: row.transactionCount,
      partnerSubtotalMinor: row.partnerSubtotalMinor,
      platformCommissionMinor: row.platformCommissionMinor,
      totalAmountMinor: row.totalAmountMinor,
    }));
  }

  async listAllByRegion(): Promise<AdminSalesGeoRowDto[]> {
    const rows = await this.waveUnlockOrderModel
      .aggregate<{
        _id: { countryCode: string; regionId: string; currency: string };
        transactionCount: number;
        partnerSubtotalMinor: number;
        platformCommissionMinor: number;
        totalAmountMinor: number;
      }>([
        {
          $match: {
            status: 'completed',
            countryCode: { $exists: true, $ne: '' },
            regionId: {
              $exists: true,
              $ne: '',
              $not: UNDISCLOSED_REGION_ID_PATTERN,
            },
          },
        },
        {
          $group: {
            _id: {
              countryCode: '$countryCode',
              regionId: '$regionId',
              currency: '$currency',
            },
            transactionCount: { $sum: 1 },
            partnerSubtotalMinor: {
              $sum: { $ifNull: ['$partnerSubtotalMinor', 0] },
            },
            platformCommissionMinor: attributedCommissionMinorExpr(),
            totalAmountMinor: {
              $sum: { $ifNull: ['$totalAmountMinor', 0] },
            },
          },
        },
        { $sort: { totalAmountMinor: -1 } },
      ])
      .exec();

    const regionIds = [...new Set(rows.map((r) => r._id.regionId))];
    const regionNameById = await this.regionNamesById(regionIds);

    return rows.map((row) => ({
      countryCode: row._id.countryCode,
      regionId: row._id.regionId,
      regionName: regionNameById.get(row._id.regionId) ?? null,
      currency: row._id.currency,
      transactionCount: row.transactionCount,
      partnerSubtotalMinor: row.partnerSubtotalMinor,
      platformCommissionMinor: row.platformCommissionMinor,
      totalAmountMinor: row.totalAmountMinor,
    }));
  }

  private async resolveAvatarUrl(
    avatarKey: string | null,
  ): Promise<string | null> {
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
  ): Promise<
    Map<string, { displayName: string | null; avatarUrl: string | null }>
  > {
    const out = new Map<
      string,
      { displayName: string | null; avatarUrl: string | null }
    >();
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

  private async regionNamesById(
    regionIds: string[],
  ): Promise<Map<string, string>> {
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
