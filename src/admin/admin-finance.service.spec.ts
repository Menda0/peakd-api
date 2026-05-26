import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { BILLING_CONFIG_KEY } from '../config/billing.config';
import { PeakPurchase } from '../billing/schemas/peak-purchase.schema';
import { WaveUnlockPurchase } from '../commercial/schemas/wave-unlock-purchase.schema';
import { PartnerWithdrawal } from '../payouts/schemas/partner-withdrawal.schema';
import { UserProfile } from '../users/schemas/user-profile.schema';
import { AdminFinanceService } from './admin-finance.service';

/**
 * AdminFinanceService aggregates from four collections and a live Stripe
 * balance call. These tests pin the snapshot shape (so the FE can't silently
 * drift) and exercise the failure path where Stripe is unreachable.
 */
describe('AdminFinanceService', () => {
  let service: AdminFinanceService;
  let stripeStub: { balance: { retrieve: jest.Mock } };

  function execMock<T>(value: T) {
    return { exec: () => Promise.resolve(value) };
  }

  beforeEach(async () => {
    const peakPurchaseModel = {
      aggregate: jest.fn().mockReturnValue(
        execMock([
          {
            totalRevenueCents: 11_000,
            totalStripeFeesCents: 420,
            totalPurchases: 10,
            purchasesWithFeeData: 8,
          },
        ]),
      ),
    };
    const userProfileModel = {
      aggregate: jest.fn().mockReturnValue(execMock([{ total: 5_000 }])),
    };
    const partnerWithdrawalModel = {
      aggregate: jest.fn().mockReturnValue(execMock([{ total: 3_000 }])),
    };
    const waveUnlockPurchaseModel = {
      aggregate: jest
        .fn()
        .mockReturnValue(execMock([{ totalRetentionPeaks: 240 }])),
    };
    const configService = {
      get: jest.fn((key: string) =>
        key === BILLING_CONFIG_KEY
          ? { peaksPerEuro: 100, stripeSecretKey: 'sk_test_dummy' }
          : undefined,
      ),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminFinanceService,
        {
          provide: getModelToken(WaveUnlockPurchase.name),
          useValue: waveUnlockPurchaseModel,
        },
        {
          provide: getModelToken(PeakPurchase.name),
          useValue: peakPurchaseModel,
        },
        {
          provide: getModelToken(PartnerWithdrawal.name),
          useValue: partnerWithdrawalModel,
        },
        { provide: getModelToken(UserProfile.name), useValue: userProfileModel },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = moduleRef.get(AdminFinanceService);
    stripeStub = { balance: { retrieve: jest.fn() } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).stripeClient = stripeStub;
  });

  it('returns a complete snapshot with all derived figures', async () => {
    stripeStub.balance.retrieve.mockResolvedValue({
      available: [{ currency: 'eur', amount: 8_000 }],
      pending: [{ currency: 'eur', amount: 2_500 }],
    });

    const overview = await service.getOverview();

    expect(overview.peaksPerEuro).toBe(100);
    expect(overview.stripe).toEqual({
      availableEurCents: 8_000,
      pendingEurCents: 2_500,
      nonEurCurrencies: [],
      error: null,
    });
    expect(overview.ledger).toMatchObject({
      totalRevenueCents: 11_000,
      totalStripeFeesCents: 420,
      totalPurchases: 10,
      purchasesWithFeeData: 8,
      totalPartnerLiabilityCents: 5_000,
      totalPartnerPaidOutCents: 3_000,
      totalPlatformRetentionPeaks: 240,
      // 240 Peaks * 100 cents / 100 peaksPerEuro = 240 cents (= €2.40)
      totalPlatformRetentionEurCents: 240,
    });
    // 11000 − 420 (stripe fees) − 3000 (paid out) − 5000 (liability) = 2580
    expect(overview.derived.netPlatformMarginCents).toBe(2_580);
    // 8000 (avail) − 5000 (liability) = 3000 → positive, healthy
    expect(overview.derived.liabilityVsBalanceDeltaCents).toBe(3_000);
  });

  it('flags non-EUR currencies on the stripe balance', async () => {
    stripeStub.balance.retrieve.mockResolvedValue({
      available: [
        { currency: 'eur', amount: 8_000 },
        { currency: 'usd', amount: 1_500 },
      ],
      pending: [],
    });

    const overview = await service.getOverview();
    expect(overview.stripe.nonEurCurrencies).toEqual(['usd']);
  });

  it('falls back to zeros + error string when Stripe is unreachable', async () => {
    stripeStub.balance.retrieve.mockRejectedValue(new Error('boom'));

    const overview = await service.getOverview();
    expect(overview.stripe.availableEurCents).toBe(0);
    expect(overview.stripe.pendingEurCents).toBe(0);
    expect(overview.stripe.error).toBe('boom');
    // Liability vs balance is computed against 0 — so it's negative when any
    // partner is owed money. That's the worst case (and the UI shows a red
    // banner) which is the right default when we have no balance signal.
    expect(overview.derived.liabilityVsBalanceDeltaCents).toBe(-5_000);
  });

  it('caches the Stripe balance for 60 seconds', async () => {
    stripeStub.balance.retrieve.mockResolvedValue({
      available: [{ currency: 'eur', amount: 1_000 }],
      pending: [],
    });
    await service.getOverview();
    await service.getOverview();
    expect(stripeStub.balance.retrieve).toHaveBeenCalledTimes(1);
  });
});
