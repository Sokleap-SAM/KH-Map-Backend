/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable } from '@nestjs/common';

type Coords = [number, number];

export interface OsrmWalkResult {
  path: Coords[];
  distanceMeters: number;
  durationSeconds: number;
}

@Injectable()
export class OsrmService {
  private readonly baseUrl: string;

  constructor() {
    // FIX: Switched to the official OSRM demo server which properly
    // supports the standard /route/v1/foot/ endpoint format.
    this.baseUrl =
      process.env.OSRM_BASE_URL ?? 'https://router.project-osrm.org';
  }

  async getWalkPath(
    from: Coords,
    to: Coords,
    retries = 2,
  ): Promise<OsrmWalkResult | null> {
    const lon1 = from[0].toFixed(6);
    const lat1 = from[1].toFixed(6);
    const lon2 = to[0].toFixed(6);
    const lat2 = to[1].toFixed(6);

    const url =
      `${this.baseUrl}/route/v1/foot/` +
      `${lon1},${lat1};${lon2},${lat2}` +
      `?geometries=geojson&overview=full`;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });

        if (!res.ok) {
          if (res.status === 429) {
            // 429 Too Many Requests: Wait and retry
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
            continue;
          }
          return null;
        }

        const data: any = await res.json();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const route = data?.routes?.[0];
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (!route?.geometry?.coordinates?.length) return null;

        return {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          path: route.geometry.coordinates as Coords[],
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          distanceMeters: route.distance as number,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          durationSeconds: route.duration as number,
        };
      } catch {
        if (attempt === retries) return null;
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
    return null;
  }
}
