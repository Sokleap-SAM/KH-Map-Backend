/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { promises as fs } from 'fs';
import { Model } from 'mongoose';
import { Place, PlaceDocument } from '../places/entities/place.schema';
import {
  PlaceCategory,
  PlaceCategoryDocument,
} from '../places/entities/place-category.schema';
import { BusRoute, BusRouteDocument } from './entities/bus-route.schema';
import {
  BusRouteStop,
  BusRouteStopDocument,
} from './entities/bus-route-stop.schema';

const BUS_STOP_CATEGORY_NAME = 'test_bus_stop';
const DEFAULT_LINES_PATH = 'src/data/bus-line(english long-lat).txt';
const DEFAULT_STOPS_PATH = 'src/data/bus-stop(khmer long-lat).txt';

/** Pattern for cleanup match: starts with "Test" + word boundary. */
const TEST_NAME_PATTERN = /^Test\b/;

export type SeedResult = {
  placesCreated: number;
  placesSkipped: number;
  routesCreated: number;
  routesSkipped: number;
};

export type CleanupResult = {
  dryRun: boolean;
  matchedPlaces: { _id: string; name: string }[];
  matchedRoutes: { _id: string; name: string | null }[];
  deleted: {
    busRouteStops: number;
    places: number;
    busRoutes: number;
  };
};

type LineFeature = {
  geometry: { type: 'MultiLineString'; coordinates: number[][][] };
  properties: { name: string; departure: string; terminal: string };
};

type StopFeature = {
  geometry: { type: 'MultiPoint'; coordinates: [number, number][] };
  properties: { name: string };
};

type FeatureCollection<T> = { features: T[] };

/** UTF-8 Khmer was decoded as Latin-1 upstream; this reverses that. */
function decodeMojibake(s: string): string {
  return Buffer.from(s, 'latin1').toString('utf8');
}

