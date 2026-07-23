/**
 * Backfill Place `nameInLatin` for bus stops by matching EXACT coordinates
 * against the Latin-name GeoJSON export in
 * `src/data/bus-stop-english(long-lat).txt`.
 *
 * The bus stops in the DB (category `test_bus_stop`) were seeded from the
 * Khmer export, which shares byte-identical coordinates with the English
 * export (same GIS features, different name attribute). A stop is matched to a
 * feature ONLY when their [lng, lat] are exactly equal — no proximity, no
 * tolerance. A stop whose coordinate has no identical English feature is left
 * untouched and reported.
 *
 *   npm run backfill:place-name-latin              # apply
 *   npm run backfill:place-name-latin -- --dry-run # report only, no writes
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Model, Types } from 'mongoose';
import { databaseConfig } from '../config/database.config';
import { DatabaseModule } from '../shared/database/database.module';
import {
  Place,
  PlaceDocument,
  PlaceSchema,
} from '../modules/places/entities/place.schema';
import {
  PlaceCategory,
  PlaceCategoryDocument,
  PlaceCategorySchema,
} from '../modules/places/entities/place-category.schema';

const STOP_CATEGORY_NAME = 'test_bus_stop';
const ENGLISH_FILE = 'src/data/bus-stop-english(long-lat).txt';

type Coords = [number, number];

type EnglishFeature = {
  geometry?: { type: 'MultiPoint'; coordinates: Coords[] };
  properties?: { name?: string };
};
type FeatureCollection = { features: EnglishFeature[] };

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [databaseConfig] }),
    DatabaseModule,
    MongooseModule.forFeature([
      { name: Place.name, schema: PlaceSchema },
      { name: PlaceCategory.name, schema: PlaceCategorySchema },
    ]),
  ],
})
class BackfillModule {}

/**
 * Exact-match key for a coordinate. Both the DB value and the file value are
 * the same JSON double parsed by V8, so their default string form is identical
 * — this keys on true equality, not rounded proximity.
 */
function coordKey(coords: Coords): string {
  return `${coords[0]},${coords[1]}`;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  const app = await NestFactory.createApplicationContext(BackfillModule, {
    logger: ['error', 'warn'],
  });

  try {
    const placeModel = app.get<Model<PlaceDocument>>(getModelToken(Place.name));
    const categoryModel = app.get<Model<PlaceCategoryDocument>>(
      getModelToken(PlaceCategory.name),
    );

    // 1. Resolve the bus-stop category.
    const category = await categoryModel
      .findOne({ name: STOP_CATEGORY_NAME })
      .lean()
      .exec();
    if (!category) {
      console.error(
        `Category "${STOP_CATEGORY_NAME}" not found — nothing to backfill.`,
      );
      return;
    }

    // 2. Load bus-stop places.
    const stops = await placeModel
      .find({ category: category._id })
      .select('_id nameInKhmer nameInLatin location')
      .lean()
      .exec();
    console.log(
      `Bus-stop places (category ${STOP_CATEGORY_NAME}): ${stops.length}`,
    );

    // 3. Load the English GeoJSON and index it by EXACT coordinate.
    const filePath = path.resolve(process.cwd(), ENGLISH_FILE);
    const fc = JSON.parse(
      await fs.readFile(filePath, 'utf8'),
    ) as FeatureCollection;

    const nameByCoord = new Map<string, string>();
    let fileFeatures = 0;
    let coordCollisions = 0;
    for (const f of fc.features) {
      const coords = f.geometry?.coordinates?.[0];
      const name = f.properties?.name?.trim();
      if (!coords || !name) continue;
      fileFeatures++;
      const key = coordKey(coords);
      const existing = nameByCoord.get(key);
      if (existing !== undefined) {
        // Same exact coordinate appears twice in the file. Keep the first;
        // only flag it when the two names actually differ (real ambiguity).
        if (existing !== name) coordCollisions++;
        continue;
      }
      nameByCoord.set(key, name);
    }
    console.log(
      `English features with name + coords: ${fileFeatures} ` +
        `(${nameByCoord.size} unique coordinates)`,
    );
    if (coordCollisions) {
      console.log(
        `  note: ${coordCollisions} coordinate(s) had two differing names — kept the first`,
      );
    }

    // 4. Match each stop by EXACT coordinate equality.
    let matched = 0;
    let unchanged = 0;
    const toUpdate: { id: Types.ObjectId; nameInLatin: string }[] = [];
    const unmatched: {
      id: string;
      nameInKhmer: string;
      coords: Coords | null;
    }[] = [];

    for (const stop of stops) {
      const coords = stop.location?.coordinates as Coords | undefined;
      const englishName = coords ? nameByCoord.get(coordKey(coords)) : undefined;

      if (englishName !== undefined) {
        matched++;
        if (stop.nameInLatin === englishName) {
          unchanged++; // already correct — nothing to write
        } else {
          toUpdate.push({ id: stop._id, nameInLatin: englishName });
        }
      } else {
        unmatched.push({
          id: String(stop._id),
          nameInKhmer: stop.nameInKhmer,
          coords: coords ?? null,
        });
      }
    }

    console.log(`\nExact coordinate matches: ${matched}`);
    console.log(`  already correct: ${unchanged}`);
    console.log(`  to update:       ${toUpdate.length}`);
    console.log(`Unmatched stops:   ${unmatched.length}`);
    if (unmatched.length) {
      console.log('  (no English feature at the exact same coordinate)');
      for (const u of unmatched.slice(0, 20)) {
        const at = u.coords ? `[${u.coords[0]}, ${u.coords[1]}]` : '(no location)';
        console.log(`   - ${u.nameInKhmer} [${u.id}] at ${at}`);
      }
      if (unmatched.length > 20) {
        console.log(`   … and ${unmatched.length - 20} more`);
      }
    }

    if (dryRun) {
      console.log('\n[dry-run] no writes performed.');
      return;
    }

    let updated = 0;
    for (const op of toUpdate) {
      await placeModel
        .updateOne({ _id: op.id }, { $set: { nameInLatin: op.nameInLatin } })
        .exec();
      updated++;
    }
    console.log(`\nUpdated nameInLatin on ${updated} stop(s).`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
