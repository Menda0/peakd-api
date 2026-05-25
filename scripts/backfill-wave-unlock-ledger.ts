import { config } from 'dotenv';
import { resolve } from 'path';
import mongoose from 'mongoose';
import { computeCheckoutTotal } from '../src/commercial/commercial-pricing';
import { SurfSession, SurfSessionSchema } from '../src/studio/schemas/surf-session.schema';
import {
  WaveUnlockPurchase,
  WaveUnlockPurchaseSchema,
} from '../src/commercial/schemas/wave-unlock-purchase.schema';

config({ path: resolve(__dirname, '../.env') });

function inferBreakdown(totalPeaks: number): {
  basePeaks: number;
  communityFeePeaks: number;
} {
  const total = Math.max(0, Math.round(totalPeaks));
  for (let base = total; base >= 0; base -= 1) {
    const checkout = computeCheckoutTotal(base);
    if (checkout.totalPeaks === total) {
      return {
        basePeaks: checkout.basePeaks,
        communityFeePeaks: checkout.communityFeePeaks,
      };
    }
  }
  const communityFeePeaks = Math.max(1, Math.round((total * 20) / 120));
  return {
    basePeaks: Math.max(0, total - communityFeePeaks),
    communityFeePeaks,
  };
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) {
    throw new Error('MONGODB_URI is not set');
  }

  await mongoose.connect(uri);
  const WaveUnlock = mongoose.model(WaveUnlockPurchase.name, WaveUnlockPurchaseSchema);
  const SurfSessionModel = mongoose.model(SurfSession.name, SurfSessionSchema);

  const missing = await WaveUnlock.find({
    $or: [
      { partnerUserId: { $exists: false } },
      { basePeaks: { $exists: false } },
      { communityFeePeaks: { $exists: false } },
      { countryCode: { $exists: false } },
      { regionId: { $exists: false } },
    ],
  })
    .lean()
    .exec();

  let updated = 0;
  let skipped = 0;

  for (const row of missing) {
    const session = await SurfSessionModel.findOne({ sessionId: row.sessionId })
      .lean()
      .exec();
    if (!session) {
      skipped += 1;
      console.warn(`Skip ${row._id}: session ${row.sessionId} not found`);
      continue;
    }

    const { basePeaks, communityFeePeaks } = inferBreakdown(row.peaksCharged ?? 0);
    await WaveUnlock.updateOne(
      { _id: row._id },
      {
        $set: {
          partnerUserId: session.userId,
          basePeaks,
          communityFeePeaks,
          countryCode: session.countryCode,
          regionId: session.regionId,
        },
      },
    ).exec();
    updated += 1;
  }

  console.log(`Backfill complete: ${updated} updated, ${skipped} skipped (${missing.length} candidates).`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
