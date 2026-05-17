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
import { OsrmService } from './osrm.service';
import {
  WALK_SPEED_KMH,
  BUS_SIMULATION_SPEED_KMH,
  TRANSFER_WALK_BASE_RADIUS_M,
  TRANSFER_WALK_RADIUS_GROWTH_PER_ROUND_M,
  TRANSFER_WALK_MAX_RADIUS_M,
  TRANSFER_PENALTY_MIN,
  MIN_WAIT_MIN,
} from '../../shared/constants/constants';
import {
  Coords,
  haversineMeters,
  walkMinutes,
  pointToSegmentDistance,
} from '../../shared/helpers/helper-functions';

// ─── Types ───────────────────────────────────────────────────────────────────

interface StopInfo {
  coordinates: Coords;
  name: string;
}

interface RouteInfo {
  code?: string | null;
  name?: string | null;
  headwayMinutes?: number | null;
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

type WalkPair = {
  segIdx: number;
  from: Coords;
  to: Coords;
  origDist: number;
};

type RawOption = {
  totalEstimatedMinutes: number;
  totalDistanceMeters: number;
  totalWalkMeters: number;
  transferCount: number;
  segments: any[];
  walkPairs: WalkPair[];
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
  return (bestDistMeters(stop, prev) / 1000 / BUS_SIMULATION_SPEED_KMH) * 60;
}

function nextBusTime(
  busEtas: number[],
  minCatchableTime: number,
  headwayMinutes: number,
): number {
  const catchable = busEtas.find((eta) => eta >= minCatchableTime);
  if (catchable !== undefined) return catchable;
  return minCatchableTime + headwayMinutes;
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

  private readonly CACHE_TTL_MS = 5 * 60 * 1000;

  constructor(
    @InjectModel(BusRouteStop.name)
    private readonly busRouteStopModel: Model<BusRouteStop>,
    private readonly busLocationService: BusLocationService,
    private readonly osrmService: OsrmService,
  ) {}

  invalidateNetworkCache(): void {
    this.networkCache = null;
  }

  // FIX #1: Coordinate Order Verification
  // OSRM requires [longitude, latitude]. If values exceed normal ranges, log an error.
  private assertCoords(c: Coords, label: string) {
    if (Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90) {
      this.logger.error(
        `${label}: suspicious coords [${c}] — may be lat/lng swapped. OSRM expects [longitude, latitude].`,
      );
    }
  }

  private async getNetwork() {
    const now = Date.now();
    if (
      this.networkCache &&
      now - this.networkCache.builtAt < this.CACHE_TTL_MS
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

    for (const stops of routeStopsMap.values()) {
      stops.sort((a, b) => a.stopOrder - b.stopOrder);
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

  private getSeedsForRadius(
    routeStopsMap: Map<string, RouteStop[]>,
    stopInfoMap: Map<string, StopInfo>,
    origin: Coords,
    radiusM: number,
  ): Set<string> {
    const seeds = new Set<string>();

    for (const stops of routeStopsMap.values()) {
      let nearestId: string | null = null;
      let nearestDist = Infinity;

      for (const stop of stops) {
        const d = haversineMeters(origin, stop.coordinates);
        if (d < nearestDist) {
          nearestDist = d;
          nearestId = stop.stopId;
        }
      }

      if (nearestId && nearestDist <= radiusM) {
        seeds.add(nearestId);
      }
    }

    return seeds;
  }

  private runRaptor(
    origin: Coords,
    originSeeds: Set<string>,
    routeStopsMap: Map<string, RouteStop[]>,
    stopInfoMap: Map<string, StopInfo>,
    routeInfoMap: Map<string, RouteInfo>,
    liveEtaMap: Map<string, Map<string, number[]>>,
    stopRoutes: Map<string, string[]>,
    footpaths: Map<string, Footpath[]>,
    maxRounds = 4,
  ): {
    tau: Map<string, number>[];
    labels: Map<string, JourneyLabel>[];
  } {
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

    // Initial walk to stops
    for (const stopId of originSeeds) {
      const info = stopInfoMap.get(stopId);
      if (!info) continue;
      const d = haversineMeters(origin, info.coordinates);
      const arrival = walkMinutes(d, WALK_SPEED_KMH);
      tau[0].set(stopId, arrival);
      tauStar.set(stopId, arrival);
      labels[0].set(stopId, {
        type: 'walk',
        fromStopId: '__ORIGIN__',
        distMeters: d,
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

          if (boardedAtIndex !== -1) {
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

          const arrivalPrevRound =
            tau[round - 1].get(current.stopId) ?? Infinity;
          if (isFinite(arrivalPrevRound)) {
            const minCatchable = arrivalPrevRound + MIN_WAIT_MIN;
            const busEtas = liveEtaMap.get(routeId)?.get(current.stopId) ?? [];
            const headway = routeInfoMap.get(routeId)?.headwayMinutes ?? 30;
            const catchable = busEtas.find((eta) => eta >= minCatchable);
            const candidateTime = catchable ?? minCatchable + headway;

            // FIX #4: Compare only boarding times (find earliest possible board)
            if (boardedAtIndex === -1 || candidateTime < boardTime) {
              boardedAtIndex = i;
              boardedAtStopId = current.stopId;
              boardTime = candidateTime;
              boardHasLiveEta = catchable !== undefined;
              rideMinutesFromBoard = 0;
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
    const alightIdx = routeStops.findIndex((s) => s.stopId === alightStopId);
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

  private reconstructRaptorOptions(
    round: number,
    tau: Map<string, number>[],
    labels: Map<string, JourneyLabel>[],
    origin: Coords,
    destination: Coords,
    stopInfoMap: Map<string, StopInfo>,
    routeInfoMap: Map<string, RouteInfo>,
    routeStopsMap: Map<string, RouteStop[]>,
    liveEtaMap: Map<string, Map<string, number[]>>,
    destRadiusM: number,
    topK = 3,
  ): RawOption[] {
    const roundLabels = labels[round];
    if (!roundLabels || roundLabels.size === 0) return [];

    type Candidate = { stopId: string; total: number; dist: number };
    const candidates: Candidate[] = [];

    for (const stopId of roundLabels.keys()) {
      const arrivalAtStop = tau[round].get(stopId) ?? Infinity;
      const stopInfo = stopInfoMap.get(stopId);
      if (!isFinite(arrivalAtStop) || !stopInfo) continue;

      const distToDest = haversineMeters(stopInfo.coordinates, destination);
      if (distToDest > destRadiusM) continue;

      const total = arrivalAtStop + walkMinutes(distToDest, WALK_SPEED_KMH);
      candidates.push({ stopId, total, dist: distToDest });
    }

    candidates.sort((a, b) => a.total - b.total);

    const seenJourneyKey = new Set<string>();
    const dedupedOptions: RawOption[] = [];

    for (const candidate of candidates) {
      const option = this.reconstructFromAlightStop(
        candidate.stopId,
        candidate.total,
        round,
        tau,
        labels,
        origin,
        destination,
        stopInfoMap,
        routeInfoMap,
        routeStopsMap,
        liveEtaMap,
      );
      if (option && !seenJourneyKey.has(option.fingerprint)) {
        seenJourneyKey.add(option.fingerprint);
        dedupedOptions.push(option);
      }
    }
    return dedupedOptions.slice(0, topK);
  }

  private reconstructFromAlightStop(
    bestStopId: string,
    bestTotal: number,
    round: number,
    tau: Map<string, number>[],
    labels: Map<string, JourneyLabel>[],
    origin: Coords,
    destination: Coords,
    stopInfoMap: Map<string, StopInfo>,
    routeInfoMap: Map<string, RouteInfo>,
    routeStopsMap: Map<string, RouteStop[]>,
    liveEtaMap: Map<string, Map<string, number[]>>,
  ): RawOption | null {
    const segmentsRev: any[] = [];
    let currentStopId = bestStopId;
    let currentRound = round;
    const visited = new Set<string>();

    let lastBusRouteId: string | null = null;
    let busSegmentCount = 0;
    let lastBusAlightStopId: string | null = null;

    while (currentRound >= 0) {
      if (visited.has(`${currentRound}:${currentStopId}`)) break;
      visited.add(`${currentRound}:${currentStopId}`);

      const label = labels[currentRound].get(currentStopId);
      if (!label) break;

      if (label.type === 'walk') {
        if (label.fromStopId === '__ORIGIN__') {
          const toStop = stopInfoMap.get(currentStopId);
          if (!toStop) return null;
          segmentsRev.push({
            type: 'walk',
            from: { name: 'Your Location', coordinates: origin },
            to: { name: toStop.name, coordinates: toStop.coordinates },
            path: [origin, toStop.coordinates] as Coords[],
            distanceMeters: Math.round(label.distMeters),
            estimatedMinutes:
              Math.round(walkMinutes(label.distMeters, WALK_SPEED_KMH)) || 1,
            isTransfer: false,
          });
          break;
        }

        const isActualTransfer = lastBusRouteId !== null;
        const fromStop = stopInfoMap.get(label.fromStopId);
        const toStop = stopInfoMap.get(currentStopId);
        if (!fromStop || !toStop) return null;

        segmentsRev.push({
          type: 'walk',
          from: { name: fromStop.name, coordinates: fromStop.coordinates },
          to: { name: toStop.name, coordinates: toStop.coordinates },
          path: [fromStop.coordinates, toStop.coordinates] as Coords[],
          distanceMeters: Math.round(label.distMeters),
          estimatedMinutes:
            Math.round(walkMinutes(label.distMeters, WALK_SPEED_KMH)) || 1,
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

      lastBusAlightStopId ??= currentStopId; // ✅ only set on the FIRST bus seen (= last bus forward)
      lastBusRouteId = label.routeId;
      currentStopId = label.boardedAtStopId;
      currentRound -= 1;
    }

    const dropOffStopId = lastBusAlightStopId ?? bestStopId;
    const lastTransitStop = stopInfoMap.get(dropOffStopId);
    if (!lastTransitStop) return null;

    const destDist = haversineMeters(lastTransitStop.coordinates, destination);
    segmentsRev.unshift({
      type: 'walk',
      from: {
        name: lastTransitStop.name,
        coordinates: lastTransitStop.coordinates,
      },
      to: { name: 'Destination', coordinates: destination },
      path: [lastTransitStop.coordinates, destination] as Coords[],
      distanceMeters: Math.round(destDist),
      estimatedMinutes: Math.round(walkMinutes(destDist, WALK_SPEED_KMH)) || 1,
      isTransfer: false,
    });

    const segments = segmentsRev.reverse();
    let totalDistanceMeters = 0;
    let totalWalkMeters = 0;
    const walkPairs: WalkPair[] = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i] as any;
      if (seg.type === 'walk') {
        totalDistanceMeters += seg.distanceMeters as number;
        totalWalkMeters += seg.distanceMeters as number;
        walkPairs.push({
          segIdx: i,
          from: seg.from.coordinates as Coords,
          to: seg.to.coordinates as Coords,
          origDist: seg.distanceMeters as number,
        });
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
      walkPairs,
      fingerprint: fingerprint || `walk:${Math.round(totalWalkMeters)}`,
    };
  }

  private async enrichWalkSegmentsWithOsrm(
    rawOptions: RawOption[],
  ): Promise<void> {
    const pairKey = (from: Coords, to: Coords) =>
      `${from[0].toFixed(5)},${from[1].toFixed(5)}→${to[0].toFixed(5)},${to[1].toFixed(5)}`;

    const uniquePairs = new Map<string, { from: Coords; to: Coords }>();
    for (const opt of rawOptions) {
      for (const wp of opt.walkPairs) {
        uniquePairs.set(pairKey(wp.from, wp.to), { from: wp.from, to: wp.to });
      }
    }

    const osrmCache = new Map<
      string,
      { path: Coords[]; distanceMeters: number; durationSeconds: number } | null
    >();

    // FIX: Process sequentially using for...of instead of Promise.all
    // This stops us from hitting the public OSRM server with 15 requests
    // simultaneously, which was causing the silent 429 Rate Limit failures.
    for (const [key, pair] of uniquePairs.entries()) {
      this.assertCoords(pair.from, 'enrichWalkSegmentsWithOsrm: from');
      this.assertCoords(pair.to, 'enrichWalkSegmentsWithOsrm: to');

      // (We no longer need snapCoord fallback because OsrmService handles truncation)
      const result = await this.osrmService.getWalkPath(pair.from, pair.to);
      osrmCache.set(key, result);

      // Optional: Add a tiny 50ms delay between requests to be extra safe with the demo server
      if (uniquePairs.size > 2) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    for (const opt of rawOptions) {
      for (const wp of opt.walkPairs) {
        const result = osrmCache.get(pairKey(wp.from, wp.to));
        const seg = opt.segments[wp.segIdx] as any;
        if (result) {
          opt.totalDistanceMeters =
            opt.totalDistanceMeters - wp.origDist + result.distanceMeters;
          opt.totalWalkMeters =
            opt.totalWalkMeters - wp.origDist + result.distanceMeters;
          seg.path = result.path;
          seg.distanceMeters = Math.round(result.distanceMeters);
          seg.estimatedMinutes = Math.round(result.durationSeconds / 60) || 1;
        } else {
          seg.isApproximate = true;
        }
      }
    }
  }

  private recheckBusCatchability(rawOptions: RawOption[]): void {
    for (const opt of rawOptions) {
      let cumulativeMinutes = 0;
      let totalRecalc = 0;
      for (const seg of opt.segments as any[]) {
        if (seg.type === 'walk') {
          cumulativeMinutes += seg.estimatedMinutes as number;
          totalRecalc += seg.estimatedMinutes as number;
        } else if (seg.type === 'bus') {
          const boardEdge = seg._boardEdge as BoardEdge | undefined;
          if (boardEdge) {
            const minCatchable = cumulativeMinutes + MIN_WAIT_MIN;
            const hw = boardEdge.headwayMinutes ?? 30;
            const boardTime = nextBusTime(boardEdge.busEtas, minCatchable, hw);
            seg.waitMinutes = Math.round(
              Math.max(0, boardTime - cumulativeMinutes),
            );
            seg.totalLegMinutes = seg.waitMinutes + (seg.rideMinutes as number);
            seg.hasLiveEta =
              boardEdge.hasLiveEta &&
              boardEdge.busEtas.some((eta) => eta >= minCatchable);
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
      if (firstLeg?.type === 'walk' && firstLeg.distanceMeters > 1500) {
        opt.warning =
          'Note: This route requires a significant walk to the first stop.';
      }
    }
  }

  private assignTransitLabel(
    idx: number,
    deltaMinutes: number,
  ): TransitPositionMeta {
    if (idx === 0) return { type: 'fastest', label: 'Fastest' };
    if (deltaMinutes <= 5) return { type: 'fast', label: 'Fast' };
    if (deltaMinutes <= 15) return { type: 'average', label: 'Average' };
    if (deltaMinutes <= 30) return { type: 'slower', label: 'Slower' };
    return { type: 'slowest', label: 'Slowest' };
  }

  private mapTransitSuccessResponse(rawOptions: RawOption[]) {
    const TRANSFER_PENALTY_FOR_RANKING = 15;

    const sorted = [...rawOptions].sort((a, b) => {
      const aScore =
        a.totalEstimatedMinutes +
        a.transferCount * TRANSFER_PENALTY_FOR_RANKING;
      const bScore =
        b.totalEstimatedMinutes +
        b.transferCount * TRANSFER_PENALTY_FOR_RANKING;
      return aScore - bScore;
    });

    const topOptions = sorted.slice(0, 5);
    if (topOptions.length === 0) {
      return { found: false as const, type: 'transit' as const, options: [] };
    }

    const fastestTime = topOptions[0].totalEstimatedMinutes;

    return {
      found: true as const,
      type: 'transit' as const,
      options: topOptions.map((o, idx) => {
        // Compute how this option compares to the very best option dynamically
        const meta = this.assignTransitLabel(
          idx,
          o.totalEstimatedMinutes - fastestTime,
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
    // Guard checks injected here before calling OSRM via planWalkRoute
    this.assertCoords(origin, 'planWalkRoute: origin');
    this.assertCoords(destination, 'planWalkRoute: destination');

    const directWalkDist = haversineMeters(origin, destination);
    const osrmResult = await this.osrmService.getWalkPath(origin, destination);
    const path: Coords[] = osrmResult?.path ?? [origin, destination];
    const distanceMeters = osrmResult?.distanceMeters ?? directWalkDist;
    const estimatedMinutes = osrmResult
      ? Math.round(osrmResult.durationSeconds / 60) || 1
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
    // Guard checks injected here at the beginning of the transit flow
    this.assertCoords(origin, 'planTransitRoute: origin');
    this.assertCoords(destination, 'planTransitRoute: destination');

    const network = await this.getNetwork();
    if (network.validStopsCount === 0 || network.routeStopsMap.size === 0)
      return this.planWalkRoute(origin, destination);

    const liveEtaMap = await this.computeLiveEtaMap(network.routeStopsMap);

    const ORIGIN_RADII = [1000, 2000, 3000, Infinity];
    const DEST_RADII = [1000, 2000, 3000, Infinity];

    for (let attempt = 0; attempt < ORIGIN_RADII.length; attempt++) {
      const originRadiusM = ORIGIN_RADII[attempt];
      const destRadiusM = DEST_RADII[attempt];

      this.logger.debug(
        `[planTransitRoute] attempt=${attempt + 1} ` +
          `originRadius=${originRadiusM}m destRadius=${destRadiusM}m`,
      );

      const originSeeds = this.getSeedsForRadius(
        network.routeStopsMap,
        network.stopInfoMap,
        origin,
        originRadiusM,
      );

      const maxRounds = 4;
      const { tau, labels } = this.runRaptor(
        origin,
        originSeeds,
        network.routeStopsMap,
        network.stopInfoMap,
        network.routeInfoMap,
        liveEtaMap,
        network.stopRoutes,
        network.footpaths,
        maxRounds,
      );

      const rawOptions: RawOption[] = [];
      for (let round = 1; round <= maxRounds; round++) {
        rawOptions.push(
          ...this.reconstructRaptorOptions(
            round,
            tau,
            labels,
            origin,
            destination,
            network.stopInfoMap,
            network.routeInfoMap,
            network.routeStopsMap,
            liveEtaMap,
            destRadiusM,
          ),
        );
      }

      if (rawOptions.length === 0) {
        this.logger.debug(
          `[planTransitRoute] attempt=${attempt + 1} rawOptions=0, expanding...`,
        );
        continue;
      }

      await this.enrichWalkSegmentsWithOsrm(rawOptions);
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
          `[planTransitRoute] attempt=${attempt + 1} finalOptions=0 after filter, expanding...`,
        );
        continue;
      }

      this.addLongWalkMetadata(finalOptions);
      return this.mapTransitSuccessResponse(finalOptions);
    }

    this.logger.warn(
      '[planTransitRoute] All expansion attempts exhausted, falling back to walk',
    );
    return this.planWalkRoute(origin, destination);
  }
}
