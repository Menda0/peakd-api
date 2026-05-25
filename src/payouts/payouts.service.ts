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
import { UserProfile } from '../users/schemas/user-profile.schema';
import {
  PartnerWithdrawal,
  type PartnerWithdrawalStatus,
} from './schemas/partner-withdrawal.schema';

const COUNTRY_CODE = /^[A-Z]{2}$/;

export type PartnerOnboardingStatus = 'not_started' | 'pending' | 'enabled';

export interface PartnerPayoutsStatusDto {
  withdrawablePeaks: number;
  peaksPerEuro: number;
  withdrawableAmountCents: number;
  minWithdrawalPeaks: number;
  minWithdrawalAmountCents: number;
  currency: 'eur';
  onboardingStatus: PartnerOnboardingStatus;
  payoutsEnabled: boolean;
  requirementsDue: string[];
  recentWithdrawals: PartnerWithdrawalDto[];
}

export interface PartnerWithdrawalDto {
  id: string;
  peaksDebited: number;
  amountCents: number;
  currency: string;
  status: PartnerWithdrawalStatus;
  failureReason: string | null;
  createdAt: string;
}

export interface PartnerEarningRowDto {
  id: string;
  jobId: string;
  basePeaks: number;
  peaksCharged: number;
  countryCode: string;
  regionId: string;
  type: string;
  createdAt: string;
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

  private peaksToCents(peaks: number, peaksPerEuro: number): number {
    return Math.floor((peaks * 100) / peaksPerEuro);
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

  private async getEarningsPeaks(userId: string): Promise<number> {
    const doc = await this.userProfileModel
      .findOne({ userId })
      .select({ partnerEarningsPeaks: 1 })
      .lean()
      .exec();
    return Math.max(0, doc?.partnerEarningsPeaks ?? 0);
  }

  private toWithdrawalDto(doc: {
    _id: unknown;
    peaksDebited: number;
    amountCents: number;
    currency: string;
    status: PartnerWithdrawalStatus;
    failureReason: string | null;
    createdAt?: Date;
  }): PartnerWithdrawalDto {
    return {
      id: String(doc._id),
      peaksDebited: doc.peaksDebited,
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
    const [partner, withdrawablePeaks, recentDocs] = await Promise.all([
      this.loadPartner(userId),
      this.getEarningsPeaks(userId),
      this.partnerWithdrawalModel
        .find({ userId })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean()
        .exec(),
    ]);

    const recentWithdrawals = recentDocs.map((d) =>
      this.toWithdrawalDto({
        _id: d._id,
        peaksDebited: d.peaksDebited,
        amountCents: d.amountCents,
        currency: d.currency,
        status: d.status,
        failureReason: d.failureReason ?? null,
        createdAt: (d as { createdAt?: Date }).createdAt,
      }),
    );

    return {
      withdrawablePeaks,
      peaksPerEuro: b.peaksPerEuro,
      withdrawableAmountCents: this.peaksToCents(
        withdrawablePeaks,
        b.peaksPerEuro,
      ),
      minWithdrawalPeaks: b.partnerMinWithdrawalPeaks,
      minWithdrawalAmountCents: this.peaksToCents(
        b.partnerMinWithdrawalPeaks,
        b.peaksPerEuro,
      ),
      currency: 'eur',
      onboardingStatus: this.resolveOnboardingStatus(partner),
      payoutsEnabled: partner.stripeConnectPayoutsEnabled,
      requirementsDue: partner.stripeConnectRequirementsDue,
      recentWithdrawals,
    };
  }

  async listEarnings(
    userId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<PartnerEarningsPageDto> {
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
    const items: PartnerEarningRowDto[] = page.map((row) => ({
      id: String(row._id),
      jobId: row.jobId,
      basePeaks: row.basePeaks ?? 0,
      peaksCharged: row.peaksCharged ?? 0,
      countryCode: row.countryCode ?? '',
      regionId: row.regionId ?? '',
      type: row.type,
      createdAt: row.createdAt,
    }));
    const nextCursor = hasMore
      ? (page[page.length - 1]!.createdAt ?? null)
      : null;
    return { items, nextCursor };
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
   * Debits `partnerEarningsPeaks`, persists a pending withdrawal, then creates
   * a Stripe Transfer to the connected account. On Stripe failure the debit is
   * reverted and the withdrawal is marked failed.
   */
  async requestWithdrawal(
    userId: string,
    peaksAmount: number,
  ): Promise<PartnerWithdrawalDto> {
    if (!Number.isInteger(peaksAmount) || peaksAmount < 1) {
      throw new BadRequestException('peaksAmount must be a positive integer');
    }
    const b = this.billing();
    if (peaksAmount < b.partnerMinWithdrawalPeaks) {
      throw new BadRequestException(
        `Minimum withdrawal is ${b.partnerMinWithdrawalPeaks} Peaks`,
      );
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

    const amountCents = this.peaksToCents(peaksAmount, b.peaksPerEuro);
    if (amountCents < 1) {
      throw new BadRequestException('Withdrawal amount must be at least 1 cent');
    }

    const idempotencyKey = `wd_${userId}_${randomUUID()}`;
    const stripeAccountId = partner.stripeConnectAccountId;

    const mongoSession = await this.connection.startSession();
    mongoSession.startTransaction();
    let withdrawalId: string;
    try {
      const debited = await this.userProfileModel
        .findOneAndUpdate(
          { userId, partnerEarningsPeaks: { $gte: peaksAmount } },
          { $inc: { partnerEarningsPeaks: -peaksAmount } },
          { session: mongoSession, returnDocument: 'after' },
        )
        .lean()
        .exec();
      if (!debited) {
        throw new BadRequestException('Insufficient withdrawable Peaks');
      }
      const created = await this.partnerWithdrawalModel.create(
        [
          {
            userId,
            stripeAccountId,
            peaksDebited: peaksAmount,
            amountCents,
            currency: 'eur',
            peaksPerEuro: b.peaksPerEuro,
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
          description: `Peakd partner withdrawal (${peaksAmount} Peaks)`,
          metadata: {
            userId,
            withdrawalId,
            peaksDebited: String(peaksAmount),
            peaksPerEuro: String(b.peaksPerEuro),
          },
        },
        { idempotencyKey },
      );
    } catch (err) {
      await this.refundFailedWithdrawal(
        userId,
        withdrawalId,
        peaksAmount,
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
      peaksDebited: updated.peaksDebited,
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
    peaks: number,
    reason: string,
  ): Promise<void> {
    const mongoSession = await this.connection.startSession();
    mongoSession.startTransaction();
    try {
      await this.userProfileModel
        .updateOne(
          { userId },
          { $inc: { partnerEarningsPeaks: peaks } },
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
