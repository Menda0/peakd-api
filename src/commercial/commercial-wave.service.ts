import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';
import { PartnerProfile } from '../partner/schemas/partner-profile.schema';
import { SurfSession } from '../studio/schemas/surf-session.schema';
import { UserProfile } from '../users/schemas/user-profile.schema';
import { VideoJob } from '../video/schemas/video-job.schema';
import {
  allocateBuyClaimLineBreakdowns,
  computeBuyClaimPeaks,
  computeCheckoutTotal,
  computeSponsorPeaks,
  resolveEffectiveCommercialSettings,
  type CheckoutOptions,
} from './commercial-pricing';
import { isSessionLocationUndisclosed } from '../studio/geo-undisclosed';
import type { CommercialSettings } from './commercial-settings.types';
import { WaveUnlockPurchase } from './schemas/wave-unlock-purchase.schema';

export type CommercialWaveContext = {
  job: {
    jobId: string;
    userId: string;
    surfSessionId: string | null;
    uploadSource?: string;
    status?: string;
    processedKey?: string | null;
    discoverPublishedAt?: string | null;
    claimStatus?: string;
    claimedByUserId?: string | null;
    videoUnlockedForUserId?: string | null;
  };
  session: {
    sessionId: string;
    userId: string;
    countryCode: string;
    regionId: string;
    spotId: string;
    isCommercial?: boolean;
    commercialSettings?: CommercialSettings | null;
  };
  settings: CommercialSettings;
};

