/**
 * One-shot wipe of legacy "Peaks" virtual currency artefacts.
 *
 * The product no longer uses an in-app currency: partners price waves in
 * their preferred ISO 4217 currency (`commercialSettings.currency` +
 * `videoPriceMinor`) and the platform charges a fixed commission on top via
 * Stripe Checkout. This script removes everything that referenced the old
 * Peaks model so we start from a clean slate:
 *
 *   1. Drops collections (`peak_purchases`, `wave_unlock_purchases`,
 *      `partner_withdrawals`).
 *   2. Unsets the legacy fields on `user_profiles`:
 *        - `peaksBalance`
 *        - `partnerEarningsCents`
 *        - `partnerEarningsPeaks` (older alpha)
 *   3. Unsets the legacy `videoPricePeaks` field on every
 *      `commercialSettings` embed in `partner_profiles` and `surf_sessions`.
 *
 * Pass `--dry-run` to log counts without writing. Idempotent — safe to re-run
 * after the migration completes.
 */
import { config } from 'dotenv';
import { resolve } from 'path';
import mongoose from 'mongoose';

config({ path: resolve(__dirname, '../.env') });

type RunOpts = { dryRun: boolean };

async function main(): Promise<void> {
  const opts: RunOpts = { dryRun: process.argv.includes('--dry-run') };
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) {
    throw new Error('MONGODB_URI is not set');
  }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('Mongo connection did not expose `.db`');
  }

  const collectionsToDrop = [
    'peak_purchases',
    'wave_unlock_purchases',
    'partner_withdrawals',
  ];
  const existing = (await db.listCollections().toArray()).map((c) => c.name);
  for (const name of collectionsToDrop) {
    if (!existing.includes(name)) {
      console.log(`[wipe-peaks] skip drop: ${name} not present`);
      continue;
    }
    if (opts.dryRun) {
      const count = await db.collection(name).countDocuments();
      console.log(`[wipe-peaks] (dry-run) would drop ${name} (${count} docs)`);
      continue;
    }
    await db.collection(name).drop();
    console.log(`[wipe-peaks] dropped collection ${name}`);
  }

  const userProfiles = db.collection('user_profiles');
  const unsetUserFields = {
    peaksBalance: '',
    partnerEarningsCents: '',
    partnerEarningsPeaks: '',
  };
  if (opts.dryRun) {
    const affected = await userProfiles.countDocuments({
      $or: Object.keys(unsetUserFields).map((k) => ({
        [k]: { $exists: true },
      })),
    });
    console.log(
      `[wipe-peaks] (dry-run) would unset legacy peaks fields on ${affected} user_profiles`,
    );
  } else {
    const res = await userProfiles.updateMany(
      {
        $or: Object.keys(unsetUserFields).map((k) => ({
          [k]: { $exists: true },
        })),
      },
      { $unset: unsetUserFields },
    );
    console.log(
      `[wipe-peaks] unset legacy peaks fields on ${res.modifiedCount} user_profiles`,
    );
  }

  // `commercialSettings` is embedded on both partner_profiles and
  // surf_sessions (where it can override the partner default). Drop the
  // legacy `videoPricePeaks` slot from both.
  for (const collName of ['partner_profiles', 'surf_sessions']) {
    if (!existing.includes(collName)) continue;
    const coll = db.collection(collName);
    if (opts.dryRun) {
      const affected = await coll.countDocuments({
        'commercialSettings.videoPricePeaks': { $exists: true },
      });
      console.log(
        `[wipe-peaks] (dry-run) would unset commercialSettings.videoPricePeaks on ${affected} ${collName}`,
      );
      continue;
    }
    const res = await coll.updateMany(
      { 'commercialSettings.videoPricePeaks': { $exists: true } },
      { $unset: { 'commercialSettings.videoPricePeaks': '' } },
    );
    console.log(
      `[wipe-peaks] unset commercialSettings.videoPricePeaks on ${res.modifiedCount} ${collName}`,
    );
  }
}

main()
  .then(() => mongoose.disconnect())
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('[wipe-peaks] failed:', err);
    void mongoose.disconnect().finally(() => process.exit(1));
  });
