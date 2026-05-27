import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import Stripe from 'stripe';
import {
  BILLING_CONFIG_KEY,
  type BillingConfigValues,
} from '../config/billing.config';
import { WaveUnlockOrder } from '../commercial/schemas/wave-unlock-order.schema';
import { PartnerProfile } from '../partner/schemas/partner-profile.schema';
import { S3Service } from '../s3/s3.service';
import { UserProfile } from '../users/schemas/user-profile.schema';
import { VideoJob } from '../video/schemas/video-job.schema';

const EARNINGS_PREVIEW_MAX = 3;
const COUNTRY_CODE = /^[A-Z]{2}$/;

export type PartnerOnboardingStatus = 'not_started' | 'pending' | 'enabled';

export type PartnerEarningsTotalDto = {
  currency: string;
  totalMinor: number;
};

export interface PartnerPayoutsStatusDto {
  /** Lifetime partner share from completed orders, grouped by currency. */
  earningsTotalsByCurrency: PartnerEarningsTotalDto[];
  onboardingStatus: PartnerOnboardingStatus;
  payoutsEnabled: boolean;
  requirementsDue: string[];
}

export interface PartnerEarningBuyerDto {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface PartnerEarningRowDto {
  id: string;
  orderId: string;
  jobIds: string[];
  amountMinor: number;
  currency: string;
  countryCode: string;
  regionId: string;
  intent: 'buy_claim' | 'sponsor';
  createdAt: string;
  buyer: PartnerEarningBuyerDto;
  previewThumbnailUrls: string[];
}

export interface PartnerEarningsPageDto {
  items: PartnerEarningRowDto[];
  nextCursor: string | null;
}

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);
  private stripeClient: Stripe | null = null;

  constructor(
    private readonly config: ConfigService,
    @InjectModel(UserProfile.name)
    private readonly userProfileModel: Model<UserProfile>,
    @InjectModel(PartnerProfile.name)
    private readonly partnerProfileModel: Model<PartnerProfile>,
    @InjectModel(WaveUnlockOrder.name)
    private readonly waveUnlockOrderModel: Model<WaveUnlockOrder>,
    @InjectModel(VideoJob.name)
    private readonly videoJobModel: Model<VideoJob>,
    private readonly s3: S3Service,
  ) {}

  private billing(): BillingConfigValues {
    const b = this.config.get<BillingConfigValues>(BILLING_CONFIG_KEY);
    if (!b) {
      throw new InternalServerErrorException('Billing config missing');
    }
    return b;
  }

  private stripe(): Stripe {
    if (this.stripeClient) return this.stripeClient;
    const secret = this.billing().stripeSecretKey;
    if (!secret) {
      throw new InternalServerErrorException('STRIPE_SECRET_KEY is not set');
    }
    this.stripeClient = new Stripe(secret);
    return this.stripeClient;
  }

  private async loadPartner(userId: string): Promise<{
    stripeConnectAccountId: string | null;
    stripeConnectPayoutsEnabled: boolean;
    stripeConnectRequirementsDue: string[];
    countryCode: string | null;
  }> {
    const doc = await this.partnerProfileModel
      .findOne({ userId })
      .select({
        stripeConnectAccountId: 1,
        stripeConnectPayoutsEnabled: 1,
        stripeConnectRequirementsDue: 1,
        countryCode: 1,
      })
      .lean()
      .exec();
    return {
      stripeConnectAccountId: doc?.stripeConnectAccountId ?? null,
      stripeConnectPayoutsEnabled: doc?.stripeConnectPayoutsEnabled ?? false,
      stripeConnectRequirementsDue: doc?.stripeConnectRequirementsDue ?? [],
      countryCode: doc?.countryCode ?? null,
    };
  }

  private resolveOnboardingStatus(partner: {
    stripeConnectAccountId: string | null;
    stripeConnectPayoutsEnabled: boolean;
    stripeConnectRequirementsDue: string[];
  }): PartnerOnboardingStatus {
    if (!partner.stripeConnectAccountId) return 'not_started';
    if (
      partner.stripeConnectPayoutsEnabled &&
      partner.stripeConnectRequirementsDue.length === 0
    ) {
      return 'enabled';
    }
    return 'pending';
  }

  private async aggregateEarningsTotals(
    userId: string,
  ): Promise<PartnerEarningsTotalDto[]> {
    const rows = await this.waveUnlockOrderModel
      .aggregate<{ _id: string; totalMinor: number }>([
        { $match: { partnerUserId: userId, status: 'completed' } },
        {
          $group: {
            _id: { $toUpper: '$currency' },
            totalMinor: { $sum: { $ifNull: ['$partnerSubtotalMinor', 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .exec();
    return rows.map((row) => ({
      currency: row._id,
      totalMinor: Math.max(0, Math.round(row.totalMinor)),
    }));
  }

  async getStatus(userId: string): Promise<PartnerPayoutsStatusDto> {
    const [partnerInitial, earningsTotalsByCurrency] = await Promise.all([
      this.loadPartner(userId),
      this.aggregateEarningsTotals(userId),
    ]);
    const partner = await this.reconcileConnectAccount(userId, partnerInitial);

    return {
      earningsTotalsByCurrency,
      onboardingStatus: this.resolveOnboardingStatus(partner),
      payoutsEnabled: partner.stripeConnectPayoutsEnabled,
      requirementsDue: partner.stripeConnectRequirementsDue,
    };
  }

  private async reconcileConnectAccount(
    userId: string,
    partner: Awaited<ReturnType<PayoutsService['loadPartner']>>,
  ): Promise<Awaited<ReturnType<PayoutsService['loadPartner']>>> {
    if (!partner.stripeConnectAccountId) return partner;
    const cachedEnabled =
      partner.stripeConnectPayoutsEnabled &&
      partner.stripeConnectRequirementsDue.length === 0;
    if (cachedEnabled) return partner;
    try {
      const live = await this.stripe().accounts.retrieve(
        partner.stripeConnectAccountId,
      );
      await this.syncConnectAccountFromEvent(live);
      return await this.loadPartner(userId);
    } catch (err) {
      this.logger.warn(
        `Failed to refresh Stripe Connect account ${partner.stripeConnectAccountId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return partner;
    }
  }

  async listEarnings(
    userId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<PartnerEarningsPageDto> {
    const limit = Math.min(100, Math.max(1, options.limit ?? 20));
    const query: Record<string, unknown> = {
      partnerUserId: userId,
      status: 'completed',
    };
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

    const buyerIds = [
      ...new Set(
        page
          .map((r) => r.buyerUserId?.trim())
          .filter((s): s is string => Boolean(s)),
      ),
    ];
    const jobIds = [
      ...new Set(page.flatMap((r) => r.jobIds ?? []).filter(Boolean)),
    ];
    const [buyersByUserId, thumbsByJobId] = await Promise.all([
      this.buyersByUserId(buyerIds),
      this.previewThumbnailsByJobId(jobIds),
    ]);

    const items: PartnerEarningRowDto[] = page.map((row) => {
      const buyer = buyersByUserId.get(row.buyerUserId) ?? {
        userId: row.buyerUserId,
        displayName: null,
        avatarUrl: null,
      };
      const previews: string[] = [];
      for (const jobId of row.jobIds ?? []) {
        for (const url of thumbsByJobId.get(jobId) ?? []) {
          if (previews.length >= EARNINGS_PREVIEW_MAX) break;
          previews.push(url);
        }
        if (previews.length >= EARNINGS_PREVIEW_MAX) break;
      }
      const completedAt = row.completedAt ?? new Date();
      return {
        id: row.orderId,
        orderId: row.orderId,
        jobIds: row.jobIds ?? [],
        amountMinor: row.partnerSubtotalMinor,
        currency: row.currency,
        countryCode: row.countryCode ?? '',
        regionId: row.regionId ?? '',
        intent: row.intent,
        createdAt: completedAt.toISOString(),
        buyer,
        previewThumbnailUrls: previews,
      };
    });
    const nextCursor = hasMore
      ? (page[page.length - 1]!.completedAt?.toISOString() ?? null)
      : null;
    return { items, nextCursor };
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

  private async buyersByUserId(
    userIds: string[],
  ): Promise<Map<string, PartnerEarningBuyerDto>> {
    const out = new Map<string, PartnerEarningBuyerDto>();
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
        userId: profile.userId,
        displayName,
        avatarUrl: key ? (avatarUrlByKey.get(key) ?? null) : null,
      });
    }
    for (const userId of userIds) {
      if (!out.has(userId)) {
        out.set(userId, { userId, displayName: null, avatarUrl: null });
      }
    }
    return out;
  }

  private async previewThumbnailsByJobId(
    jobIds: string[],
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (jobIds.length === 0) return out;
    const jobs = await this.videoJobModel
      .find({ jobId: { $in: jobIds } })
      .select({ jobId: 1, snapshotKeys: 1 })
      .lean()
      .exec();
    const urlByKey = new Map<string, string>();
    for (const job of jobs) {
      const keys = (job.snapshotKeys ?? []).slice(0, EARNINGS_PREVIEW_MAX);
      const urls: string[] = [];
      for (const key of keys) {
        const trimmed = key?.trim();
        if (!trimmed) continue;
        let url = urlByKey.get(trimmed);
        if (!url) {
          url = await this.s3.presignedGetUrl(trimmed);
          urlByKey.set(trimmed, url);
        }
        urls.push(url);
      }
      out.set(job.jobId, urls);
    }
    for (const id of jobIds) {
      if (!out.has(id)) out.set(id, []);
    }
    return out;
  }

  /** Returns a Stripe Account Link URL for partner Connect onboarding. */
  async createOnboardingLink(userId: string): Promise<{ url: string }> {
    const b = this.billing();
    if (!b.appBaseUrl) {
      throw new InternalServerErrorException('APP_BASE_URL is not set');
    }
    const partner = await this.loadPartner(userId);

    let accountId = partner.stripeConnectAccountId;
    if (!accountId) {
      const account = await this.stripe().accounts.create({
        controller: {
          losses: { payments: 'application' },
          fees: { payer: 'application' },
          stripe_dashboard: { type: 'express' },
          requirement_collection: 'stripe',
        },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        country:
          partner.countryCode && COUNTRY_CODE.test(partner.countryCode)
            ? partner.countryCode
            : undefined,
        metadata: { userId },
      });
      accountId = account.id;
      await this.partnerProfileModel
        .updateOne(
          { userId },
          {
            $set: { stripeConnectAccountId: accountId },
            $setOnInsert: {
              userId,
              partnerName: null,
              partnerType: 'videographer',
              descriptionMarkdown: null,
              avatarKey: null,
              countryCode: null,
            },
          },
          { upsert: true },
        )
        .exec();
    }

    const returnUrl = `${b.appBaseUrl}${b.partnerPayoutReturnPath}`;
    const refreshUrl = `${b.appBaseUrl}${b.partnerPayoutReturnPath}?refresh=1`;
    const link = await this.stripe().accountLinks.create({
      account: accountId,
      type: 'account_onboarding',
      return_url: returnUrl,
      refresh_url: refreshUrl,
    });
    return { url: link.url };
  }

  /** Webhook hook: update cached onboarding flags from `account.updated`. */
  async syncConnectAccountFromEvent(
    account: Stripe.Account,
  ): Promise<{ matched: boolean }> {
    const userId =
      typeof account.metadata?.userId === 'string'
        ? account.metadata.userId
        : null;
    const requirementsDue = account.requirements?.currently_due ?? [];
    const payoutsEnabled = Boolean(
      account.charges_enabled && account.payouts_enabled,
    );

    const filter: Record<string, unknown> = userId
      ? { userId }
      : { stripeConnectAccountId: account.id };
    const res = await this.partnerProfileModel
      .updateOne(filter, {
        $set: {
          stripeConnectAccountId: account.id,
          stripeConnectPayoutsEnabled: payoutsEnabled,
          stripeConnectRequirementsDue: requirementsDue,
        },
      })
      .exec();
    return { matched: res.matchedCount > 0 };
  }
}