@Injectable()
export class CommercialWaveService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(VideoJob.name)
    private readonly videoJobModel: Model<VideoJob>,
    @InjectModel(SurfSession.name)
    private readonly surfSessionModel: Model<SurfSession>,
    @InjectModel(PartnerProfile.name)
    private readonly partnerProfileModel: Model<PartnerProfile>,
    @InjectModel(UserProfile.name)
    private readonly userProfileModel: Model<UserProfile>,
    @InjectModel(WaveUnlockPurchase.name)
    private readonly waveUnlockPurchaseModel: Model<WaveUnlockPurchase>,
  ) {}

  private isCompleted(doc: { status?: string; processedKey?: string | null }): boolean {
    if (doc.status === 'completed') return true;
    return Boolean(doc.processedKey?.trim());
  }

  async loadCommercialContext(jobId: string): Promise<CommercialWaveContext> {
    const doc = await this.videoJobModel.findOne({ jobId }).lean().exec();
    if (!doc) {
      throw new NotFoundException(`Video job not found: ${jobId}`);
    }
    if (doc.uploadSource !== 'studio') {
      throw new BadRequestException('Only partner studio uploads support commercial flows');
    }
    if (!this.isCompleted(doc)) {
      throw new BadRequestException('Only completed videos support commercial flows');
    }
    if (!doc.discoverPublishedAt) {
      throw new BadRequestException('Video must be published to discover');
    }
    const sessionId = doc.surfSessionId?.trim();
    if (!sessionId) {
      throw new BadRequestException('Video must belong to a surf session');
    }
    const session = await this.surfSessionModel
      .findOne({ sessionId })
      .lean()
      .exec();
    if (!session?.isCommercial) {
      throw new BadRequestException('Session is not commercial');
    }
    const partner = await this.partnerProfileModel
      .findOne({ userId: session.userId })
      .lean()
      .exec();
    const settings = resolveEffectiveCommercialSettings(session, partner);
    if (!settings) {
      throw new BadRequestException('Commercial pricing is not configured for this session');
    }
    return {
      job: doc,
      session: {
        sessionId: session.sessionId,
        userId: session.userId,
        countryCode: session.countryCode,
        regionId: session.regionId,
        spotId: session.spotId,
        isCommercial: session.isCommercial,
        commercialSettings: session.commercialSettings as CommercialSettings | null,
      },
      settings,
    };
  }

  private checkoutOptions(ctx: CommercialWaveContext): CheckoutOptions {
    const waiveCommunityFee = isSessionLocationUndisclosed(
      ctx.session.countryCode,
      ctx.session.regionId,
      ctx.session.spotId,
    );
    return { waiveCommunityFee };
  }

  private buildPurchaseLedger(
    ctx: CommercialWaveContext,
    fields: {
      jobId: string;
      buyerUserId: string;
      beneficiaryUserId: string;
      type: 'buy_claim' | 'sponsor';
      peaksCharged: number;
      basePeaks: number;
      communityFeePeaks: number;
      discountPercent: number;
      createdAt: string;
    },
  ) {
    return {
      ...fields,
      sessionId: ctx.session.sessionId,
      partnerUserId: ctx.session.userId,
      countryCode: ctx.session.countryCode,
      regionId: ctx.session.regionId,
    };
  }

  private async debitPeaks(
    userId: string,
    amount: number,
    mongoSession: import('mongoose').ClientSession,
  ): Promise<void> {
    if (amount < 1) {
      throw new BadRequestException('Invalid Peaks amount');
    }
    const updated = await this.userProfileModel
      .findOneAndUpdate(
        { userId, peaksBalance: { $gte: amount } },
        { $inc: { peaksBalance: -amount } },
        { session: mongoSession, returnDocument: 'after' },
      )
      .lean()
      .exec();
    if (!updated) {
      const doc = await this.userProfileModel.findOne({ userId }).lean().exec();
      const balance = Math.max(0, doc?.peaksBalance ?? 0);
      throw new BadRequestException(
        `Insufficient Peaks balance (have ${balance}, need ${amount})`,
      );
    }
  }

  private async creditPeaks(
    userId: string,
    amount: number,
    mongoSession: import('mongoose').ClientSession,
  ): Promise<void> {
    if (amount < 1) {
      throw new BadRequestException('Invalid Peaks credit amount');
    }
    await this.userProfileModel.updateOne(
      { userId },
      {
        $inc: { peaksBalance: amount },
        $setOnInsert: {
          userId,
          displayName: null,
          nickname: null,
          countryCode: null,
          homeRegionId: null,
          surfLevel: null,
          avatarKey: null,
        },
      },
      { session: mongoSession, upsert: true },
    );
  }

  async buyAndClaimWave(
    buyerUserId: string,
    jobId: string,
    quantity = 1,
  ): Promise<{
    jobId: string;
    claimStatus: 'claimed';
    claimedAt: string;
    peaksCharged: number;
    discountPercent: number;
  }> {
    const ctx = await this.loadCommercialContext(jobId);
    const { totalPeaks: basePeaks, discountPercent } = computeBuyClaimPeaks(
      ctx.settings,
      quantity,
    );
    const checkout = computeCheckoutTotal(basePeaks, this.checkoutOptions(ctx));
    const { totalPeaks, communityFeePeaks } = checkout;
    const claimedAt = new Date().toISOString();
    const unlockedAt = claimedAt;
    const partnerUserId = ctx.session.userId;

    const mongoSession = await this.connection.startSession();
    mongoSession.startTransaction();
    try {
      await this.debitPeaks(buyerUserId, totalPeaks, mongoSession);
      await this.creditPeaks(partnerUserId, basePeaks, mongoSession);

      await this.videoJobModel
        .updateOne(
          { jobId },
          {
            $set: {
              claimStatus: 'claimed',
              claimedAt,
              claimedByUserId: buyerUserId,
              videoUnlockedForUserId: buyerUserId,
              videoUnlockedByUserId: buyerUserId,
              videoUnlockedAt: unlockedAt,
            },
          },
          { session: mongoSession },
        )
        .exec();

      await this.waveUnlockPurchaseModel.create(
        [
          this.buildPurchaseLedger(ctx, {
            jobId,
            buyerUserId,
            beneficiaryUserId: buyerUserId,
            type: 'buy_claim',
            peaksCharged: totalPeaks,
            basePeaks,
            communityFeePeaks,
            discountPercent,
            createdAt: unlockedAt,
          }),
        ],
        { session: mongoSession },
      );

      await mongoSession.commitTransaction();
    } catch (err) {
      await mongoSession.abortTransaction();
      throw err;
    } finally {
      void mongoSession.endSession();
    }

    return {
      jobId,
      claimStatus: 'claimed',
      claimedAt,
      peaksCharged: totalPeaks,
      discountPercent,
    };
  }

  async buyAndClaimWaves(
    buyerUserId: string,
    jobIds: string[],
  ): Promise<{
    jobIds: string[];
    peaksCharged: number;
    discountPercent: number;
    perJobPeaks: { jobId: string; peaksCharged: number }[];
  }> {
    const ids = [...new Set(jobIds.map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0) {
      throw new BadRequestException('At least one video is required');
    }

    const contexts = await Promise.all(
      ids.map((jobId) => this.loadCommercialContext(jobId)),
    );
    const sessionId = contexts[0]!.session.sessionId;
    for (const ctx of contexts) {
      if (ctx.session.sessionId !== sessionId) {
        throw new BadRequestException(
          'All videos must belong to the same session for volume pricing',
        );
      }
      if (ctx.job.videoUnlockedForUserId?.trim()) {
        throw new ConflictException(
          `Video ${ctx.job.jobId} is already unlocked`,
        );
      }
    }

    const ctx = contexts[0]!;
    const settings = ctx.settings;
    const lineBreakdowns = allocateBuyClaimLineBreakdowns(
      settings,
      ids.length,
      this.checkoutOptions(ctx),
    );
    const { discountPercent } = computeBuyClaimPeaks(settings, ids.length);
    const peaksCharged = lineBreakdowns.reduce(
      (sum, line) => sum + line.totalPeaks,
      0,
    );
    const partnerBaseTotal = lineBreakdowns.reduce(
      (sum, line) => sum + line.basePeaks,
      0,
    );
    const claimedAt = new Date().toISOString();
    const unlockedAt = claimedAt;
    const partnerUserId = ctx.session.userId;

    const mongoSession = await this.connection.startSession();
    mongoSession.startTransaction();
    try {
      await this.debitPeaks(buyerUserId, peaksCharged, mongoSession);
      await this.creditPeaks(partnerUserId, partnerBaseTotal, mongoSession);

      for (let i = 0; i < ids.length; i += 1) {
        const jobId = ids[i]!;
        const line = lineBreakdowns[i]!;
        const updated = await this.videoJobModel
          .updateOne(
            { jobId, videoUnlockedForUserId: null },
            {
              $set: {
                claimStatus: 'claimed',
                claimedAt,
                claimedByUserId: buyerUserId,
                videoUnlockedForUserId: buyerUserId,
                videoUnlockedByUserId: buyerUserId,
                videoUnlockedAt: unlockedAt,
              },
            },
            { session: mongoSession },
          )
          .exec();
        if (updated.matchedCount === 0) {
          throw new ConflictException(`Video ${jobId} is already unlocked`);
        }

        await this.waveUnlockPurchaseModel.create(
          [
            this.buildPurchaseLedger(ctx, {
              jobId,
              buyerUserId,
              beneficiaryUserId: buyerUserId,
              type: 'buy_claim',
              peaksCharged: line.totalPeaks,
              basePeaks: line.basePeaks,
              communityFeePeaks: line.communityFeePeaks,
              discountPercent,
              createdAt: unlockedAt,
            }),
          ],
          { session: mongoSession },
        );
      }

      await mongoSession.commitTransaction();
    } catch (err) {
      await mongoSession.abortTransaction();
      throw err;
    } finally {
      void mongoSession.endSession();
    }

    return {
      jobIds: ids,
      peaksCharged,
      discountPercent,
      perJobPeaks: ids.map((jobId, i) => ({
        jobId,
        peaksCharged: lineBreakdowns[i]!.totalPeaks,
      })),
    };
  }

  async sponsorWaveUnlock(
    sponsorUserId: string,
    jobId: string,
  ): Promise<{
    jobId: string;
    peaksCharged: number;
    beneficiaryUserId: string;
  }> {
    const ctx = await this.loadCommercialContext(jobId);
    if (ctx.job.videoUnlockedForUserId?.trim()) {
      throw new ConflictException('This wave is already unlocked');
    }
    const claimStatus = ctx.job.claimStatus ?? 'none';
    let beneficiary: string;
    let updateFilter: Record<string, unknown>;
    if (claimStatus === 'claimed') {
      const claimant = ctx.job.claimedByUserId?.trim();
      if (!claimant) {
        throw new BadRequestException('Wave has no claimant to sponsor');
      }
      if (claimant === sponsorUserId) {
        throw new BadRequestException(
          'You already claimed this wave — use buy and claim to unlock your video',
        );
      }
      beneficiary = claimant;
      updateFilter = {
        jobId,
        claimStatus: 'claimed',
        videoUnlockedForUserId: null,
      };
    } else if (claimStatus === 'none') {
      beneficiary = sponsorUserId;
      updateFilter = {
        jobId,
        claimStatus: 'none',
        videoUnlockedForUserId: null,
      };
    } else {
      throw new BadRequestException('Wave cannot be sponsored in this state');
    }
    const sponsorBase = computeSponsorPeaks(ctx.settings, 1);
    const checkout = computeCheckoutTotal(sponsorBase, this.checkoutOptions(ctx));
    const { totalPeaks: peaksCharged, communityFeePeaks } = checkout;
    const unlockedAt = new Date().toISOString();
    const partnerUserId = ctx.session.userId;

    const mongoSession = await this.connection.startSession();
    mongoSession.startTransaction();
    try {
      await this.debitPeaks(sponsorUserId, peaksCharged, mongoSession);
      await this.creditPeaks(partnerUserId, sponsorBase, mongoSession);

      const updated = await this.videoJobModel
        .findOneAndUpdate(
          updateFilter,
          {
            $set: {
              videoUnlockedForUserId: beneficiary,
              videoUnlockedByUserId: sponsorUserId,
              videoUnlockedAt: unlockedAt,
            },
          },
          { session: mongoSession, returnDocument: 'after' },
        )
        .lean()
        .exec();

      if (!updated) {
        throw new ConflictException('This wave is already unlocked');
      }

      await this.waveUnlockPurchaseModel.create(
        [
          this.buildPurchaseLedger(ctx, {
            jobId,
            buyerUserId: sponsorUserId,
            beneficiaryUserId: beneficiary,
            type: 'sponsor',
            peaksCharged,
            basePeaks: sponsorBase,
            communityFeePeaks,
            discountPercent: 0,
            createdAt: unlockedAt,
          }),
        ],
        { session: mongoSession },
      );

      await mongoSession.commitTransaction();
    } catch (err) {
      await mongoSession.abortTransaction();
      throw err;
    } finally {
      void mongoSession.endSession();
    }

    return { jobId, peaksCharged, beneficiaryUserId: beneficiary };
  }

}
