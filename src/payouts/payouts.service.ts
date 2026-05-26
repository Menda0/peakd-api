import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { Connection, Model } from 'mongoose';
import Stripe from 'stripe';
import {
  BILLING_CONFIG_KEY,
  type BillingConfigValues,
} from '../config/billing.config';
import { WaveUnlockPurchase } from '../commercial/schemas/wave-unlock-purchase.schema';
import { PartnerProfile } from '../partner/schemas/partner-profile.schema';
import { S3Service } from '../s3/s3.service';
import { UserProfile } from '../users/schemas/user-profile.schema';
import { VideoJob } from '../video/schemas/video-job.schema';
import {
  PartnerWithdrawal,
  type PartnerWithdrawalStatus,
} from './schemas/partner-withdrawal.schema';

/** Cap on snapshot previews per earnings row (matches the UI ask). */
const EARNINGS_PREVIEW_MAX = 3;

const COUNTRY_CODE = /^[A-Z]{2}$/;

export type PartnerOnboardingStatus = 'not_started' | 'pending' | 'enabled';

export interface PartnerPayoutsStatusDto {
  withdrawableAmountCents: number;
  minWithdrawalAmountCents: number;
  currency: 'eur';
  onboardingStatus: PartnerOnboardingStatus;
  payoutsEnabled: boolean;
  requirementsDue: string[];
  recentWithdrawals: PartnerWithdrawalDto[];
}

export interface PartnerWithdrawalDto {
  id: string;
  amountCents: number;
  currency: string;
  status: PartnerWithdrawalStatus;
  failureReason: string | null;
  createdAt: string;
}

export interface PartnerEarningBuyerDto {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface PartnerEarningRowDto {
  id: string;
  jobId: string;
  amountCents: number;
  countryCode: string;
  regionId: string;
  type: string;
  createdAt: string;
  buyer: PartnerEarningBuyerDto;
  /** Up to `EARNINGS_PREVIEW_MAX` snapshot URLs for the unlocked video. */
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
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(UserProfile.name)
    private readonly userProfileModel: Model<UserProfile>,
    @InjectModel(PartnerProfile.name)
    private readonly partnerProfileModel: Model<PartnerProfile>,
    @InjectModel(PartnerWithdrawal.name)
    private readonly partnerWithdrawalModel: Model<PartnerWithdrawal>,
    @InjectModel(WaveUnlockPurchase.name)
    private readonly waveUnlockPurchaseModel: Model<WaveUnlockPurchase>,
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

  private async getEarningsCents(userId: string): Promise<number> {
    const doc = await this.userProfileModel
      .findOne({ userId })
      .select({ partnerEarningsCents: 1 })
      .lean()
      .exec();
    return Math.max(0, doc?.partnerEarningsCents ?? 0);
  }

