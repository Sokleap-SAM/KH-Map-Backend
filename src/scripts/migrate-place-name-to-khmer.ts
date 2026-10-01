/**
 * One-off data migration: rename the Place `name` field to `nameInKhmer` on
 * every existing document.
 *
 * Renaming the field in the Mongoose schema does NOT rewrite stored documents —
 * MongoDB is schemaless, so old docs keep their `name` key and Mongoose simply
 * reads `nameInKhmer` as `undefined` until this runs. This migration performs
 * the collection-level `$rename`. It is idempotent: once every doc has been
 * renamed, re-running is a no-op.
 *
 *   npm run migrate:place-name              # apply
 *   npm run migrate:place-name -- --dry-run # report only, no writes
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { databaseConfig } from '../config/database.config';
import { DatabaseModule } from '../shared/database/database.module';
import {
  Place,
  PlaceDocument,
  PlaceSchema,
} from '../modules/places/entities/place.schema';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [databaseConfig] }),
    DatabaseModule,
    MongooseModule.forFeature([{ name: Place.name, schema: PlaceSchema }]),
  ],
})
class MigrationModule {}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const app = await NestFactory.createApplicationContext(MigrationModule, {
    logger: ['error', 'warn'],
  });

  try {
    const placeModel = app.get<Model<PlaceDocument>>(getModelToken(Place.name));
    // Use the raw driver collection so the still-untyped `name` key can be
    // referenced (it is no longer a schema path after the rename).
    const coll = placeModel.collection;

    const legacy = await coll.countDocuments({ name: { $exists: true } });
    console.log(`Documents still carrying a legacy 'name' field: ${legacy}`);

    if (dryRun) {
      console.log('[dry-run] no writes performed.');
      return;
    }
    if (legacy === 0) {
      console.log('Nothing to migrate — every document already uses nameInKhmer.');
      return;
    }

    const res = await coll.updateMany(
      { name: { $exists: true } },
      { $rename: { name: 'nameInKhmer' } },
    );
    console.log(
      `Renamed name -> nameInKhmer on ${res.modifiedCount} document(s).`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
