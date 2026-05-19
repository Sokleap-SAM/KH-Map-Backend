/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/restrict-template-expressions */
/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BusRouteStop } from './entities/bus-route-stop.schema';
import { BusLocationService } from './bus-location.service';
import {
  WALK_SPEED_KMH,
  BUS_ROUTING_SPEED_KMH,
  TRANSFER_WALK_BASE_RADIUS_M,
  TRANSFER_WALK_RADIUS_GROWTH_PER_ROUND_M,
  TRANSFER_WALK_MAX_RADIUS_M,
  TRANSFER_PENALTY_MIN,
  MIN_WAIT_MIN,
  NETWORK_CACHE_TTL_MS,
  ORIGIN_RADII_M,
  RAPTOR_MAX_ROUNDS,
  TRANSFER_PENALTY_FOR_RANKING,
  LONG_WALK_WARNING_M,
  TOP_TRANSIT_OPTIONS,
} from '../../shared/constants/constants';
import {
  Coords,
  haversineMeters,
  walkMinutes,
  pointToSegmentDistance,
} from '../../shared/helpers/helper-functions';
import { ValhallaService } from './valhalla.service';

// ─── Types ───────────────────────────────────────────────────────────────────

interface StopInfo {
  coordinates: Coords;
  name: string;
}

interface RouteInfo {
  code?: string | null;
  name?: string | null;
  headwayMinutes?: number | null;
  isLine?: boolean | null;
}

interface RouteStop {
  stopId: string;
  stopOrder: number;
  coordinates: Coords;
  distanceFromPrevious?: number | null;
  roadDistanceFromPrevious?: number | null;
  segmentPathCoords: [number, number][] | null;
}

interface BoardEdge {
  type: 'board';
  to: string;
  routeId: string;
  boardingStopId: string;
  busEtas: number[];
  headwayMinutes: number | null;
  hasLiveEta: boolean;
}

type RawOption = {
  totalEstimatedMinutes: number;
  totalDistanceMeters: number;
  totalWalkMeters: number;
  transferCount: number;
  segments: any[];
  fingerprint: string;
  warning?: string;
};

interface Footpath {
  toStopId: string;
  walkMinutes: number;
  distMeters: number;
}

type JourneyLabel =
  | {
      type: 'transit';
      routeId: string;
      boardedAtStopId: string;
      boardTime: number;
      fromStopId: string;
      hasLiveEta: boolean;
    }
  | {
      type: 'walk';
      fromStopId: string;
      distMeters: number;
    };

type TransitPositionMeta = {
  type: 'fastest' | 'fast' | 'average' | 'slower' | 'slowest';
  label: 'Fastest' | 'Fast' | 'Average' | 'Slower' | 'Slowest';
};

// ─── Module-level helpers ─────────────────────────────────────────────────────

function onbusNodeId(routeId: string, stopId: string): string {
  return `onbus:${routeId}:${stopId}`;
}

function bestDistMeters(stop: RouteStop, prev: RouteStop): number {
  if (stop.distanceFromPrevious != null && stop.distanceFromPrevious > 0)
    return stop.distanceFromPrevious;
  if (
    stop.roadDistanceFromPrevious != null &&
    stop.roadDistanceFromPrevious > 0
  )
    return stop.roadDistanceFromPrevious;
  return haversineMeters(prev.coordinates, stop.coordinates);
}

function segTime(stop: RouteStop, prev: RouteStop): number {
  return (bestDistMeters(stop, prev) / 1000 / BUS_ROUTING_SPEED_KMH) * 60;
}

function sumSegmentPathDistance(coords: [number, number][]): number {
  let total = 0;
  for (let k = 1; k < coords.length; k++) {
    total += haversineMeters(coords[k - 1] as Coords, coords[k] as Coords);
  }
  return total;
}