/** "Line 5A" → "5A", "Line 12" → "12" */
function extractCode(lineName: string): string {
  return lineName.replace(/^Line\s+/i, '').trim();
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

@Injectable()
export class TransitSeedService {
  constructor(
    @InjectModel(Place.name)
    private readonly placeModel: Model<PlaceDocument>,
    @InjectModel(PlaceCategory.name)
    private readonly placeCategoryModel: Model<PlaceCategoryDocument>,
    @InjectModel(BusRoute.name)
    private readonly busRouteModel: Model<BusRouteDocument>,
    @InjectModel(BusRouteStop.name)
    private readonly busRouteStopModel: Model<BusRouteStopDocument>,
  ) {}

  /**
   * Seed Places (one per stop) and BusRoutes (one for loops, two for
   * bidirectional lines) from the GeoJSON files in src/data/.
   * Idempotent — re-running skips docs that already exist.
   */
  async seedAll(
    opts: {
      linesPath?: string;
      stopsPath?: string;
    } = {},
  ): Promise<SeedResult> {
    const linesPath = opts.linesPath ?? DEFAULT_LINES_PATH;
    const stopsPath = opts.stopsPath ?? DEFAULT_STOPS_PATH;

    const [linesRawBuffer, stopsRawBuffer] = await Promise.all([
      fs.readFile(linesPath),
      fs.readFile(stopsPath),
    ]);

    const linesRaw = linesRawBuffer.toString('latin1');
    const stopsRaw = stopsRawBuffer.toString('latin1');
    const lines: FeatureCollection<LineFeature> = JSON.parse(linesRaw);
    const stops: FeatureCollection<StopFeature> = JSON.parse(stopsRaw);

    // 1. Ensure "Bus Stop" category exists.
    let busStopCategory = await this.placeCategoryModel
      .findOne({ name: BUS_STOP_CATEGORY_NAME })
      .exec();
    if (!busStopCategory) {
      busStopCategory = await this.placeCategoryModel.create({
        name: BUS_STOP_CATEGORY_NAME,
      });
    }

    // 2. Places.
    let placesCreated = 0;
    let placesSkipped = 0;
    for (const feature of stops.features) {
      const coords = feature.geometry.coordinates[0];
      if (!coords) continue;
      const [lng, lat] = coords;
      const name = decodeMojibake(feature.properties.name);

      const existing = await this.placeModel
        .findOne({
          name,
          category: busStopCategory._id,
          'location.coordinates': [lng, lat],
        })
        .exec();
      if (existing) {
        placesSkipped++;
        continue;
      }

      await this.placeModel.create({
        name,
        category: busStopCategory._id,
        location: { type: 'Point', coordinates: [lng, lat] },
      });
      placesCreated++;
    }
    // 3. BusRoutes.
    let routesCreated = 0;
    let routesSkipped = 0;
    for (const feature of lines.features) {
      const lineName = feature.properties.name;
      const code = extractCode(lineName);
      const isLine =
        feature.properties.departure === feature.properties.terminal;

      const directions: (null | 'outbound' | 'inbound')[] = isLine
        ? [null]
        : ['outbound', 'inbound'];

      for (const direction of directions) {
        const existing = await this.busRouteModel
          .findOne({ code, direction })
          .exec();
        if (existing) {
          routesSkipped++;
          continue;
        }

        const routeName = direction
          ? `${lineName} ${capitalize(direction)}`
          : lineName;

        await this.busRouteModel.create({
          code,
          name: routeName,
          isLine,
          direction,
          status: 'active',
        });
        routesCreated++;
      }
    }

    return { placesCreated, placesSkipped, routesCreated, routesSkipped };
  }

  /**
   * Delete Places + BusRoutes whose `name` starts with "Test" (case-sensitive,
   * word-bounded — "Test Place A" yes, "Testing" no). Cascade-removes any
   * BusRouteStop rows that reference the deleted Places or Routes.
   *
   * `dryRun: true` returns matches without deleting.
   */
  async cleanupTestData(
    opts: { dryRun?: boolean } = {},
  ): Promise<CleanupResult> {
    const dryRun = opts.dryRun ?? false;

    const testPlaces = await this.placeModel
      .find({ name: TEST_NAME_PATTERN })
      .select('_id name')
      .exec();
    const testRoutes = await this.busRouteModel
      .find({ name: TEST_NAME_PATTERN })
      .select('_id name')
      .exec();

    const matchedPlaces = testPlaces.map((p) => ({
      _id: p._id.toString(),
      name: p.name,
    }));
    const matchedRoutes = testRoutes.map((r) => ({
      _id: r._id.toString(),
      name: r.name ?? null,
    }));

    if (dryRun) {
      return {
        dryRun: true,
        matchedPlaces,
        matchedRoutes,
        deleted: { busRouteStops: 0, places: 0, busRoutes: 0 },
      };
    }

    if (testPlaces.length === 0 && testRoutes.length === 0) {
      return {
        dryRun: false,
        matchedPlaces,
        matchedRoutes,
        deleted: { busRouteStops: 0, places: 0, busRoutes: 0 },
      };
    }

    const testPlaceIds = testPlaces.map((p) => p._id);
    const testRouteIds = testRoutes.map((r) => r._id);

    // Cascade first — BusRouteStop is a link table with no canonical data.
    const stopResult = await this.busRouteStopModel
      .deleteMany({
        $or: [
          { stop: { $in: testPlaceIds } },
          { route: { $in: testRouteIds } },
        ],
      })
      .exec();
    const placeResult = await this.placeModel
      .deleteMany({ _id: { $in: testPlaceIds } })
      .exec();
    const routeResult = await this.busRouteModel
      .deleteMany({ _id: { $in: testRouteIds } })
      .exec();

    return {
      dryRun: false,
      matchedPlaces,
      matchedRoutes,
      deleted: {
        busRouteStops: stopResult.deletedCount ?? 0,
        places: placeResult.deletedCount ?? 0,
        busRoutes: routeResult.deletedCount ?? 0,
      },
    };
  }
}
