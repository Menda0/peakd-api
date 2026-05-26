import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { BILLING_CONFIG_KEY } from '../config/billing.config';
import { WaveUnlockPurchase } from '../commercial/schemas/wave-unlock-purchase.schema';
import { PartnerProfile } from '../partner/schemas/partner-profile.schema';
import { S3Service } from '../s3/s3.service';
import { UserProfile } from '../users/schemas/user-profile.schema';
import { VideoJob } from '../video/schemas/video-job.schema';
import { PayoutsService } from './payouts.service';
import { PartnerWithdrawal } from './schemas/partner-withdrawal.schema';

/**
 * The Stripe API client is constructed lazily inside `PayoutsService.stripe()`.
 * The tests need to stub `balance.retrieve` and `transfers.create` reliably, so
 * we patch the cached client right after the service is constructed.
 */
type StripeStub = {
  balance: { retrieve: jest.Mock };
  transfers: { create: jest.Mock };
};

describe('PayoutsService', () => {
  const partnerUserId = 'partner|1';
  const stripeAccountId = 'acct_test';

  let service: PayoutsService;
  let stripeStub: StripeStub;
  let mongoSession: {
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    abortTransaction: jest.Mock;
    endSession: jest.Mock;
  };
  let userProfileModel: {
    findOne: jest.Mock;
    findOneAndUpdate: jest.Mock;
    updateOne: jest.Mock;
  };
  let partnerProfileModel: { findOne: jest.Mock };
  let partnerWithdrawalModel: {
    find: jest.Mock;
    findOneAndUpdate: jest.Mock;
    findByIdAndUpdate: jest.Mock;
    create: jest.Mock;
    updateOne: jest.Mock;
    exists: jest.Mock;
  };

  function leanExec<T>(value: T) {
    return { lean: () => ({ exec: () => Promise.resolve(value) }) };
  }

  function plainExec<T>(value: T) {
    return { exec: () => Promise.resolve(value) };
  }

  beforeEach(async () => {
    mongoSession = {
      startTransaction: jest.fn(),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      abortTransaction: jest.fn().mockResolvedValue(undefined),
      endSession: jest.fn(),
    };
    const connection = {
      startSession: jest.fn().mockResolvedValue(mongoSession),
    };

    userProfileModel = {
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
      updateOne: jest.fn().mockReturnValue(plainExec({ modifiedCount: 1 })),
    };
    partnerProfileModel = {
      findOne: jest.fn().mockReturnValue({
        select: () =>
          leanExec({
            stripeConnectAccountId: stripeAccountId,
            stripeConnectPayoutsEnabled: true,
            stripeConnectRequirementsDue: [],
            countryCode: 'PT',
          }),
      }),
    };
    partnerWithdrawalModel = {
      find: jest.fn(),
      findOneAndUpdate: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      create: jest
        .fn()
        .mockResolvedValue([{ _id: 'withdrawal-1' }]),
      updateOne: jest
        .fn()
        .mockReturnValue(plainExec({ matchedCount: 1 })),
      exists: jest.fn().mockReturnValue(plainExec(null)),
    };

    const waveUnlockPurchaseModel = { find: jest.fn() };
    const videoJobModel = { find: jest.fn() };
    const s3Service = { presignedGetUrl: jest.fn() };

    const configService = {
      get: jest.fn((key: string) =>
        key === BILLING_CONFIG_KEY
          ? {
              peaksPerEuro: 100,
              partnerMinWithdrawalCents: 1000,
              stripeSecretKey: 'sk_test_dummy',
              appBaseUrl: 'http://localhost',
              partnerPayoutReturnPath: '/partner/income',
            }
          : undefined,
      ),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PayoutsService,
        { provide: getConnectionToken(), useValue: connection },
        { provide: getModelToken(UserProfile.name), useValue: userProfileModel },
        {
          provide: getModelToken(PartnerProfile.name),
          useValue: partnerProfileModel,
        },
        {
          provide: getModelToken(PartnerWithdrawal.name),
          useValue: partnerWithdrawalModel,
        },
        {
          provide: getModelToken(WaveUnlockPurchase.name),
          useValue: waveUnlockPurchaseModel,
        },
        { provide: getModelToken(VideoJob.name), useValue: videoJobModel },
        { provide: S3Service, useValue: s3Service },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = moduleRef.get(PayoutsService);

    stripeStub = {
      balance: { retrieve: jest.fn() },
      transfers: { create: jest.fn() },
    };
    // Replace the lazily-constructed Stripe client with our stub.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).stripeClient = stripeStub;
  });

  describe('requestWithdrawal — Stripe balance pre-flight (A3)', () => {
    it('returns 503 with a friendly message when EUR available is below amount', async () => {
      stripeStub.balance.retrieve.mockResolvedValue({
        available: [{ currency: 'eur', amount: 500 }],
        pending: [{ currency: 'eur', amount: 5000 }],
      });

      await expect(
        service.requestWithdrawal(partnerUserId, 1000),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      // We must reject *before* debiting the in-DB ledger.
      expect(userProfileModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(stripeStub.transfers.create).not.toHaveBeenCalled();
    });

    it('lets the withdrawal through when EUR available covers the request', async () => {
      stripeStub.balance.retrieve.mockResolvedValue({
        available: [{ currency: 'eur', amount: 10_000 }],
        pending: [],
      });
      userProfileModel.findOneAndUpdate.mockReturnValue(
        leanExec({ partnerEarningsCents: 9_000 }),
      );
      partnerWithdrawalModel.findByIdAndUpdate.mockReturnValue(
        leanExec({
          _id: 'withdrawal-1',
          amountCents: 1000,
          currency: 'eur',
          status: 'completed',
          failureReason: null,
          createdAt: new Date(),
        }),
      );
      stripeStub.transfers.create.mockResolvedValue({ id: 'tr_test' });

      const result = await service.requestWithdrawal(partnerUserId, 1000);

      expect(result.amountCents).toBe(1000);
      expect(stripeStub.transfers.create).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 1000,
          currency: 'eur',
          destination: stripeAccountId,
        }),
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      );
    });

    it('does not block on Stripe API outages (the live transfer would still fail loudly)', async () => {
      stripeStub.balance.retrieve.mockRejectedValue(
        new Error('Stripe is down'),
      );
      userProfileModel.findOneAndUpdate.mockReturnValue(
        leanExec({ partnerEarningsCents: 9_000 }),
      );
      partnerWithdrawalModel.findByIdAndUpdate.mockReturnValue(
        leanExec({
          _id: 'withdrawal-1',
          amountCents: 1000,
          currency: 'eur',
          status: 'completed',
          failureReason: null,
          createdAt: new Date(),
        }),
      );
      stripeStub.transfers.create.mockResolvedValue({ id: 'tr_test' });

      const result = await service.requestWithdrawal(partnerUserId, 1000);
      expect(result.amountCents).toBe(1000);
    });

    it('still rejects below-minimum withdrawals before consulting Stripe', async () => {
      await expect(
        service.requestWithdrawal(partnerUserId, 100),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(stripeStub.balance.retrieve).not.toHaveBeenCalled();
    });

    it('translates Stripe transfer failures into ConflictException after debit rollback', async () => {
      stripeStub.balance.retrieve.mockResolvedValue({
        available: [{ currency: 'eur', amount: 10_000 }],
        pending: [],
      });
      userProfileModel.findOneAndUpdate.mockReturnValue(
        leanExec({ partnerEarningsCents: 9_000 }),
      );
      stripeStub.transfers.create.mockRejectedValue(
        new Error('Stripe was unhappy'),
      );

      await expect(
        service.requestWithdrawal(partnerUserId, 1000),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('syncWithdrawalFromTransfer — transfer.reversed refunds liability (A2)', () => {
    it('atomically refunds partnerEarningsCents on reversal', async () => {
      partnerWithdrawalModel.findOneAndUpdate.mockReturnValue(
        leanExec({
          _id: 'withdrawal-1',
          userId: partnerUserId,
          amountCents: 1500,
          status: 'failed',
        }),
      );

      const res = await service.syncWithdrawalFromTransfer(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'tr_reversed' } as any,
        'transfer.reversed',
      );

      expect(res.matched).toBe(true);
      expect(partnerWithdrawalModel.findOneAndUpdate).toHaveBeenCalledWith(
        { stripeTransferId: 'tr_reversed', status: { $ne: 'failed' } },
        expect.objectContaining({
          $set: expect.objectContaining({ status: 'failed' }),
        }),
        expect.objectContaining({
          session: mongoSession,
          returnDocument: 'after',
        }),
      );
      expect(userProfileModel.updateOne).toHaveBeenCalledWith(
        { userId: partnerUserId },
        { $inc: { partnerEarningsCents: 1500 } },
        expect.objectContaining({ session: mongoSession }),
      );
      expect(mongoSession.commitTransaction).toHaveBeenCalled();
    });

    it('is idempotent: a replayed reversal does not double-refund', async () => {
      partnerWithdrawalModel.findOneAndUpdate.mockReturnValue(leanExec(null));
      partnerWithdrawalModel.exists.mockReturnValue(
        plainExec({ _id: 'withdrawal-1' }),
      );

      const res = await service.syncWithdrawalFromTransfer(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'tr_reversed' } as any,
        'transfer.reversed',
      );

      expect(res.matched).toBe(true);
      expect(userProfileModel.updateOne).not.toHaveBeenCalled();
      expect(mongoSession.abortTransaction).toHaveBeenCalled();
      expect(mongoSession.commitTransaction).not.toHaveBeenCalled();
    });

    it('reports matched=false for untracked transfer ids', async () => {
      partnerWithdrawalModel.findOneAndUpdate.mockReturnValue(leanExec(null));
      partnerWithdrawalModel.exists.mockReturnValue(plainExec(null));

      const res = await service.syncWithdrawalFromTransfer(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'tr_unknown' } as any,
        'transfer.reversed',
      );

      expect(res.matched).toBe(false);
      expect(userProfileModel.updateOne).not.toHaveBeenCalled();
    });

    it('non-reversed events take the simple updateOne path and do not credit liability', async () => {
      partnerWithdrawalModel.updateOne.mockReturnValueOnce(
        plainExec({ matchedCount: 1 }),
      );

      const res = await service.syncWithdrawalFromTransfer(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'tr_ok' } as any,
        'transfer.updated',
      );

      expect(res.matched).toBe(true);
      expect(partnerWithdrawalModel.updateOne).toHaveBeenCalledWith(
        { stripeTransferId: 'tr_ok' },
        { $set: { status: 'completed' } },
      );
      expect(userProfileModel.updateOne).not.toHaveBeenCalled();
    });
  });
});
