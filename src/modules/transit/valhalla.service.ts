import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Coords } from '../../shared/helpers/helper-functions';

// ─── Response shapes from Valhalla ───────────────────────────────────────────

interface ValhallaRouteResponse {
  trip: {
    legs: Array<{
      shape: string; // encoded polyline (precision 6)
      summary: {
        length: number; // km
        time: number; // seconds
      };
    }>;
    summary: {
      length: number;
      time: number;
    };
    status: number;
    status_message: string;
  };
}

interface ValhallaMatrixResponse {
  sources_to_targets: Array<
    Array<{
      distance: number | null; // km
      time: number | null; // seconds
      to_index: number;
      from_index: number;
    }>
  >;
  units: string;
}

// ─── Public result types ──────────────────────────────────────────────────────

export interface WalkRouteResult {
  path: Coords[];
  distanceMeters: number;
  durationSeconds: number;
}

export interface WalkMatrixEntry {
  fromIndex: number;
  toIndex: number;
  distanceMeters: number;
  durationSeconds: number;
}

// ─── Encoded-polyline decoder (Valhalla uses precision=6) ────────────────────

function decodePolyline6(encoded: string): Coords[] {
  const coords: Coords[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    // Valhalla returns [lat, lng] in the encoded shape.
    // Our Coords type is [lng, lat] (GeoJSON order) — swap here.
    coords.push([lng / 1e6, lat / 1e6]);
  }

  return coords;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class ValhallaService {
  private readonly logger = new Logger(ValhallaService.name);
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    const host = this.configService.get<string>(
      'VALHALLA_HOST',
      'bus_valhalla',
    );
    const port = this.configService.get<number>('VALHALLA_PORT', 8002);
    this.baseUrl = `http://${host}:${port}`;
  }

  // ─── Single walk route ─────────────────────────────────────────────────────

  /**
   * Returns the real pedestrian path between two coordinates.
   * Coords format: [longitude, latitude] (GeoJSON order).
   */
  async getWalkPath(from: Coords, to: Coords): Promise<WalkRouteResult | null> {
    const body = {
      locations: [
        { lon: from[0], lat: from[1], type: 'break' },
        { lon: to[0], lat: to[1], type: 'break' },
      ],
      costing: 'pedestrian',
      costing_options: {
        pedestrian: {
          walking_speed: 4.5, // km/h — matches WALK_SPEED_KMH constant
          use_ferry: 0,
          use_living_streets: 1,
          use_tracks: 0.5,
        },
      },
      units: 'kilometers',
      language: 'en-US',
    };

    try {
      const res = await fetch(`${this.baseUrl}/route`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.logger.warn(
          `[getWalkPath] Valhalla ${res.status}: ${text.slice(0, 120)}`,
        );
        return null;
      }

      const data = (await res.json()) as ValhallaRouteResponse;
      const leg = data.trip?.legs?.[0];
      if (!leg) return null;

      const path = decodePolyline6(leg.shape);
      const distanceMeters = leg.summary.length * 1000;
      const durationSeconds = leg.summary.time;

      return { path, distanceMeters, durationSeconds };
    } catch (err) {
      this.logger.warn(`[getWalkPath] fetch error: ${(err as Error).message}`);
      return null;
    }
  }

  // ─── Matrix API: many origins → one destination ────────────────────────────

  /**
   * Batch pedestrian cost from N origin stops to a single destination.
   * Returns an array in the same order as `origins`.
   * Null entries mean Valhalla could not find a path (e.g. origin unreachable).
   *
   * Use this to pick the best alight stop near the destination, or to rank
   * seed stops near the origin — all in a single HTTP call.
   *
   * Coords format: [longitude, latitude] (GeoJSON order).
   */
  async getWalkMatrix(
    origins: Coords[],
    destinations: Coords[],
  ): Promise<Array<WalkMatrixEntry | null>> {
    if (origins.length === 0 || destinations.length === 0) return [];

    const body = {
      sources: origins.map((c) => ({ lon: c[0], lat: c[1] })),
      targets: destinations.map((c) => ({ lon: c[0], lat: c[1] })),
      costing: 'pedestrian',
      costing_options: {
        pedestrian: {
          walking_speed: 4.5,
          use_ferry: 0,
          use_living_streets: 1,
          use_tracks: 0.5,
        },
      },
      units: 'kilometers',
    };

    try {
      const res = await fetch(`${this.baseUrl}/sources_to_targets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.logger.warn(
          `[getWalkMatrix] Valhalla ${res.status}: ${text.slice(0, 120)}`,
        );
        return origins.map(() => null);
      }

      const data = (await res.json()) as ValhallaMatrixResponse;
      const matrix = data.sources_to_targets;

      // matrix[sourceIndex][targetIndex]
      // We want one result per origin (first target for each source row)
      return matrix.map((row, fromIndex) => {
        const cell = row[0];
        if (!cell || cell.time === null || cell.distance === null) return null;
        return {
          fromIndex,
          toIndex: cell.to_index,
          distanceMeters: cell.distance * 1000,
          durationSeconds: cell.time,
        };
      });
    } catch (err) {
      this.logger.warn(
        `[getWalkMatrix] fetch error: ${(err as Error).message}`,
      );
      return origins.map(() => null);
    }
  }

  // ─── Health check ──────────────────────────────────────────────────────────

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/status`, {
        signal: AbortSignal.timeout(2_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
