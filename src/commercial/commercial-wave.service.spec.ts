import { BadRequestException } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { CommercialWaveService } from './commercial-wave.service';
import { PartnerProfile } from '../partner/schemas/partner-profile.schema';
import { SurfSession } from '../studio/schemas/surf-session.schema';
import { UserProfile } from '../users/schemas/user-profile.schema';
import { VideoJob } from '../video/schemas/video-job.schema';
import { WaveUnlockPurchase } from './schemas/wave-unlock-purchase.schema';

describe('CommercialWaveService', () => {
  const jobId = 'job-1';
  const sessionId = 'sess-1';
  const partnerUserId = 'partner|1';
  const buyerUserId = 'buyer|1';
  const priorClaimant = 'surfer|1';

  const commercialSession = {
    sessionId,
    userId: partnerUserId,
    isCommercial: true,
    commercialSettings: null,
  };

  const partnerProfile = {
    userId: partnerUserId,
    commercialSettings: {
      videoPricePeaks: 50,
      volumeDiscounts: [],
    },
  };

  const baseJob = {
    jobId,
    userId: partnerUserId,
    surfSessionId: sessionId,
    uploadSource: 'studio',
    status: 'completed',
    processedKey: 'processed/key.webm',
    discoverPublishedAt: new Date().toISOString(),
    claimStatus: 'none',
    claimedByUserId: null,
    videoUnlockedForUserId: null,
  };

  let service: CommercialWaveService;
  let videoJobModel: {
    findOne: jest.Mock;
    updateOne: jest.Mock;
    findOneAndUpdate: jest.Mock;
  };
  let userProfileModel: {
    findOneAndUpdate: jest.Mock;
    findOne: jest.Mock;
  };
  let waveUnlockPurchaseModel: { create: jest.Mock };
  let mongoSession: {
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    abortTransaction: jest.Mock;
    endSession: jest.Mock;
  };

  function leanExec<T>(value: T) {
    return { lean: () => ({ exec: () => Promise.resolve(value) }) };
  }

  beforeEach(async () => {
    mongoSession = {
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      abortTransaction: jest.fn(),
      endSession: jest.fn(),
    };
    const connection = {
      startSession: jest.fn().mockResolvedValue(mongoSession),
    };
    videoJobModel = {
      findOne: jest.fn(),
      updateOne: jest.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
      findOneAndUpdate: jest.fn(),
    };
    userProfileModel = {
      findOneAndUpdate: jest.fn(),
      findOne: jest.fn(),
    };
    waveUnlockPurchaseModel = {
      create: jest.fn().mockResolvedValue(undefined),
    };

    const surfSessionModel = { findOne: jest.fn() };
    const partnerProfileModel = { findOne: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CommercialWaveService,
        { provide: getConnectionToken(), useValue: connection },
        { provide: getModelToken(VideoJob.name), useValue: videoJobModel },
        { provide: getModelToken(SurfSession.name), useValue: surfSessionModel },
        { provide: getModelToken(PartnerProfile.name), useValue: partnerProfileModel },
        { provide: getModelToken(UserProfile.name), useValue: userProfileModel },
        {
          provide: getModelToken(WaveUnlockPurchase.name),
          useValue: waveUnlockPurchaseModel,
        },
      ],
    }).compile();

    service = moduleRef.get(CommercialWaveService);
    surfSessionModel.findOne.mockReturnValue(leanExec(commercialSession));
    partnerProfileModel.findOne.mockReturnValue(leanExec(partnerProfile));
    userProfileModel.findOneAndUpdate.mockReturnValue(
      leanExec({ peaksBalance: 100 }),
    );
  });

  it('buyAndClaimWave debits peaks and replaces prior claimant', async () => {
    videoJobModel.findOne.mockReturnValue(
      leanExec({
        ...baseJob,
        claimStatus: 'claimed',
        claimedByUserId: priorClaimant,
      }),
    );

    const result = await service.buyAndClaimWave(buyerUserId, jobId, 1);

    expect(result.peaksCharged).toBe(60);
    expect(userProfileModel.findOneAndUpdate).toHaveBeenCalledWith(
      { userId: buyerUserId, peaksBalance: { $gte: 60 } },
      { $inc: { peaksBalance: -60 } },
      expect.objectContaining({ session: mongoSession }),
    );
    expect(videoJobModel.updateOne).toHaveBeenCalledWith(
      { jobId },
      expect.objectContaining({
        $set: expect.objectContaining({
          claimedByUserId: buyerUserId,
          videoUnlockedForUserId: buyerUserId,
          claimStatus: 'claimed',
        }),
      }),
      expect.objectContaining({ session: mongoSession }),
    );
  });

  it('sponsorWaveUnlock unlocks for existing claimant without changing them', async () => {
    videoJobModel.findOne.mockReturnValue(
      leanExec({
        ...baseJob,
        claimStatus: 'claimed',
        claimedByUserId: priorClaimant,
      }),
    );
    videoJobModel.findOneAndUpdate.mockReturnValue({
      lean: () => ({
        exec: () =>
          Promise.resolve({
            ...baseJob,
            claimStatus: 'claimed',
            claimedByUserId: priorClaimant,
            videoUnlockedForUserId: priorClaimant,
          }),
      }),
    });

    const result = await service.sponsorWaveUnlock(buyerUserId, jobId);

    expect(result.beneficiaryUserId).toBe(priorClaimant);
    expect(result.peaksCharged).toBe(60);
    expect(videoJobModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId,
        claimStatus: 'claimed',
        videoUnlockedForUserId: null,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          videoUnlockedForUserId: priorClaimant,
          videoUnlockedByUserId: buyerUserId,
        }),
      }),
      expect.any(Object),
    );
  });

  it('throws when Peaks balance is insufficient', async () => {
    videoJobModel.findOne.mockReturnValue(leanExec(baseJob));
    userProfileModel.findOneAndUpdate.mockReturnValue(leanExec(null));
    userProfileModel.findOne.mockReturnValue(leanExec({ peaksBalance: 10 }));

    await expect(service.buyAndClaimWave(buyerUserId, jobId)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mongoSession.abortTransaction).toHaveBeenCalled();
  });
});
