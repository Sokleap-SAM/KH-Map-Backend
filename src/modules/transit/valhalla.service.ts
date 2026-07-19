import { Injectable } from '@nestjs/common';
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
        return null;
      }

      const data = (await res.json()) as ValhallaRouteResponse;
      const leg = data.trip?.legs?.[0];
      if (!leg) return null;

      const path = decodePolyline6(leg.shape);
      const distanceMeters = leg.summary.length * 1000;
      const durationSeconds = leg.summary.time;

      return { path, distanceMeters, durationSeconds };
    } catch {
      return null;
    }
  }

  // ─── Single auto (vehicle) route ───────────────────────────────────────────

  /**
   * Returns the road-snapped driving path between two coordinates using the
   * `auto` costing model. Used by admin flows to compute the polyline
   * arriving at each bus stop from the previous one.
   *
   * `vias` are optional intermediate points the path must pass through
   * (Valhalla `through` locations). The admin drops them on the specific
   * road the bus actually takes when the default (fastest) road is wrong —
   * the result stays fully road-snapped either way.
   *
   * The returned shape starts/ends at the ROAD nearest each endpoint; the
   * raw input coordinates (bus stops sit on the sidewalk) are never part
   * of the path.
   *
   * Coords format: [longitude, latitude] (GeoJSON order).
   */
  async getAutoPath(
    from: Coords,
    to: Coords,
    vias: Coords[] = [],
  ): Promise<WalkRouteResult | null> {
    const body = {
      locations: [
        { lon: from[0], lat: from[1], type: 'break' },
        ...vias.map((v) => ({ lon: v[0], lat: v[1], type: 'through' })),
        { lon: to[0], lat: to[1], type: 'break' },
      ],
      costing: 'auto',
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
        return null;
      }

      const data = (await res.json()) as ValhallaRouteResponse;
      const legs = data.trip?.legs;
      if (!legs || legs.length === 0) return null;

      // `through` locations normally keep the trip to a single leg, but be
      // defensive and concatenate if Valhalla splits it. Subsequent legs
      // repeat the previous leg's last vertex as their first — skip it.
      const path: Coords[] = [];
      for (const leg of legs) {
        const decoded = decodePolyline6(leg.shape);
        path.push(...(path.length > 0 ? decoded.slice(1) : decoded));
      }
      if (path.length < 2) return null;

      return {
        path,
        distanceMeters: data.trip.summary.length * 1000,
        durationSeconds: data.trip.summary.time,
      };
    } catch {
      return null;
    }
  }

  // ─── Matrix API: full N×M pedestrian matrix ────────────────────────────────

  /**
   * Full N×M pedestrian matrix — one row per source, one entry per target.
   * Used by the network cache builder to compute footpath walking times
   * between every pair of stops in a single batch.
   *
   * Caller is responsible for chunking very large requests; this method does
   * not split internally.
   */
  async getWalkMatrixFull(
    sources: Coords[],
    targets: Coords[],
  ): Promise<
    Array<Array<{ distanceMeters: number; durationSeconds: number } | null>>
  > {
    if (sources.length === 0 || targets.length === 0) return [];

    const body = {
      sources: sources.map((c) => ({ lon: c[0], lat: c[1] })),
      targets: targets.map((c) => ({ lon: c[0], lat: c[1] })),
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
        // Allow longer than the single-route timeout because matrix payloads
        // grow with sources×targets and Valhalla streams the response in one
        // shot — a too-aggressive timeout kills otherwise-successful batches.
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        return sources.map(() => targets.map(() => null));
      }

      const data = (await res.json()) as ValhallaMatrixResponse;
      return data.sources_to_targets.map((row) =>
        row.map((cell) => {
          if (!cell || cell.time === null || cell.distance === null)
            return null;
          return {
            distanceMeters: cell.distance * 1000,
            durationSeconds: cell.time,
          };
        }),
      );
    } catch {
      return sources.map(() => targets.map(() => null));
    }
  }
}
