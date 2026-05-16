import { config } from 'dotenv';
import { resolve } from 'path';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import inquirer from 'inquirer';
import { Region, RegionSchema } from '../src/studio/schemas/region.schema';
import { Spot, SpotSchema } from '../src/studio/schemas/spot.schema';
import {
  PORTUGAL_COUNTRY_CODE,
  PORTUGAL_REGIONS,
  portugalSeedTotals,
} from './data/portugal-regions-spots';

config({ path: resolve(__dirname, '../.env') });

const DEFAULT_BOOTSTRAP_USER_ID = 'peakd|geo-seed';

type SeedStats = {
  regionsCreated: number;
  regionsUpdated: number;
  spotsCreated: number;
  spotsUpdated: number;
};

function maskMongoUri(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.password) {
      u.password = '****';
    }
    return u.toString();
  } catch {
    return '(invalid URI)';
  }
}

function bootstrapUserId(): string {
  return (
    process.env.SEED_BOOTSTRAP_USER_ID?.trim() || DEFAULT_BOOTSTRAP_USER_ID
  );
}

async function seedPortugal(verified: boolean): Promise<SeedStats> {
  const mongoUri = process.env.MONGODB_URI?.trim();
  if (!mongoUri) {
    throw new Error('MONGODB_URI is not set in peakd-api/.env');
  }

  await mongoose.connect(mongoUri);

  const RegionModel = mongoose.model(Region.name, RegionSchema);
  const SpotModel = mongoose.model(Spot.name, SpotSchema);

  const userId = bootstrapUserId();
  const now = new Date().toISOString();
  const stats: SeedStats = {
    regionsCreated: 0,
    regionsUpdated: 0,
    spotsCreated: 0,
    spotsUpdated: 0,
  };

  try {
    for (const regionSeed of PORTUGAL_REGIONS) {
      let region = await RegionModel.findOne({
        countryCode: PORTUGAL_COUNTRY_CODE,
        name: regionSeed.name,
      }).exec();

      if (!region) {
        const regionId = uuidv4();
        region = await RegionModel.create({
          regionId,
          countryCode: PORTUGAL_COUNTRY_CODE,
          name: regionSeed.name,
          verified,
          disabled: false,
          verifiedAt: verified ? now : null,
          verifierCount: verified ? 1 : 0,
          createdByUserId: userId,
          createdAt: now,
        });
        stats.regionsCreated += 1;
      } else {
        await RegionModel.updateOne(
          { regionId: region.regionId },
          {
            $set: {
              verified,
              verifiedAt: verified ? now : null,
              verifierCount: verified ? Math.max(region.verifierCount ?? 0, 1) : 0,
            },
          },
        ).exec();
        stats.regionsUpdated += 1;
      }

      const regionId = region.regionId;

      for (const spotSeed of regionSeed.spots) {
        const existing = await SpotModel.findOne({
          regionId,
          name: spotSeed.name,
        }).exec();

        const spotFields = {
          level: spotSeed.level,
          breakType: spotSeed.breakType,
          consistency: spotSeed.consistency,
          verified,
          verifiedAt: verified ? now : null,
          verifierCount: verified ? 1 : 0,
        };

        if (!existing) {
          await SpotModel.create({
            spotId: uuidv4(),
            regionId,
            name: spotSeed.name,
            disabled: false,
            ...spotFields,
            createdByUserId: userId,
            createdAt: now,
          });
          stats.spotsCreated += 1;
        } else {
          await SpotModel.updateOne(
            { spotId: existing.spotId },
            { $set: spotFields },
          ).exec();
          stats.spotsUpdated += 1;
        }
      }
    }
  } finally {
    await mongoose.disconnect();
  }

  return stats;
}

function printSummary(stats: SeedStats, verified: boolean): void {
  const { regionCount, spotCount } = portugalSeedTotals();
  console.log('');
  console.log('Portugal geo seed complete.');
  console.log(`  Country: ${PORTUGAL_COUNTRY_CODE}`);
  console.log(`  Verified: ${verified ? 'yes' : 'no'}`);
  console.log(`  Dataset: ${regionCount} regions, ${spotCount} spots`);
  console.log(`  Regions — created: ${stats.regionsCreated}, updated: ${stats.regionsUpdated}`);
  console.log(`  Spots   — created: ${stats.spotsCreated}, updated: ${stats.spotsUpdated}`);
  console.log('');
}

async function runInteractive(): Promise<void> {
  const mongoUri = process.env.MONGODB_URI?.trim();
  const { regionCount, spotCount } = portugalSeedTotals();

  console.log('');
  console.log('Peakd — Portugal regions & spots initializer');
  console.log('(regions = zones, spots = surf breaks in this codebase)');
  console.log('');

  if (!mongoUri) {
    console.error('Error: MONGODB_URI is not set. Add it to peakd-api/.env');
    process.exit(1);
  }

  const answers = await inquirer.prompt<{
    action: 'seed' | 'exit';
    verified: boolean;
    confirm: boolean;
  }>([
    {
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices: [
        {
          name: `Load Portugal data (${regionCount} regions, ${spotCount} spots)`,
          value: 'seed',
        },
        { name: 'Exit', value: 'exit' },
      ],
    },
    {
      type: 'confirm',
      name: 'verified',
      message: 'Mark regions and spots as verified (visible to all users)?',
      default: true,
      when: (a) => a.action === 'seed',
    },
    {
      type: 'confirm',
      name: 'confirm',
      message: () =>
        `Proceed with upsert to ${maskMongoUri(mongoUri)}?`,
      default: false,
      when: (a) => a.action === 'seed',
    },
  ]);

  if (answers.action === 'exit' || !answers.confirm) {
    console.log('Cancelled.');
    return;
  }

  const stats = await seedPortugal(answers.verified);
  printSummary(stats, answers.verified);
}

async function runNonInteractive(): Promise<void> {
  const verified = process.argv.includes('--unverified') ? false : true;
  const stats = await seedPortugal(verified);
  printSummary(stats, verified);
}

async function main(): Promise<void> {
  const nonInteractive =
    process.argv.includes('--yes') || process.argv.includes('-y');

  if (nonInteractive) {
    await runNonInteractive();
    return;
  }

  await runInteractive();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
