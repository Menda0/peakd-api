/**
 * One-shot migration for the partner-money pivot.
 *
 * Before: partners accrued Peaks into `UserProfile.partnerEarningsPeaks` and
 * `WaveUnlockPurchase` rows only stored `basePeaks`.
 * After:  partners accrue EUR cents into `UserProfile.partnerEarningsCents`
 * and each `WaveUnlockPurchase` row also persists `partnerEarningsCents`.
 *
 * This script:
 *   1. Backfills `WaveUnlockPurchase.partnerEarningsCents` from `basePeaks`
 *      using `PEAKS_PER_EURO` (floor — matches live runtime behaviour).
 *   2. Backfills `UserProfile.partnerEarningsCents` from
 *      `UserProfile.partnerEarningsPeaks`, then unsets the legacy field.
 *
 * Safe to re-run: each step checks for the presence of the new field before
 * writing, and the user-profile step never double-writes (`unset` happens
 * atomically with the conversion).
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

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) {
    throw new Error('MONGODB_URI is not set');
  }
  const peaksPerEuro = parsePositiveInt(process.env.PEAKS_PER_EURO, 100);

  await mongoose.connect(uri);
  const WaveUnlock = mongoose.model(
    WaveUnlockPurchase.name,
    WaveUnlockPurchaseSchema,
  );
  const User = mongoose.model(UserProfile.name, UserProfileSchema);

  // 1) Ledger rows — set partnerEarningsCents from basePeaks where missing.
  const ledgerRows = await WaveUnlock.collection
    .find(
      { partnerEarningsCents: { $exists: false } },
      { projection: { basePeaks: 1 } },
    )
    .toArray();
  let ledgerUpdated = 0;
  for (const row of ledgerRows) {
    const basePeaks = Number(row.basePeaks) || 0;
    const cents = Math.max(0, Math.floor((basePeaks * 100) / peaksPerEuro));
    await WaveUnlock.collection.updateOne(
      { _id: row._id },
      { $set: { partnerEarningsCents: cents } },
    );
    ledgerUpdated += 1;
  }

  // 2) User profiles — convert partnerEarningsPeaks → partnerEarningsCents.
  const usersWithLegacy = await User.collection
    .find(
      { partnerEarningsPeaks: { $gt: 0 } },
      { projection: { userId: 1, partnerEarningsPeaks: 1, partnerEarningsCents: 1 } },
    )
    .toArray();
  let usersUpdated = 0;
  let centsCredited = 0;
  for (const u of usersWithLegacy) {
    const legacyPeaks = Math.max(0, Number(u.partnerEarningsPeaks) || 0);
    if (legacyPeaks <= 0) continue;
    const existingCents = Math.max(0, Number(u.partnerEarningsCents) || 0);
    const addCents = Math.floor((legacyPeaks * 100) / peaksPerEuro);
    await User.collection.updateOne(
      { _id: u._id },
      {
        $set: { partnerEarningsCents: existingCents + addCents },
        $unset: { partnerEarningsPeaks: '' },
      },
    );
    usersUpdated += 1;
    centsCredited += addCents;
  }

  // 3) Sweep any users that still carry the legacy field at 0 — just unset.
  const sweep = await User.collection.updateMany(
    { partnerEarningsPeaks: { $exists: true } },
    { $unset: { partnerEarningsPeaks: '' } },
  );

  console.log(
    [
      `Backfill complete (PEAKS_PER_EURO=${peaksPerEuro}):`,
      `  - ledger rows updated: ${ledgerUpdated}`,
      `  - users converted: ${usersUpdated} (credited ${centsCredited} cents)`,
      `  - users with stale legacy field swept: ${sweep.modifiedCount}`,
    ].join('\n'),
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