  private toWithdrawalDto(doc: {
    _id: unknown;
    amountCents: number;
    currency: string;
    status: PartnerWithdrawalStatus;
    failureReason: string | null;
    createdAt?: Date;
  }): PartnerWithdrawalDto {
    return {
      id: String(doc._id),
      amountCents: doc.amountCents,
      currency: doc.currency,
      status: doc.status,
      failureReason: doc.failureReason ?? null,
      createdAt: (doc.createdAt ?? new Date()).toISOString(),
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

  async getStatus(userId: string): Promise<PartnerPayoutsStatusDto> {
    const b = this.billing();
    const [partnerInitial, withdrawableAmountCents, recentDocs] =
      await Promise.all([
        this.loadPartner(userId),
        this.getEarningsCents(userId),
        this.partnerWithdrawalModel
          .find({ userId })
          .sort({ createdAt: -1 })
          .limit(10)
          .lean()
          .exec(),
      ]);

    // Webhooks (`account.updated`) are eventually consistent, so when the user
    // just returned from Stripe Connect onboarding the cached flags may still
    // be stale. Reconcile live against Stripe whenever we have an account but
    // haven't seen it become fully enabled yet — this is the recommended
    // pattern over relying solely on the webhook.
    const partner = await this.reconcileConnectAccount(userId, partnerInitial);

    const recentWithdrawals = recentDocs.map((d) =>
      this.toWithdrawalDto({
        _id: d._id,
        amountCents: d.amountCents,
        currency: d.currency,
        status: d.status,
        failureReason: d.failureReason ?? null,
        createdAt: (d as { createdAt?: Date }).createdAt,
      }),
    );

    return {
      withdrawableAmountCents,
      minWithdrawalAmountCents: b.partnerMinWithdrawalCents,
      currency: 'eur',
      onboardingStatus: this.resolveOnboardingStatus(partner),
      payoutsEnabled: partner.stripeConnectPayoutsEnabled,
      requirementsDue: partner.stripeConnectRequirementsDue,
      recentWithdrawals,
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
    const b = this.billing();
    const limit = Math.min(100, Math.max(1, options.limit ?? 20));
    const query: Record<string, unknown> = { partnerUserId: userId };
    if (options.cursor?.trim()) {
      // Cursor is the createdAt ISO string of the last item.
      query.createdAt = { $lt: options.cursor.trim() };
    }
    const rows = await this.waveUnlockPurchaseModel
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean()
      .exec();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    // Batch the buyer + video lookups so we don't N+1 the database while
    // rendering the earnings list.
    const buyerIds = [
      ...new Set(
        page
          .map((r) => r.buyerUserId?.trim())
          .filter((s): s is string => Boolean(s)),
      ),
    ];
    const jobIds = [
      ...new Set(
        page
          .map((r) => r.jobId?.trim())
          .filter((s): s is string => Boolean(s)),
      ),
    ];
    const [buyersByUserId, thumbsByJobId] = await Promise.all([
      this.buyersByUserId(buyerIds),
      this.previewThumbnailsByJobId(jobIds),
    ]);

    const items: PartnerEarningRowDto[] = page.map((row) => {
      // New rows persist `partnerEarningsCents` at unlock time; legacy rows
      // pre-dating the pivot don't, so fall back to the live conversion.
      const persistedCents =
        typeof row.partnerEarningsCents === 'number'
          ? row.partnerEarningsCents
          : null;
      const amountCents =
        persistedCents ??
        Math.floor(((row.basePeaks ?? 0) * 100) / b.peaksPerEuro);
      const buyer = buyersByUserId.get(row.buyerUserId) ?? {
        userId: row.buyerUserId,
        displayName: null,
        avatarUrl: null,
      };
      return {
        id: String(row._id),
        jobId: row.jobId,
        amountCents,
        countryCode: row.countryCode ?? '',
        regionId: row.regionId ?? '',
        type: row.type,
        createdAt: row.createdAt,
        buyer,
        previewThumbnailUrls: thumbsByJobId.get(row.jobId) ?? [],
      };
    });
    const nextCursor = hasMore
      ? (page[page.length - 1]!.createdAt ?? null)
      : null;
    return { items, nextCursor };
  }

  /** Avatar URL resolution mirrors `AdminPeaksService.resolveAvatarUrl`. */
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

    // Presign once per unique avatar key so multiple buyers sharing one
    // avatar (rare but possible) don't trigger duplicate signing work.
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
    // Presign every unique snapshot key once and dedupe across rows.
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

  /**
   * Returns a Stripe Account Link URL for partner Connect onboarding.
   * Creates the connected account on first call and persists `stripeConnectAccountId`.
   */
  async createOnboardingLink(userId: string): Promise<{ url: string }> {
    const b = this.billing();
    if (!b.appBaseUrl) {
      throw new InternalServerErrorException('APP_BASE_URL is not set');
    }
    const partner = await this.loadPartner(userId);

    let accountId = partner.stripeConnectAccountId;
    if (!accountId) {
      const account = await this.stripe().accounts.create({
        // Controller-based account: platform liable, Stripe collects KYC,
        // partner gets the Express dashboard for payout history.
        controller: {
          losses: { payments: 'application' },
          fees: { payer: 'application' },
          stripe_dashboard: { type: 'express' },
          requirement_collection: 'stripe',
        },
        capabilities: {
          transfers: { requested: true },
        },
        country: partner.countryCode && COUNTRY_CODE.test(partner.countryCode)
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

  /**
   * Debits `partnerEarningsCents`, persists a pending withdrawal, then creates
   * a Stripe Transfer to the connected account. On Stripe failure the debit is
   * reverted and the withdrawal is marked failed.
   */
  async requestWithdrawal(
    userId: string,
    amountCents: number,
  ): Promise<PartnerWithdrawalDto> {
    if (!Number.isInteger(amountCents) || amountCents < 1) {
      throw new BadRequestException('amountCents must be a positive integer');
    }
    const b = this.billing();
    if (amountCents < b.partnerMinWithdrawalCents) {
      const min = (b.partnerMinWithdrawalCents / 100).toFixed(2);
      throw new BadRequestException(`Minimum withdrawal is €${min}`);
    }

    const partner = await this.loadPartner(userId);
    if (!partner.stripeConnectAccountId) {
      throw new BadRequestException(
        'Connect your bank account before withdrawing',
      );
    }
    if (
      !partner.stripeConnectPayoutsEnabled ||
      partner.stripeConnectRequirementsDue.length > 0
    ) {
      throw new BadRequestException(
        'Stripe onboarding is incomplete — finish KYC before withdrawing',
      );
    }

    const idempotencyKey = `wd_${userId}_${randomUUID()}`;
    const stripeAccountId = partner.stripeConnectAccountId;

    const mongoSession = await this.connection.startSession();
    mongoSession.startTransaction();
    let withdrawalId: string;
    try {
      const debited = await this.userProfileModel
        .findOneAndUpdate(
          { userId, partnerEarningsCents: { $gte: amountCents } },
          { $inc: { partnerEarningsCents: -amountCents } },
          { session: mongoSession, returnDocument: 'after' },
        )
        .lean()
        .exec();
      if (!debited) {
        throw new BadRequestException('Insufficient withdrawable balance');
      }
      const created = await this.partnerWithdrawalModel.create(
        [
          {
            userId,
            stripeAccountId,
            amountCents,
            currency: 'eur',
            idempotencyKey,
            stripeTransferId: null,
            status: 'pending',
            failureReason: null,
          },
        ],
        { session: mongoSession },
      );
      withdrawalId = String(created[0]!._id);
      await mongoSession.commitTransaction();
    } catch (err) {
      await mongoSession.abortTransaction();
      if (err instanceof BadRequestException) throw err;
      this.logger.error('Failed to record pending withdrawal', err);
      throw new InternalServerErrorException(
        'Failed to record pending withdrawal',
      );
    } finally {
      void mongoSession.endSession();
    }

    let transfer: Stripe.Transfer;
    try {
      transfer = await this.stripe().transfers.create(
        {
          amount: amountCents,
          currency: 'eur',
          destination: stripeAccountId,
          description: `Peakd partner withdrawal (€${(amountCents / 100).toFixed(2)})`,
          metadata: {
            userId,
            withdrawalId,
            amountCents: String(amountCents),
          },
        },
        { idempotencyKey },
      );
    } catch (err) {
      await this.refundFailedWithdrawal(
        userId,
        withdrawalId,
        amountCents,
        err instanceof Error ? err.message : 'Stripe transfer failed',
      );
      const msg = err instanceof Error ? err.message : 'Stripe transfer failed';
      throw new ConflictException(msg);
    }

    const updated = await this.partnerWithdrawalModel
      .findByIdAndUpdate(
        withdrawalId,
        {
          $set: {
            stripeTransferId: transfer.id,
            status: 'completed',
          },
        },
        { returnDocument: 'after' },
      )
      .lean()
      .exec();

    if (!updated) {
      throw new InternalServerErrorException('Withdrawal record disappeared');
    }
    return this.toWithdrawalDto({
      _id: updated._id,
      amountCents: updated.amountCents,
      currency: updated.currency,
      status: updated.status,
      failureReason: updated.failureReason ?? null,
      createdAt: (updated as { createdAt?: Date }).createdAt,
    });
  }

  /** Reverts a debit + marks the withdrawal failed (transactional). */
  private async refundFailedWithdrawal(
    userId: string,
    withdrawalId: string,
    amountCents: number,
    reason: string,
  ): Promise<void> {
    const mongoSession = await this.connection.startSession();
    mongoSession.startTransaction();
    try {
      await this.userProfileModel
        .updateOne(
          { userId },
          { $inc: { partnerEarningsCents: amountCents } },
          { session: mongoSession },
        )
        .exec();
      await this.partnerWithdrawalModel
        .updateOne(
          { _id: withdrawalId, status: 'pending' },
          { $set: { status: 'failed', failureReason: reason } },
          { session: mongoSession },
        )
        .exec();
      await mongoSession.commitTransaction();
    } catch (err) {
      await mongoSession.abortTransaction();
      this.logger.error('Failed to refund failed withdrawal', err);
    } finally {
      void mongoSession.endSession();
    }
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

  /** Webhook hook: reconcile a withdrawal record from a transfer event. */
  async syncWithdrawalFromTransfer(
    transfer: Stripe.Transfer,
    eventType: string,
  ): Promise<{ matched: boolean }> {
    const status: PartnerWithdrawalStatus =
      eventType === 'transfer.reversed' ? 'failed' : 'completed';
    const failureReason =
      eventType === 'transfer.reversed' ? 'Stripe reversed the transfer' : null;
    const res = await this.partnerWithdrawalModel
      .updateOne(
        { stripeTransferId: transfer.id },
        {
          $set: {
            status,
            ...(failureReason ? { failureReason } : {}),
          },
        },
      )
      .exec();
    return { matched: res.matchedCount > 0 };
  }
}
