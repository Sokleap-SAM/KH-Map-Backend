import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { TestOdcStop } from './entities/test-stop.schema';

interface TargetRecord {
  nameKhmer: string;
  location: {
    type: string;
    coordinates: number[];
  };
  lineName: string;
}

@Injectable()
export class TestImportService implements OnApplicationBootstrap {
  constructor(
    @InjectModel(TestOdcStop.name)
    private readonly testStopModel: Model<TestOdcStop>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.importOdcCsvDataset();
  }

  // Highly accurate conversion formula for UTM Zone 48N (Cambodia) to WGS84 Lat/Lng
  private utm48NToLatLng(
    easting: number,
    northing: number,
  ): { lat: number; lng: number } {
    const sa = 6378137.0;
    const sb = 6356752.314245;
    const e2 = (sa * sa - sb * sb) / (sa * sa);
    const e2cuatro = e2 * e2;
    const e2seis = e2cuatro * e2;
    const ee = e2 / (1 - e2);

    const utmEasting = easting - 500000.0;
    const utmNorthing = northing;

    const m = utmNorthing / 0.9996;
    const mu =
      m / (sa * (1 - e2 / 4 - (3 * e2cuatro) / 64 - (5 * e2seis) / 256));

    const phi1 =
      mu +
      ((3 * e2) / 8 - (27 * e2cuatro) / 32) * Math.sin(2 * mu) +
      +((21 * e2cuatro) / 16 - (55 * e2seis) / 32) * Math.sin(4 * mu) +
      +((151 * e2seis) / 96) * Math.sin(6 * mu);

    const c1 = ee * Math.cos(phi1) * Math.cos(phi1);
    const t1 = Math.tan(phi1) * Math.tan(phi1);
    const n1 = sa / Math.sqrt(1 - e2 * Math.sin(phi1) * Math.sin(phi1));
    const r1 =
      (sa * (1 - e2)) / Math.pow(1 - e2 * Math.sin(phi1) * Math.sin(phi1), 1.5);
    const d = utmEasting / (n1 * 0.9996);

    let lat =
      phi1 -
      ((n1 * Math.tan(phi1)) / r1) *
        (Math.pow(d, 2) / 2 -
          ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ee) * Math.pow(d, 4)) /
            24 +
          ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ee - 3 * c1 * c1) *
            Math.pow(d, 6)) /
            720);

    let lng =
      (d -
        ((1 + 2 * t1 + c1) * Math.pow(d, 3)) / 6 +
        ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ee + 24 * t1 * t1) *
          Math.pow(d, 5)) /
          120) /
      Math.cos(phi1);

    lat = lat * (180 / Math.PI);
    lng = lng * (180 / Math.PI) + 105.0; // Central Meridian for Zone 48

    return { lat, lng };
  }

  async importOdcCsvDataset(): Promise<void> {
    try {
      const dynamicCount = await this.testStopModel.countDocuments();
      if (dynamicCount > 0) {
        console.log(
          `[Test Seeder] Collection contains ${dynamicCount} items. Skipping import.`,
        );
        return;
      }

      const csvFilePath = path.join(
        process.cwd(),
        'src/modules/transit/data/odc-bus-stops.csv',
      );

      if (!fs.existsSync(csvFilePath)) {
        console.error(`[Test Seeder] Target file not found at: ${csvFilePath}`);
        return;
      }

      console.log(
        `[Test Seeder] Processing native line-by-line read for: ${csvFilePath}`,
      );

      const fileStream = fs.createReadStream(csvFilePath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      let isFirstLine = true;
      let headers: string[] = [];
      const recordsToInsert: TargetRecord[] = [];

      for await (const line of rl) {
        const rowValues = line.split(',').map((val) => val.trim());

        if (isFirstLine) {
          headers = rowValues;
          console.log('[Test Seeder] Raw CSV headers detected:', headers);
          isFirstLine = false;
          continue;
        }

        if (rowValues.length >= headers.length) {
          const rowData: Record<string, string> = {};
          headers.forEach((header, index) => {
            rowData[header] = rowValues[index] ?? '';
          });

          const name = rowData.name ?? rowValues[4] ?? 'Unknown Stop';
          const lineName = rowData.reference ?? rowValues[5] ?? 'Line Unknown';
          const geomHex =
            rowData.the_geom ?? rowValues[rowValues.length - 1] ?? '';

          // MultiPoint EWKB string starts coordinate positions at index 36
          if (geomHex.length >= 68) {
            try {
              const eastingHex = geomHex.substring(36, 52);
              const northingHex = geomHex.substring(52, 68);

              const eastingBuf = Buffer.from(eastingHex, 'hex');
              const northingBuf = Buffer.from(northingHex, 'hex');

              const eastingMeters = eastingBuf.readDoubleLE(0);
              const northingMeters = northingBuf.readDoubleLE(0);

              // Convert the UTM meters to decimal Lat/Lng degrees
              const { lat, lng } = this.utm48NToLatLng(
                eastingMeters,
                northingMeters,
              );

              // Validate that coordinates successfully targeted inside Cambodia boundaries
              if (lng > 102 && lng < 108 && lat > 9 && lat < 15) {
                recordsToInsert.push({
                  nameKhmer: name,
                  location: {
                    type: 'Point',
                    coordinates: [lng, lat], // GeoJSON order requirement: [Longitude, Latitude]
                  },
                  lineName,
                });
              }
            } catch (hexErr) {
              console.error(
                '[Test Seeder] Error occurred while parsing hex values:',
                hexErr,
              );
              continue;
            }
          }
        }
      }

      if (recordsToInsert.length > 0) {
        console.log(
          `[Test Seeder] Writing ${recordsToInsert.length} documents to test_odc_stops...`,
        );
        await this.testStopModel.insertMany(recordsToInsert);
        console.log(
          '🎉 SUCCESS! All EWKB points converted to Lat/Lng and stored successfully.',
        );
      } else {
        console.warn(
          '[Test Seeder] Processing complete but 0 records matched binary parsing validations.',
        );
      }
    } catch (err) {
      if (err instanceof Error) {
        console.error(
          '[Test Seeder] Native parser runtime execution error:',
          err.message,
        );
      }
    }
  }
}
