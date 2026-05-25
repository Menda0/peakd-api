/**
 * One-shot migration that initialises `partnerEarningsPeaks` for partners who
 * earned Peaks before the dedicated balance existed. Earnings used to flow into
 * `peaksBalance`; we move what's still there into `partnerEarningsPeaks` so
 * partners can withdraw their unspent earnings.
 *
 * Strategy per partner (capped to avoid double-counting):
 *
 *   moved = min(peaksBalance, sum(basePeaks from wave_unlock_purchases))
 *
 * If the partner already spent some earnings on other waves their movable
 * portion shrinks accordingly; nobody ends up with more Peaks than they had.
 */
import { config } from 'dotenv';
import { resolve } from 'path';
import mongoose from 'mongoose';
import {
  WaveUnlockPurchase,
  WaveUnlockPurchaseSchema,
} from '../src/commercial/schemas/wave-unlock-purchase.schema';
import {
  UserProfile,
  UserProfileSchema,
} from '../src/users/schemas/user-profile.schema';

config({ path: resolve(__dirname, '../.env') });

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) {
    throw new Error('MONGODB_URI is not set');
  }

  await mongoose.connect(uri);
  const WaveUnlock = mongoose.model(
    WaveUnlockPurchase.name,
    WaveUnlockPurchaseSchema,
  );
  const User = mongoose.model(UserProfile.name, UserProfileSchema);

  const totals = await WaveUnlock.aggregate<{
    _id: string;
    earnedPeaks: number;
  }>([
    {
      $group: {
        _id: '$partnerUserId',
        earnedPeaks: { $sum: { $ifNull: ['$basePeaks', 0] } },
      },
    },
  ]).exec();

  let moved = 0;
  let touched = 0;

  for (const row of totals) {
    if (!row._id || row.earnedPeaks <= 0) continue;
    const profile = await User.findOne({ userId: row._id })
      .select({ peaksBalance: 1, partnerEarningsPeaks: 1 })
      .lean()
      .exec();
    if (!profile) {
      console.warn(`Skip ${row._id}: no user profile`);
      continue;
    }
    const peaksBalance = Math.max(0, profile.peaksBalance ?? 0);
    const alreadyMoved = Math.max(0, profile.partnerEarningsPeaks ?? 0);
    if (alreadyMoved > 0) {
      // Already migrated.
      continue;
    }
    const movable = Math.min(peaksBalance, row.earnedPeaks);
    if (movable <= 0) continue;
    await User.updateOne(
      { userId: row._id },
      {
        $inc: {
          peaksBalance: -movable,
          partnerEarningsPeaks: movable,
        },
      },
    ).exec();
    moved += movable;
    touched += 1;
  }

  console.log(
    `Backfill complete: moved ${moved} Peaks across ${touched} partners (out of ${totals.length} candidates).`,
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