function transferRadiusForRound(round: number): number {
  const radius =
    TRANSFER_WALK_BASE_RADIUS_M +
    (round - 1) * TRANSFER_WALK_RADIUS_GROWTH_PER_ROUND_M;
  return Math.min(TRANSFER_WALK_MAX_RADIUS_M, radius);
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class TransitRoutingService {
  private readonly logger = new Logger(TransitRoutingService.name);

  private networkCache: {
    stopInfoMap: Map<string, StopInfo>;
    routeInfoMap: Map<string, RouteInfo>;
    routeStopsMap: Map<string, RouteStop[]>;
    stopRoutes: Map<string, string[]>;
    footpaths: Map<string, Footpath[]>;
    validStopsCount: number;
    builtAt: number;
  } | null = null;

  constructor(
    @InjectModel(BusRouteStop.name)
    private readonly busRouteStopModel: Model<BusRouteStop>,
    private readonly busLocationService: BusLocationService,
    private readonly valhallaService: ValhallaService,
  ) {}

  invalidateNetworkCache(): void {
    this.networkCache = null;
  }

  // FIX #1: Coordinate Order Verification
  // Valhalla requires [longitude, latitude]. If values exceed normal ranges, log an error.
  private assertCoords(c: Coords, label: string) {
    if (Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90) {
      this.logger.error(
        `${label}: suspicious coords [${c}] — may be lat/lng swapped. Valhalla expects [longitude, latitude].`,
      );
    }
  }

  private async getNetwork() {
    const now = Date.now();
    if (
      this.networkCache &&
      now - this.networkCache.builtAt < NETWORK_CACHE_TTL_MS
    ) {
      return this.networkCache;
    }

    const { stopInfoMap, routeInfoMap, routeStopsMap, validStopsCount } =
      await this.loadStopData();
    const { stopRoutes } = this.buildStopRouteIndex(routeStopsMap);
    const footpaths = this.buildFootpaths(stopInfoMap, stopRoutes);

    this.networkCache = {
      stopInfoMap,
      routeInfoMap,
      routeStopsMap,
      stopRoutes,
      footpaths,
      validStopsCount,
      builtAt: now,
    };

    return this.networkCache;
  }

  // ─── ETA Computation ──────────────────────────────────────────────────────

  private async computeLiveEtaMap(
    routeStopsMap: Map<string, RouteStop[]>,
  ): Promise<Map<string, Map<string, number[]>>> {
    const etaMap = new Map<string, Map<string, number[]>>();

    await Promise.all(
      [...routeStopsMap.entries()].map(async ([routeId, stops]) => {
        if (stops.length < 2) return;
        const positions =
          await this.busLocationService.getLivePositionsByRoute(routeId);
        if (positions.length === 0) return;

        if (!etaMap.has(routeId)) etaMap.set(routeId, new Map());
        const routeEta = etaMap.get(routeId)!;

        for (const pos of positions) {
          const busCoords: Coords = [pos.longitude, pos.latitude];
          const stopEtas = this.estimateStopEtasForBus(
            busCoords,
            stops,
            pos.currentStopIndex,
          );
          for (const [stopId, etaList] of stopEtas) {
            if (!routeEta.has(stopId)) routeEta.set(stopId, []);
            routeEta.get(stopId)!.push(...etaList);
          }
        }

        for (const etas of routeEta.values()) {
          etas.sort((a, b) => a - b);
        }
      }),
    );

    return etaMap;
  }

  private estimateStopEtasForBus(
    busCoords: Coords,
    stops: RouteStop[],
    currentStopIndex?: number,
  ): Map<string, number[]> {
    const etas = new Map<string, number[]>();
    const push = (stopId: string, t: number) => {
      if (!etas.has(stopId)) etas.set(stopId, []);
      etas.get(stopId)!.push(t);
    };

    const nearestSegIdx = this.findBusSegmentIndex(
      busCoords,
      stops,
      currentStopIndex,
    );

    const nextStop = stops[nearestSegIdx + 1];
    const distToNextStop = haversineMeters(busCoords, nextStop.coordinates);
    const fullSegDist =
      nextStop.distanceFromPrevious != null && nextStop.distanceFromPrevious > 0
        ? nextStop.distanceFromPrevious
        : haversineMeters(
            stops[nearestSegIdx].coordinates,
            nextStop.coordinates,
          );
    const fullSegT = segTime(nextStop, stops[nearestSegIdx]);
    const fraction = fullSegDist > 0 ? distToNextStop / fullSegDist : 0;
    const timeToNext = fraction * fullSegT;
    push(nextStop.stopId, timeToNext);

    let accumulated = timeToNext;
    for (let i = nearestSegIdx + 2; i < stops.length; i++) {
      accumulated += segTime(stops[i], stops[i - 1]);
      push(stops[i].stopId, accumulated);
    }

    return etas;
  }

  private findBusSegmentIndex(
    busCoords: Coords,
    stops: RouteStop[],
    currentStopIndex?: number,
  ): number {
    if (currentStopIndex !== undefined) {
      return Math.min(currentStopIndex, stops.length - 2);
    }

    let nearestSegIdx = 0;
    let minDist = Infinity;
    for (let i = 0; i < stops.length - 1; i++) {
      const d = pointToSegmentDistance(
        busCoords,
        stops[i].coordinates,
        stops[i + 1].coordinates,
      );
      if (d < minDist) {
        minDist = d;
        nearestSegIdx = i;
      }
    }
    return nearestSegIdx;
  }

  // ─── Network Loading ──────────────────────────────────────────────────────

  private async loadStopData(): Promise<{
    stopInfoMap: Map<string, StopInfo>;
    routeInfoMap: Map<string, RouteInfo>;
    routeStopsMap: Map<string, RouteStop[]>;
    validStopsCount: number;
  }> {
    const rawStops = await this.busRouteStopModel
      .find()
      .populate('stop', 'name location')
      .populate('route', 'code name status headwayMinutes isLine')
      .sort({ route: 1, stopOrder: 1 })
      .lean()
      .exec();

    const validStops = rawStops.filter(
      (s) =>
        s.stop &&
        (s.stop as any).location?.coordinates &&
        s.route &&
        (s.route as any).status !== 'inactive',
    );

    const stopInfoMap = new Map<string, StopInfo>();
    const routeInfoMap = new Map<string, RouteInfo>();
    const routeStopsMap = new Map<string, RouteStop[]>();

    for (const s of validStops) {
      const place = s.stop as any;
      const route = s.route as any;
      const routeId = route._id.toString();
      const stopId = place._id.toString();

      stopInfoMap.set(stopId, {
        coordinates: place.location.coordinates as Coords,
        name: place.name,
      });

      if (!routeInfoMap.has(routeId)) {
        routeInfoMap.set(routeId, {
          code: route.code,
          name: route.name,
          headwayMinutes: route.headwayMinutes ?? null,
          isLine: route.isLine ?? true,
        });
      }

      if (!routeStopsMap.has(routeId)) routeStopsMap.set(routeId, []);
      const segPath = (s as any).segmentPath as
        | { coordinates: [number, number][] }
        | null
        | undefined;
      const roadDistanceFromPrevious =
        segPath?.coordinates && segPath.coordinates.length >= 2
          ? sumSegmentPathDistance(segPath.coordinates)
          : null;

      routeStopsMap.get(routeId)!.push({
        stopId,
        stopOrder: s.stopOrder!,
        coordinates: place.location.coordinates as Coords,
        distanceFromPrevious: s.distanceFromPrevious,
        roadDistanceFromPrevious,
        segmentPathCoords: segPath?.coordinates ?? null,
      });
    }

    for (const [routeId, stops] of routeStopsMap) {
      stops.sort((a, b) => a.stopOrder - b.stopOrder);

      // For circular routes (isLine === false), append the stop sequence again
      // so the RAPTOR forward scan can cross the terminal without special-casing.
      // e.g. [A,B,C,D] → [A,B,C,D,A,B,C,D]; a passenger at D can board toward A.
      if (routeInfoMap.get(routeId)?.isLine === false) {
        stops.push(...stops.slice());
      }
    }

    return {
      stopInfoMap,
      routeInfoMap,
      routeStopsMap,
      validStopsCount: validStops.length,
    };
  }

  // ─── RAPTOR ──────────────────────────────────────────────────────────────

  private buildStopRouteIndex(routeStopsMap: Map<string, RouteStop[]>): {
    stopRoutes: Map<string, string[]>;
  } {
    const stopRouteSet = new Map<string, Set<string>>();

    for (const [routeId, stops] of routeStopsMap) {
      for (const stop of stops) {
        if (!stopRouteSet.has(stop.stopId)) {
          stopRouteSet.set(stop.stopId, new Set<string>());
        }
        stopRouteSet.get(stop.stopId)!.add(routeId);
      }
    }

    const stopRoutes = new Map<string, string[]>();
    for (const [stopId, routeSet] of stopRouteSet) {
      stopRoutes.set(stopId, [...routeSet]);
    }

    return { stopRoutes };
  }

  private buildFootpaths(
    stopInfoMap: Map<string, StopInfo>,
    stopRoutes: Map<string, string[]>,
  ): Map<string, Footpath[]> {
    const footpaths = new Map<string, Footpath[]>();
    const stopIds = [...stopInfoMap.keys()];

    const stopRouteSets = new Map<string, Set<string>>();
    for (const [stopId, routes] of stopRoutes) {
      stopRouteSets.set(stopId, new Set(routes));
    }

    const pushFootpath = (fromId: string, toId: string, d: number) => {
      if (!footpaths.has(fromId)) footpaths.set(fromId, []);
      footpaths.get(fromId)!.push({
        toStopId: toId,
        walkMinutes: walkMinutes(d, WALK_SPEED_KMH),
        distMeters: d,
      });
    };

    for (let i = 0; i < stopIds.length; i++) {
      for (let j = i + 1; j < stopIds.length; j++) {
        const aId = stopIds[i];
        const bId = stopIds[j];

        const a = stopInfoMap.get(aId)!;
        const b = stopInfoMap.get(bId)!;
        const d = haversineMeters(a.coordinates, b.coordinates);
        if (d > TRANSFER_WALK_MAX_RADIUS_M) continue;

        const aRoutes = stopRouteSets.get(aId) ?? new Set<string>();
        const bRoutes = stopRouteSets.get(bId) ?? new Set<string>();
        const smaller = aRoutes.size < bRoutes.size ? aRoutes : bRoutes;
        const larger = aRoutes.size < bRoutes.size ? bRoutes : aRoutes;

        let hasShared = false;
        for (const r of smaller) {
          if (larger.has(r)) {
            hasShared = true;
            break;
          }
        }
        if (hasShared) continue;

        pushFootpath(aId, bId, d);
        pushFootpath(bId, aId, d);
      }
    }

    return footpaths;
  }

  // ─── RIVER FIX: resolveAccessStop uses real Valhalla walk times ───────────
  // Probes actual pedestrian walk paths for ALL candidate stops within radius,
  // correctly handling river crossings where the straight-line nearest stop
  // may be inaccessible and the real best stop is further along the route.
  //
  // Candidate strategy by role:
  //   ORIGIN seeds  — used by RAPTOR to board: ±5 sequence neighbors around
  //                   haversine-nearest stop. Sequence neighbors matter here
  //                   because the user boards along the route direction.
  //   DEST seeds    — used by reconstructRaptorOptions to pick the best alight
  //                   stop: ALL stops within radius are probed. We cannot rely
  //                   on sequence proximity because a bridge stop further along
  //                   the route may have a much shorter real walk to destination
  //                   than the haversine-nearest stop across the river.
  private async resolveAccessStop(
    point: Coords,
    routeStopsMap: Map<string, RouteStop[]>,
    valhallaWalkCache: Map<
      string,
      { path: Coords[]; distanceMeters: number; durationSeconds: number } | null
    >,
    maxRadiusM: number,
    mode: 'origin' | 'destination' = 'origin',
  ): Promise<Map<string, number>> {
    const pairKey = (from: Coords, to: Coords) =>
      `${from[0].toFixed(5)},${from[1].toFixed(5)}→${to[0].toFixed(5)},${to[1].toFixed(5)}`;

    const seeds = new Map<string, number>();

    for (const [routeId, stops] of routeStopsMap) {
      // Pre-filter: skip routes where even the closest stop is beyond radius.
      // This is a cheap haversine guard — actual walk times come from Valhalla.
      let minIdx = -1;
      let minDist = Infinity;
      for (let i = 0; i < stops.length; i++) {
        const d = haversineMeters(point, stops[i].coordinates);
        if (d < minDist) {
          minDist = d;
          minIdx = i;
        }
      }
      if (minIdx === -1) continue;

      // Build candidate set depending on mode:
      const candidateStops = new Map<string, RouteStop>();

      if (mode === 'destination') {
        // DESTINATION: probe ALL stops on the route — no haversine cutoff.
        //
        // Why: the correct alight stop is whichever stop has the shortest REAL
        // walk to the destination. Near a river, that stop is often a bridge
        // stop that is far in straight-line distance from the destination
        // (the river is in the way) but close in actual walking distance via
        // the bridge. Any haversine radius filter would exclude it before
        // Valhalla ever gets a chance to evaluate it.
        //
        // We rely entirely on Valhalla times + the bestDur+10 threshold to
        // discard stops that are genuinely too far to walk.
        for (const stop of stops) {
          candidateStops.set(stop.stopId, stop);
        }
      } else {
        // ORIGIN: skip route if closest stop is beyond radius (normal filter).
        if (minDist > maxRadiusM) continue;

        // ±5 sequence neighbors + top-3 by straight line.
        // For boarding, the user walks to a stop and waits — sequence neighbors
        // capture stops they could reach along the road in either direction.
        const sortedByDist = [...stops]
          .map((s, i) => ({ s, d: haversineMeters(point, s.coordinates), i }))
          .sort((a, b) => a.d - b.d);
        for (let i = 0; i < Math.min(3, sortedByDist.length); i++) {
          candidateStops.set(sortedByDist[i].s.stopId, sortedByDist[i].s);
        }
        const start = Math.max(0, minIdx - 5);
        const end = Math.min(stops.length - 1, minIdx + 5);
        for (let i = start; i <= end; i++) {
          candidateStops.set(stops[i].stopId, stops[i]);
        }
      }

      // Probe real walking times via Valhalla for all candidates in parallel.
      // Results go into the shared cache to avoid duplicate calls later.
      const candidates = Array.from(candidateStops.values());
      const probes = await Promise.all(
        candidates.map(async (c) => {
          const key = pairKey(point, c.coordinates);
          let r = valhallaWalkCache.get(key);
          if (r === undefined) {
            r = await this.valhallaService.getWalkPath(point, c.coordinates);
            valhallaWalkCache.set(key, r);
          }
          const fallbackDist = haversineMeters(point, c.coordinates);
          return {
            stopId: c.stopId,
            dur: r
              ? r.durationSeconds / 60
              : walkMinutes(fallbackDist, WALK_SPEED_KMH),
          };
        }),
      );

      // Find the fastest REAL walk time among all candidates (Valhalla-based).
      // This is the ground truth — straight-line distance played no role here.
      let bestDur = Infinity;
      for (const p of probes) {
        if (p.dur < bestDur) bestDur = p.dur;
      }

      // Seed stops within 10 min of the best real walk time.
      // For origin: gives RAPTOR flexibility to board at slightly further stops.
      // For destination: gives reconstructRaptorOptions all viable alight stops
      // so it picks the one minimising (RAPTOR arrival time + real walk to dest).
      for (const p of probes) {
        if (p.dur <= bestDur + 10) {
          seeds.set(p.stopId, p.dur);
        }
      }
    }
    return seeds;
  }

  private runRaptor(
    originSeeds: Map<string, number>,
    routeStopsMap: Map<string, RouteStop[]>,
    stopInfoMap: Map<string, StopInfo>,
    routeInfoMap: Map<string, RouteInfo>,
    liveEtaMap: Map<string, Map<string, number[]>>,
    stopRoutes: Map<string, string[]>,
    footpaths: Map<string, Footpath[]>,
    maxRounds = RAPTOR_MAX_ROUNDS,
  ) {
    const tau: Map<string, number>[] = Array.from(
      { length: maxRounds + 1 },
      () => new Map(),
    );
    const labels: Map<string, JourneyLabel>[] = Array.from(
      { length: maxRounds + 1 },
      () => new Map(),
    );
    const tauStar = new Map<string, number>();
    let markedStops = new Set<string>();

    // Seed initial walk arrivals using real Valhalla walk durations
    for (const [stopId, walkTime] of originSeeds) {
      tau[0].set(stopId, walkTime);
      tauStar.set(stopId, walkTime);
      labels[0].set(stopId, {
        type: 'walk',
        fromStopId: '__ORIGIN__',
        distMeters: walkTime * (WALK_SPEED_KMH / 60) * 1000,
      });
      markedStops.add(stopId);
    }

    for (let round = 1; round <= maxRounds; round++) {
      tau[round] = new Map(tau[round - 1]);

      const routesToScan = new Map<string, number>();
      for (const stopId of markedStops) {
        const routes = stopRoutes.get(stopId) ?? [];
        for (const rId of routes) {
          const stops = routeStopsMap.get(rId) ?? [];
          const idx = stops.findIndex((s) => s.stopId === stopId);
          if (idx !== -1) {
            const currentMin = routesToScan.get(rId) ?? Infinity;
            if (idx < currentMin) routesToScan.set(rId, idx);
          }
        }
      }

      const newlyImproved = new Set<string>();

      for (const [routeId, startIndex] of routesToScan) {
        const stops = routeStopsMap.get(routeId) ?? [];
        let boardedAtIndex = -1;
        let boardedAtStopId = '';
        let boardTime = Infinity;
        let boardHasLiveEta = false;
        let rideMinutesFromBoard = 0;

        for (let i = startIndex; i < stops.length; i++) {
          const current = stops[i];

          // Step 1 — boarding check (standard RAPTOR order: before propagation).
          // Allows re-boarding at a later stop when an earlier bus is available
          // there (multi-vehicle routes). Because this runs before propagation,
          // the boarding stop itself is never incorrectly written to tauStar.
          const arrivalPrevRound =
            tau[round - 1].get(current.stopId) ?? Infinity;
          if (isFinite(arrivalPrevRound)) {
            const minCatchable = arrivalPrevRound + MIN_WAIT_MIN;
            const busEtas = liveEtaMap.get(routeId)?.get(current.stopId) ?? [];
            const headway = routeInfoMap.get(routeId)?.headwayMinutes ?? 30;
            const catchable = busEtas.find((eta) => eta >= minCatchable);
            const candidateTime = catchable ?? minCatchable + headway;

            if (boardedAtIndex === -1 || candidateTime < boardTime) {
              boardedAtIndex = i;
              boardedAtStopId = current.stopId;
              boardTime = candidateTime;
              boardHasLiveEta = catchable !== undefined;
              rideMinutesFromBoard = 0;
            }
          }

          // Step 2 — propagate to stops strictly after the boarding stop.
          // Skipping i === boardedAtIndex avoids writing a stale arrival at the
          // boarding stop (its correct arrival is already in tau[round-1]).
          if (boardedAtIndex !== -1 && i > boardedAtIndex) {
            rideMinutesFromBoard += segTime(stops[i], stops[i - 1]);
            const arrivalOnBus = boardTime + rideMinutesFromBoard;

            if (arrivalOnBus < (tauStar.get(current.stopId) ?? Infinity)) {
              tau[round].set(current.stopId, arrivalOnBus);
              tauStar.set(current.stopId, arrivalOnBus);
              labels[round].set(current.stopId, {
                type: 'transit',
                routeId,
                boardedAtStopId,
                boardTime,
                fromStopId: boardedAtStopId,
                hasLiveEta: boardHasLiveEta,
              });
              newlyImproved.add(current.stopId);
            }
          }
        }
      }

      const roundTransferRadius = transferRadiusForRound(round);
      const footpathImprovements = new Set<string>();
      for (const stopId of newlyImproved) {
        const baseArrival = tau[round].get(stopId) ?? Infinity;
        for (const fp of footpaths.get(stopId) ?? []) {
          if (fp.distMeters > roundTransferRadius) continue;
          const arrivalAtTo =
            baseArrival + fp.walkMinutes + TRANSFER_PENALTY_MIN;
          if (arrivalAtTo < (tauStar.get(fp.toStopId) ?? Infinity)) {
            tau[round].set(fp.toStopId, arrivalAtTo);
            tauStar.set(fp.toStopId, arrivalAtTo);
            labels[round].set(fp.toStopId, {
              type: 'walk',
              fromStopId: stopId,
              distMeters: fp.distMeters,
            });
            footpathImprovements.add(fp.toStopId);
          }
        }
      }

      if (newlyImproved.size === 0 && footpathImprovements.size === 0) break;
      markedStops = new Set([...newlyImproved, ...footpathImprovements]);
    }

    return { tau, labels };
  }

  private buildRaptorBusSegment(
    routeId: string,
    boardedAtStopId: string,
    alightStopId: string,
    boardTime: number,
    hasLiveEta: boolean,
    tau: Map<string, number>[],
    round: number,
    routeInfoMap: Map<string, RouteInfo>,
    routeStopsMap: Map<string, RouteStop[]>,
    liveEtaMap: Map<string, Map<string, number[]>>,
    stopInfoMap: Map<string, StopInfo>,
  ): { [key: string]: unknown } | null {
    const routeStops = routeStopsMap.get(routeId) ?? [];
    const boardIdx = routeStops.findIndex((s) => s.stopId === boardedAtStopId);
    // Search for alight stop strictly after board position — handles circular
    // routes where the same stopId appears twice in the (doubled) array.
    const alightIdx = routeStops.findIndex(
      (s, i) => i > boardIdx && s.stopId === alightStopId,
    );
    if (boardIdx < 0 || alightIdx <= boardIdx) return null;

    const boardStop = stopInfoMap.get(boardedAtStopId);
    const alightStop = stopInfoMap.get(alightStopId);
    if (!boardStop || !alightStop) return null;

    let rideDistance = 0;
    let rideMinutes = 0;
    const stopSequence: Array<{ name: string; coordinates: Coords }> = [
      { name: boardStop.name, coordinates: boardStop.coordinates },
    ];
    const busPath: [number, number][] = [
      boardStop.coordinates as [number, number],
    ];

    for (let i = boardIdx + 1; i <= alightIdx; i++) {
      const prev = routeStops[i - 1];
      const curr = routeStops[i];
      rideDistance += bestDistMeters(curr, prev);
      rideMinutes += segTime(curr, prev);

      const stopInfo = stopInfoMap.get(curr.stopId);
      if (stopInfo) {
        stopSequence.push({
          name: stopInfo.name,
          coordinates: stopInfo.coordinates,
        });
      }

      if (curr.segmentPathCoords && curr.segmentPathCoords.length > 1) {
        busPath.push(...curr.segmentPathCoords.slice(1));
      } else if (stopInfo) {
        busPath.push(stopInfo.coordinates as [number, number]);
      }
    }

    const arrivalAtBoardStop = tau[round - 1].get(boardedAtStopId) ?? boardTime;
    const waitMinutes = Math.max(0, boardTime - arrivalAtBoardStop);
    const headway = routeInfoMap.get(routeId)?.headwayMinutes ?? 30;
    const boardEdge: BoardEdge = {
      type: 'board',
      to: onbusNodeId(routeId, boardedAtStopId),
      routeId,
      boardingStopId: boardedAtStopId,
      busEtas: liveEtaMap.get(routeId)?.get(boardedAtStopId) ?? [],
      headwayMinutes: headway,
      hasLiveEta,
    };

    return {
      type: 'bus',
      route: {
        id: routeId,
        code: routeInfoMap.get(routeId)?.code ?? null,
        name: routeInfoMap.get(routeId)?.name ?? null,
      },
      boardAt: { name: boardStop.name, coordinates: boardStop.coordinates },
      alightAt: { name: alightStop.name, coordinates: alightStop.coordinates },
      intermediateStops: stopSequence.slice(1, -1),
      path: busPath,
      distanceMeters: Math.round(rideDistance),
      waitMinutes: Math.round(waitMinutes),
      rideMinutes: Math.max(1, Math.round(rideMinutes)),
      totalLegMinutes:
        Math.round(waitMinutes) + Math.max(1, Math.round(rideMinutes)),
      estimatedMinutes: Math.max(1, Math.round(rideMinutes)),
      hasLiveEta,
      _boardEdge: boardEdge,
    };
  }

  private async reconstructRaptorOptions(
    round: number,
    tau: Map<string, number>[],
    labels: Map<string, JourneyLabel>[],
    origin: Coords,
    destination: Coords,
    stopInfoMap: Map<string, StopInfo>,
    routeInfoMap: Map<string, RouteInfo>,
    routeStopsMap: Map<string, RouteStop[]>,
    liveEtaMap: Map<string, Map<string, number[]>>,
    // destSeeds: real Valhalla walk times from each reachable stop → destination.
    // Stops absent from this map are unreachable on foot (e.g. across a river
    // with no bridge nearby), so they are simply skipped as alight candidates.
    destSeeds: Map<string, number>,
    // valhallaWalkCache: shared cache of Valhalla results keyed by pairKey,
    // populated by resolveAccessStop. Re-used here to avoid duplicate calls.
    valhallaWalkCache: Map<
      string,
      { path: Coords[]; distanceMeters: number; durationSeconds: number } | null
    >,
    topK = 3,
  ): Promise<RawOption[]> {
    const roundLabels = labels[round];
    if (!roundLabels || roundLabels.size === 0) return [];

    type Candidate = { stopId: string; total: number; walkMinutes: number };
    const candidates: Candidate[] = [];

    for (const stopId of roundLabels.keys()) {
      const label = roundLabels.get(stopId)!;

      // Only consider stops reached by a transit (bus) leg as alight candidates.
      // Stops reached via a footpath walk label are intermediate transfer points —
      // RAPTOR wrote them so the next round can board a connecting route from there.
      // If we used them as alight candidates, reconstruction would emit the footpath
      // as a separate walk segment AND then add the destination walk on top, producing
      // two consecutive walks after alighting. The real walk from the bus stop all the
      // way to the destination is already captured by destSeeds (Valhalla computed it
      // from the transit stop directly), so we skip footpath-reached stops entirely.
      if (label.type !== 'transit') continue;

      const arrivalAtStop = tau[round].get(stopId) ?? Infinity;
      const walkToDest = destSeeds.get(stopId); // Real Valhalla walk time

      if (!isFinite(arrivalAtStop) || walkToDest === undefined) continue;

      candidates.push({
        stopId,
        total: arrivalAtStop + walkToDest,
        walkMinutes: walkToDest,
      });
    }

    candidates.sort((a, b) => a.total - b.total);

    const seenJourneyKey = new Set<string>();
    const dedupedOptions: RawOption[] = [];

    for (const candidate of candidates) {
      const option = await this.reconstructFromAlightStop(
        candidate.stopId,
        candidate.total,
        candidate.walkMinutes,
        round,
        tau,
        labels,
        origin,
        destination,
        stopInfoMap,
        routeInfoMap,
        routeStopsMap,
        liveEtaMap,
        valhallaWalkCache,
      );
      if (option && !seenJourneyKey.has(option.fingerprint)) {
        seenJourneyKey.add(option.fingerprint);
        dedupedOptions.push(option);
      }
    }
    return dedupedOptions.slice(0, topK);
  }

  private async reconstructFromAlightStop(
    bestStopId: string,
    bestTotal: number,
    destWalkMinutes: number, // Real Valhalla walk time from bestStopId → destination
    round: number,
    tau: Map<string, number>[],
    labels: Map<string, JourneyLabel>[],
    origin: Coords,
    destination: Coords,
    stopInfoMap: Map<string, StopInfo>,
    routeInfoMap: Map<string, RouteInfo>,
    routeStopsMap: Map<string, RouteStop[]>,
    liveEtaMap: Map<string, Map<string, number[]>>,
    valhallaWalkCache: Map<
      string,
      { path: Coords[]; distanceMeters: number; durationSeconds: number } | null
    >,
  ): Promise<RawOption | null> {
    // Helper: get a Valhalla walk result, using the shared cache to avoid duplicate calls.
    const pairKey = (from: Coords, to: Coords) =>
      `${from[0].toFixed(5)},${from[1].toFixed(5)}→${to[0].toFixed(5)},${to[1].toFixed(5)}`;

    const getWalk = async (from: Coords, to: Coords) => {
      const key = pairKey(from, to);
      if (valhallaWalkCache.has(key)) return valhallaWalkCache.get(key)!;
      this.assertCoords(from, 'reconstructFromAlightStop: from');
      this.assertCoords(to, 'reconstructFromAlightStop: to');
      const result = await this.valhallaService.getWalkPath(from, to);
      valhallaWalkCache.set(key, result);
      return result;
    };

    const segmentsRev: any[] = [];
    let currentStopId = bestStopId;
    let currentRound = round;
    const visited = new Set<string>();

    let lastBusRouteId: string | null = null;
    let busSegmentCount = 0;

    while (currentRound >= 0) {
      if (visited.has(`${currentRound}:${currentStopId}`)) break;
      visited.add(`${currentRound}:${currentStopId}`);

      const label = labels[currentRound].get(currentStopId);
      if (!label) break;

      if (label.type === 'walk') {
        if (label.fromStopId === '__ORIGIN__') {
          const toStop = stopInfoMap.get(currentStopId);
          if (!toStop) return null;
          // Use real Valhalla path for origin → first stop walk
          const walk = await getWalk(origin, toStop.coordinates);
          const distMeters =
            walk?.distanceMeters ?? haversineMeters(origin, toStop.coordinates);
          const estMinutes = walk
            ? Math.round(walk.durationSeconds / 60) || 1
            : Math.round(walkMinutes(distMeters, WALK_SPEED_KMH)) || 1;
          segmentsRev.push({
            type: 'walk',
            from: { name: 'Your Location', coordinates: origin },
            to: { name: toStop.name, coordinates: toStop.coordinates },
            path: walk?.path ?? [origin, toStop.coordinates],
            distanceMeters: Math.round(distMeters),
            estimatedMinutes: estMinutes,
            isTransfer: false,
          });
          break;
        }

        const isActualTransfer = lastBusRouteId !== null;
        const fromStop = stopInfoMap.get(label.fromStopId);
        const toStop = stopInfoMap.get(currentStopId);
        if (!fromStop || !toStop) return null;

        // Use real Valhalla path for transfer walk between stops
        const walk = await getWalk(fromStop.coordinates, toStop.coordinates);
        const distMeters =
          walk?.distanceMeters ??
          haversineMeters(fromStop.coordinates, toStop.coordinates);
        const estMinutes = walk
          ? Math.round(walk.durationSeconds / 60) || 1
          : Math.round(walkMinutes(distMeters, WALK_SPEED_KMH)) || 1;

        segmentsRev.push({
          type: 'walk',
          from: { name: fromStop.name, coordinates: fromStop.coordinates },
          to: { name: toStop.name, coordinates: toStop.coordinates },
          path: walk?.path ?? [fromStop.coordinates, toStop.coordinates],
          distanceMeters: Math.round(distMeters),
          estimatedMinutes: estMinutes,
          isTransfer: isActualTransfer,
        });

        currentStopId = label.fromStopId;
        // ✅ FIX: Do NOT decrement currentRound here.
        // Footpath walk labels are written into the SAME round as the transit
        // leg that enabled them. Decrementing here skips the bus leg in that
        // round entirely, causing the first leg (e.g. Route 2A) to disappear.
        // Only the transit branch should decrement the round.
        continue;
      }

      // ── Transit branch ───────────────────────────────────────────────────
      if (label.routeId !== lastBusRouteId) {
        busSegmentCount++;
      }

      const busSegment = this.buildRaptorBusSegment(
        label.routeId,
        label.boardedAtStopId,
        currentStopId,
        label.boardTime,
        label.hasLiveEta,
        tau,
        currentRound,
        routeInfoMap,
        routeStopsMap,
        liveEtaMap,
        stopInfoMap,
      );
      if (!busSegment) return null;

      segmentsRev.push(busSegment);

      lastBusRouteId = label.routeId;
      currentStopId = label.boardedAtStopId;
      currentRound -= 1;
    }

    // bestStopId is the stop RAPTOR resolved as nearest to the destination
    // (selected via destSeeds in reconstructRaptorOptions). destWalkMinutes is
    // the real Valhalla walk time FROM bestStopId → destination.
    //
    // During reverse traversal above, any footpath walk labels between the bus
    // alight stop and bestStopId were already added as transfer walk segments.
    // We must NOT add another walk from lastBusAlightStopId → destination, as
    // that would duplicate those footpath segments. Instead, always build the
    // final destination walk FROM bestStopId, which is exactly what destSeeds
    // was computed for.
    const destStop = stopInfoMap.get(bestStopId);
    if (!destStop) return null;

    // Use real Valhalla path for bestStopId → destination walk.
    // This result is already cached from the destSeeds resolution pass.
    const destWalk = await getWalk(destStop.coordinates, destination);
    const destDistMeters =
      destWalk?.distanceMeters ??
      haversineMeters(destStop.coordinates, destination);
    const destEstMinutes = destWalk
      ? Math.round(destWalk.durationSeconds / 60) || 1
      : Math.round(destWalkMinutes) || 1;

    segmentsRev.unshift({
      type: 'walk',
      from: {
        name: destStop.name,
        coordinates: destStop.coordinates,
      },
      to: { name: 'Destination', coordinates: destination },
      path: destWalk?.path ?? [destStop.coordinates, destination],
      distanceMeters: Math.round(destDistMeters),
      estimatedMinutes: destEstMinutes,
      isTransfer: false,
    });

    const segments = segmentsRev.reverse();
    let totalDistanceMeters = 0;
    let totalWalkMeters = 0;

    for (const seg of segments as any[]) {
      if (seg.type === 'walk') {
        totalDistanceMeters += seg.distanceMeters as number;
        totalWalkMeters += seg.distanceMeters as number;
      }
      if (seg.type === 'bus') {
        totalDistanceMeters += seg.distanceMeters as number;
      }
    }

    const fingerprint = segments
      .filter((s) => s.type === 'bus')
      .map((s) => s.route.id)
      .join('->');

    const finalTransferCount = Math.max(0, busSegmentCount - 1);

    return {
      totalEstimatedMinutes: Math.round(bestTotal),
      totalDistanceMeters: Math.round(totalDistanceMeters),
      totalWalkMeters: Math.round(totalWalkMeters),
      transferCount: finalTransferCount,
      segments,
      fingerprint: fingerprint || `walk:${Math.round(totalWalkMeters)}`,
    };
  }

  // Re-evaluate every bus leg's catchability using the final (Valhalla-enriched)
  // walk times. RAPTOR used approximate seed times; this is the authoritative pass.
  // We walk segments in order, accumulate the true elapsed user time to each
  // boarding stop, then pick the first live ETA >= (arrival + MIN_WAIT_MIN).
  // If no live ETA qualifies (bus already gone), fall back to scheduled headway
  // from the user's earliest possible board time.
  private recheckBusCatchability(rawOptions: RawOption[]): void {
    for (const opt of rawOptions) {
      let cumulativeMinutes = 0; // real elapsed time for the user up to each point
      let totalRecalc = 0;

      for (const seg of opt.segments as any[]) {
        if (seg.type === 'walk') {
          cumulativeMinutes += seg.estimatedMinutes as number;
          totalRecalc += seg.estimatedMinutes as number;
          continue;
        }

        if (seg.type === 'bus') {
          const boardEdge = seg._boardEdge as BoardEdge | undefined;
          if (boardEdge) {
            // Earliest the user can board: must have walked to stop + MIN_WAIT_MIN buffer.
            // Any live ETA before this threshold is already missed — skip it.
            const earliestBoard = cumulativeMinutes + MIN_WAIT_MIN;
            const hw = boardEdge.headwayMinutes ?? 30;

            // Find the first live ETA the user can actually catch.
            const catchableEta = boardEdge.busEtas.find(
              (eta) => eta >= earliestBoard,
            );

            // If no live ETA is catchable, use headway FROM earliestBoard —
            // NOT minCatchable + headway, which would double-count the wait.
            const boardTime = catchableEta ?? earliestBoard + hw;

            seg.waitMinutes = Math.round(
              Math.max(0, boardTime - cumulativeMinutes),
            );
            seg.totalLegMinutes =
              (seg.waitMinutes as number) + (seg.rideMinutes as number);
            // Only mark as live if a real ETA was catchable
            seg.hasLiveEta = catchableEta !== undefined;

            // Expose ETAs for client display, remove internal edge
            seg.busEtas = boardEdge.busEtas;
            delete seg._boardEdge;
          }

          cumulativeMinutes += seg.totalLegMinutes as number;
          totalRecalc += seg.totalLegMinutes as number;
        }
      }

      opt.totalEstimatedMinutes = Math.round(totalRecalc);
    }
  }

  private addLongWalkMetadata(options: RawOption[]) {
    for (const opt of options) {
      const firstLeg = opt.segments[0] as any;
      if (
        firstLeg?.type === 'walk' &&
        firstLeg.distanceMeters > LONG_WALK_WARNING_M
      ) {
        opt.warning =
          'Note: This route requires a significant walk to the first stop.';
      }
    }
  }

  private assignTransitLabel(
    idx: number,
    deltaMinutes: number,
    fastestMinutes: number,
  ): TransitPositionMeta {
    if (idx === 0) return { type: 'fastest', label: 'Fastest' };
    // Use percentage of the fastest time so thresholds scale with journey length.
    const pct =
      fastestMinutes > 0 ? (deltaMinutes / fastestMinutes) * 100 : 100;
    if (pct <= 10) return { type: 'fast', label: 'Fast' };
    if (pct <= 25) return { type: 'average', label: 'Average' };
    if (pct <= 50) return { type: 'slower', label: 'Slower' };
    return { type: 'slowest', label: 'Slowest' };
  }

  private mapTransitSuccessResponse(rawOptions: RawOption[]) {
    // Rank by score (time + transfer penalty) to select the top-K options,
    // preferring direct routes over transfers of similar duration.
    const ranked = [...rawOptions].sort((a, b) => {
      const aScore =
        a.totalEstimatedMinutes +
        a.transferCount * TRANSFER_PENALTY_FOR_RANKING;
      const bScore =
        b.totalEstimatedMinutes +
        b.transferCount * TRANSFER_PENALTY_FOR_RANKING;
      return aScore - bScore;
    });

    const topOptions = ranked.slice(0, TOP_TRANSIT_OPTIONS);
    if (topOptions.length === 0) {
      return { found: false as const, type: 'transit' as const, options: [] };
    }

    // Re-sort by actual travel time so the user always sees fastest first.
    const display = [...topOptions].sort(
      (a, b) => a.totalEstimatedMinutes - b.totalEstimatedMinutes,
    );

    const fastestTime = display[0].totalEstimatedMinutes;

    return {
      found: true as const,
      type: 'transit' as const,
      options: display.map((o, idx) => {
        const meta = this.assignTransitLabel(
          idx,
          o.totalEstimatedMinutes - fastestTime,
          fastestTime,
        );

        return {
          type: meta.type,
          label: meta.label,
          totalEstimatedMinutes: o.totalEstimatedMinutes,
          totalDistanceMeters: o.totalDistanceMeters,
          totalWalkMeters: o.totalWalkMeters,
          transferCount: o.transferCount,
          warning: o.warning,
          segments: o.segments,
        };
      }),
    };
  }

  async planRoute(
    origin: Coords,
    destination: Coords,
    type: 'walk' | 'transit' = 'transit',
  ) {
    if (type === 'walk') return this.planWalkRoute(origin, destination);
    return this.planTransitRoute(origin, destination);
  }

  private async planWalkRoute(origin: Coords, destination: Coords) {
    this.assertCoords(origin, 'planWalkRoute: origin');
    this.assertCoords(destination, 'planWalkRoute: destination');

    const directWalkDist = haversineMeters(origin, destination);
    const valhallaResult = await this.valhallaService.getWalkPath(
      origin,
      destination,
    );
    const path: Coords[] = valhallaResult?.path ?? [origin, destination];
    const distanceMeters = valhallaResult?.distanceMeters ?? directWalkDist;
    const estimatedMinutes = valhallaResult
      ? Math.round(valhallaResult.durationSeconds / 60) || 1
      : Math.round(walkMinutes(directWalkDist, WALK_SPEED_KMH));

    return {
      found: true,
      type: 'walk',
      options: [
        {
          type: 'walk',
          label: 'Walking',
          totalEstimatedMinutes: estimatedMinutes,
          totalDistanceMeters: Math.round(distanceMeters),
          totalWalkMeters: Math.round(distanceMeters),
          transferCount: 0,
          segments: [
            {
              type: 'walk',
              from: { name: 'Your Location', coordinates: origin },
              to: { name: 'Destination', coordinates: destination },
              path,
              distanceMeters: Math.round(distanceMeters),
              estimatedMinutes,
            },
          ],
        },
      ],
    };
  }

  private async planTransitRoute(origin: Coords, destination: Coords) {
    this.assertCoords(origin, 'planTransitRoute: origin');
    this.assertCoords(destination, 'planTransitRoute: destination');

    const network = await this.getNetwork();
    if (network.validStopsCount === 0 || network.routeStopsMap.size === 0) {
      this.logger.warn(
        '[planTransitRoute] No stops in network, cannot find transit route',
      );
      return { found: false as const, type: 'transit' as const, options: [] };
    }

    const liveEtaMap = await this.computeLiveEtaMap(network.routeStopsMap);

    // Shared Valhalla cache: reused across all attempts and reconstruction
    // so we never call Valhalla twice for the same coordinate pair.
    const valhallaWalkCache = new Map<
      string,
      { path: Coords[]; distanceMeters: number; durationSeconds: number } | null
    >();

    // Destination seeds are computed once — destination mode probes every stop
    // on each route regardless of radius, so recomputing per attempt is redundant.
    const destSeeds = await this.resolveAccessStop(
      destination,
      network.routeStopsMap,
      valhallaWalkCache,
      Infinity,
      'destination',
    );
    if (destSeeds.size === 0) {
      this.logger.warn(
        '[planTransitRoute] No destination stops reachable via Valhalla',
      );
      return { found: false as const, type: 'transit' as const, options: [] };
    }

    // Expand search radius each attempt until a valid transit route is found.
    // We never fall back to a walk plan — the caller requested transit, so we
    // keep widening until ORIGIN_RADII_M is exhausted, then return found:false
    // so the frontend can decide what to show (e.g. "no routes found nearby").
    for (let attempt = 0; attempt < ORIGIN_RADII_M.length; attempt++) {
      const radiusM = ORIGIN_RADII_M[attempt];
      this.logger.debug(
        `[planTransitRoute] attempt=${attempt + 1}/${ORIGIN_RADII_M.length} radius=${radiusM}m`,
      );

      const originSeeds = await this.resolveAccessStop(
        origin,
        network.routeStopsMap,
        valhallaWalkCache,
        radiusM,
        'origin',
      );

      if (originSeeds.size === 0) {
        this.logger.debug(
          `[planTransitRoute] attempt=${attempt + 1} originSeeds=0 — expanding radius`,
        );
        continue;
      }

      const { tau, labels } = this.runRaptor(
        originSeeds,
        network.routeStopsMap,
        network.stopInfoMap,
        network.routeInfoMap,
        liveEtaMap,
        network.stopRoutes,
        network.footpaths,
        RAPTOR_MAX_ROUNDS,
      );

      const rawOptions: RawOption[] = [];
      for (let round = 1; round <= RAPTOR_MAX_ROUNDS; round++) {
        const opts = await this.reconstructRaptorOptions(
          round,
          tau,
          labels,
          origin,
          destination,
          network.stopInfoMap,
          network.routeInfoMap,
          network.routeStopsMap,
          liveEtaMap,
          destSeeds,
          valhallaWalkCache,
        );
        rawOptions.push(...opts);
      }

      if (rawOptions.length === 0) {
        this.logger.debug(
          `[planTransitRoute] attempt=${attempt + 1} rawOptions=0 — expanding radius`,
        );
        continue;
      }

      this.recheckBusCatchability(rawOptions);

      const seen = new Set<string>();
      const finalOptions = rawOptions
        .filter((o) => {
          if (seen.has(o.fingerprint)) return false;
          seen.add(o.fingerprint);
          return true;
        })
        .filter((o) => o.segments.some((s) => s.type === 'bus'));

      if (finalOptions.length === 0) {
        this.logger.debug(
          `[planTransitRoute] attempt=${attempt + 1} no valid bus options after filter — expanding radius`,
        );
        continue;
      }

      this.logger.debug(
        `[planTransitRoute] found ${finalOptions.length} option(s) at attempt=${attempt + 1} radius=${radiusM}m`,
      );
      this.addLongWalkMetadata(finalOptions);
      return this.mapTransitSuccessResponse(finalOptions);
    }

    // All radii exhausted — no transit route reachable. Return found:false so
    // the frontend can handle this case (e.g. show "no nearby stops" message).
    // Never return a walk plan here: the user explicitly requested transit.
    this.logger.warn(
      `[planTransitRoute] All ${ORIGIN_RADII_M.length} radius attempts exhausted — no transit route found`,
    );
    return { found: false as const, type: 'transit' as const, options: [] };
  }
}
