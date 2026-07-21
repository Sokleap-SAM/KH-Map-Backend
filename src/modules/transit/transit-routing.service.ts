/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { BusRouteStop } from './entities/bus-route-stop.schema';
import { BusTrip, BusTripDocument } from './entities/bus-trip.schema';
import { BusLocationService } from './bus-location.service';
import {
  WALK_SPEED_KMH,
  BUS_ROUTING_SPEED_KMH,
  TRANSFER_WALK_BASE_RADIUS_M,
  TRANSFER_WALK_RADIUS_GROWTH_PER_ROUND_M,
  TRANSFER_WALK_MAX_RADIUS_M,
  TRANSFER_PENALTY_MIN,
  MIN_WAIT_MIN,
  TRANSFER_UNCERTAINTY_BUFFER_MIN,
  DWELL_TIME_MIN,
  NETWORK_CACHE_TTL_MS,
  NETWORK_CACHE_REDIS_KEY,
  NETWORK_CACHE_REDIS_TTL_SECONDS,
  VALHALLA_FOOTPATH_SOURCE_BATCH,
  LIVE_ETA_CACHE_TTL_MS,
  ORIGIN_RADII_M,
  RAPTOR_MAX_ROUNDS,
  TRANSFER_PENALTY_FOR_RANKING,
  TIE_DELTA_MIN,
  LONG_WALK_WARNING_M,
  TOP_TRANSIT_OPTIONS,
  FOOTPATH_RELAXATION_MIN,
  OPTION_HYSTERESIS_MS,
} from '../../shared/constants/constants';
import { RedisService } from '../../shared/redis/redis.service';
import {
  Coords,
  haversineMeters,
  walkMinutes,
  pointToSegmentDistance,
} from '../../shared/helpers/helper-functions';
import { ValhallaService } from './valhalla.service';
import { Language } from './dto/plan-route.dto';

// ─── Types ───────────────────────────────────────────────────────────────────

interface StopInfo {
  coordinates: Coords;
  // Both language variants are cached so a single shared network snapshot can
  // serve requests in either language — the response builder picks one via
  // `stopName(info, language)`.
  nameInKhmer: string;
  nameInLatin: string;
}

interface RouteInfo {
  code?: string | null;
  name?: string | null;
  color?: string | null;
  headwayMinutes?: number | null;
  isLine?: boolean | null;
  /**
   * Cumulative ride minutes from the route's first stop to stop i, computed
   * once over the first lap of stops. Used to derive anchored next-lap
   * arrivals at any boarding stop: `anchor + headway + ridePrefix[i]`.
   * For circular routes (which double the stop array), look up with
   * `i % originalStopCount` so the second lap reuses the first lap's prefix.
   */
  ridePrefixMinutes?: number[];
  /** Stop count BEFORE the circular-doubling step in loadStopData. */
  originalStopCount?: number;
}

interface RouteStop {
  stopId: string;
  stopOrder: number;
  coordinates: Coords;
  distanceFromPrevious?: number | null;
  roadDistanceFromPrevious?: number | null;
  segmentPathCoords: [number, number][] | null;
}

/**
 * One live-bus ETA at a specific stop, with the identifiers needed for the
 * response to point the frontend at a specific bus/trip. Built in
 * computeLiveEtaMap, sorted ascending by `eta` within each stop's list.
 */
interface BusEta {
  eta: number;
  busId?: string;
  tripId: string;
}

interface BoardEdge {
  type: 'board';
  to: string;
  routeId: string;
  boardingStopId: string;
  busEtas: BusEta[];
  headwayMinutes: number | null;
  hasLiveEta: boolean;
  /**
   * Anchored next-lap arrival at the boarding stop, in minutes from the
   * request's `now`. Reused by the recheck step in `applyLiveEtaToOptions`
   * so anchored projection survives all the way through to the final
   * `nextBusInMinutes` value the client renders.
   */
  anchoredNextLapArrivalMinutes?: number | null;
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

// ─── Module-level helpers ─────────────────────────────────────────────────────

// Fixed (non-DB) response strings, per language. Stop names come from the DB
// (see `stopName`); everything here is UI text the backend generates itself.
// Adjust the Khmer wording freely — it's isolated to this table.
const UI_STRINGS = {
  [Language.ENGLISH]: {
    yourLocation: 'Your Location',
    destination: 'Destination',
    walking: 'Walking',
    longWalkWarning: (meters: number) =>
      `Long walking distance: ${meters}m total`,
    significantWalkToFirstStop:
      'Note: This route requires a significant walk to the first stop.',
  },
  [Language.KHMER]: {
    yourLocation: 'ទីតាំងរបស់អ្នក',
    destination: 'គោលដៅ',
    walking: 'ការដើរ',
    longWalkWarning: (meters: number) =>
      `ចម្ងាយដើរឆ្ងាយ៖ សរុប ${meters} ម៉ែត្រ`,
    significantWalkToFirstStop:
      'ចំណាំ៖ ផ្លូវនេះត្រូវការការដើរច្រើនទៅកាន់ចំណតដំបូង។',
  },
} as const;

// Fixed UI strings for a language, defaulting to Khmer (the historical
// behaviour) for any unexpected/empty value.
function ui(language: Language) {
  return UI_STRINGS[language] ?? UI_STRINGS[Language.KHMER];
}

// Pick a stop's name in the requested language. English → Latin transliteration,
// otherwise the Khmer name.
function stopName(info: StopInfo, language: Language): string {
  return language === Language.ENGLISH ? info.nameInLatin : info.nameInKhmer;
}

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
  // Moving time between consecutive stops plus dwell at the arrival stop.
  // Including dwell here makes every accumulator in the RAPTOR forward pass
  // (rideMinutesFromBoard, ridePrefixMinutes) match what a real bus does on
  // the road. The small overcount at the final alight stop — where the user
  // exits before the bus dwells — biases predicted arrivals slightly late
  // rather than early, which is the safer direction.
  const moveMin =
    (bestDistMeters(stop, prev) / 1000 / BUS_ROUTING_SPEED_KMH) * 60;
  return moveMin + DWELL_TIME_MIN;
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

// Decide when the user actually boards. Tries each live bus ETA in order; if
// every visible bus is already past `earliestBoard` (i.e. the user can't catch
// any of them), falls back to one of two projections:
//
//   1. ANCHORED projection (preferred) — `anchoredNextLapArrivalMinutes` is the
//      projected arrival of the next bus at this stop, derived from the last
//      observed departure from the route's first stop plus `headway` plus the
//      ride-time prefix. This value is stable across requests (it doesn't
//      slide with wall-clock), so option totals don't oscillate when no live
//      bus is catchable.
//
//   2. WALL-CLOCK projection (fallback when no anchor is available) — the
//      original behaviour: project the last visible ETA forward by `headway`.
//
// Both projections add additional `+headway` steps until they meet
// `earliestBoardMinutes`, so very long walks still land on a real future
// arrival rather than something in the past.
function pickBoardTime(
  busEtas: BusEta[],
  headwayMinutes: number,
  earliestBoardMinutes: number,
  anchoredNextLapArrivalMinutes?: number,
): {
  boardTime: number;
  hasLiveEta: boolean;
  busId?: string;
  tripId?: string;
} {
  const catchable = busEtas.find((e) => e.eta >= earliestBoardMinutes);
  if (catchable !== undefined) {
    return {
      boardTime: catchable.eta,
      hasLiveEta: true,
      busId: catchable.busId,
      tripId: catchable.tripId,
    };
  }
  if (
    anchoredNextLapArrivalMinutes !== undefined &&
    Number.isFinite(anchoredNextLapArrivalMinutes)
  ) {
    let projected = anchoredNextLapArrivalMinutes;
    while (projected < earliestBoardMinutes) projected += headwayMinutes;
    return { boardTime: projected, hasLiveEta: false };
  }
  const base = busEtas.length > 0 ? busEtas[busEtas.length - 1].eta : 0;
  let projected = base + headwayMinutes;
  while (projected < earliestBoardMinutes) projected += headwayMinutes;
  return { boardTime: projected, hasLiveEta: false };
}

/**
 * Project the next lap's arrival at `stopIdx` in minutes from `nowMs`, given
 * a wall-clock anchor (the last observed departure from the route's first
 * stop) and the route's headway + ride-time prefix.
 *
 * Returns `undefined` when the inputs are insufficient, so the caller can fall
 * back to the original wall-clock projection inside `pickBoardTime`.
 */
function anchoredArrivalMinutes(
  anchorMs: number | undefined,
  nowMs: number,
  headwayMinutes: number,
  ridePrefix: number[] | undefined,
  originalStopCount: number | undefined,
  stopIdxInRoute: number,
): number | undefined {
  if (!anchorMs || !ridePrefix || !originalStopCount) return undefined;
  const idxInLap = stopIdxInRoute % originalStopCount;
  const prefix = ridePrefix[idxInLap];
  if (!Number.isFinite(prefix)) return undefined;
  const anchorOffsetMin = (anchorMs - nowMs) / 60_000;
  return anchorOffsetMin + headwayMinutes + prefix;
}

// Sum minutes spent on a bus across all transit legs in the label chain ending
// at (stopId, round). Used as a tie-breaker when two alight candidates have
// near-equal total times — fewer ride minutes usually means a less circuitous
// transfer choice. Footpath transfers and the origin walk don't add to ride.
function getTotalRideMinutes(
  stopId: string,
  round: number,
  tau: Map<string, number>[],
  labels: Map<string, JourneyLabel>[],
): number {
  let total = 0;
  let curStop = stopId;
  let curRound = round;
  const seen = new Set<string>();
  while (curRound >= 0 && !seen.has(`${curRound}:${curStop}`)) {
    seen.add(`${curRound}:${curStop}`);
    const lbl = labels[curRound]?.get(curStop);
    if (!lbl) break;
    if (lbl.type === 'transit') {
      const arrival = tau[curRound].get(curStop) ?? 0;
      total += Math.max(0, arrival - lbl.boardTime);
      curStop = lbl.boardedAtStopId;
      curRound -= 1;
    } else {
      if (lbl.fromStopId === '__ORIGIN__') break;
      curStop = lbl.fromStopId;
      // footpath labels live in the same round as the transit leg that
      // enabled them, so don't decrement the round here.
    }
  }
  return total;
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class TransitRoutingService {
  private networkCache: {
    stopInfoMap: Map<string, StopInfo>;
    routeInfoMap: Map<string, RouteInfo>;
    routeStopsMap: Map<string, RouteStop[]>;
    stopRoutes: Map<string, string[]>;
    footpaths: Map<string, Footpath[]>;
    validStopsCount: number;
    builtAt: number;
  } | null = null;

  private liveEtaCache: {
    map: Map<string, Map<string, BusEta[]>>;
    builtAt: number;
  } | null = null;

  /**
   * Recent transit options keyed by rounded origin/destination. Re-merged into
   * subsequent plan responses so that an option which falls out of the candidate
   * set on one tick because of live-data jitter still appears on the next tick,
   * preventing visible flicker between (e.g.) 3 and 4 displayed options.
   * Entries older than {@link OPTION_HYSTERESIS_MS} are dropped on read.
   */
  private optionHysteresis = new Map<
    string,
    { options: RawOption[]; storedAt: number }
  >();

  /**
   * Coalesces concurrent network-cache loads. If a request finds memory empty
   * and triggers a Redis-or-build, subsequent concurrent requests await the
   * same promise instead of starting their own rebuild — preventing a thundering
   * herd of Valhalla matrix calls when (e.g.) the cache was just invalidated.
   */
  private networkLoadInFlight: Promise<{
    stopInfoMap: Map<string, StopInfo>;
    routeInfoMap: Map<string, RouteInfo>;
    routeStopsMap: Map<string, RouteStop[]>;
    stopRoutes: Map<string, string[]>;
    footpaths: Map<string, Footpath[]>;
    validStopsCount: number;
    builtAt: number;
  }> | null = null;

  constructor(
    @InjectModel(BusRouteStop.name)
    private readonly busRouteStopModel: Model<BusRouteStop>,
    @InjectModel(BusTrip.name)
    private readonly busTripModel: Model<BusTripDocument>,
    private readonly busLocationService: BusLocationService,
    private readonly valhallaService: ValhallaService,
    private readonly redisService: RedisService,
  ) {}

  /**
   * Invalidate both the in-memory and Redis copies of the network cache.
   * Called from CRUD endpoints on the routing-relevant collections (routes,
   * route stops) so a write is reflected on the very next plan request.
   *
   * Made async so callers can await the Redis DEL — fire-and-forget would
   * race against an immediate subsequent plan request that might re-read the
   * stale key before the delete lands.
   */
  async invalidateNetworkCache(): Promise<void> {
    this.networkCache = null;
    this.liveEtaCache = null;
    // Clear option hysteresis too — stale options were computed against the
    // old network and could reference removed routes/stops if we kept them.
    this.optionHysteresis.clear();
    await this.redisService.del(NETWORK_CACHE_REDIS_KEY);

    // Kick off a background rebuild so the next user-facing plan request
    // doesn't pay the cold-rebuild latency (Valhalla footpath matrix can be
    // tens of seconds on a real-sized network). The promise is coalesced
    // through `networkLoadInFlight`, so even if multiple invalidations or
    // plan requests pile up concurrently, only one rebuild runs.
    void this.getNetwork().catch(() => {});
  }

  /**
   * Stabilise the plan response by merging in any options that were returned
   * within the last {@link OPTION_HYSTERESIS_MS} for the same origin/destination
   * but fell out of this tick's candidate set. Cache key rounds coordinates to
   * ~50 m so trivial GPS jitter from the client doesn't bust the cache.
   *
   * Returns the merged list (current + recently-seen unique-fingerprint) and
   * refreshes the cache with the merged set so re-appearing options keep
   * extending their sticky window.
   */
  private mergeOptionHysteresis(
    origin: Coords,
    destination: Coords,
    current: RawOption[],
    language: Language,
  ): RawOption[] {
    const r = (n: number) => n.toFixed(3);
    // Language is part of the key: cached options carry pre-localized segment
    // names, so a Khmer entry must never be merged into an English response
    // (or vice versa) for the same origin/destination.
    const key = `${r(origin[0])},${r(origin[1])}→${r(destination[0])},${r(destination[1])}|${language}`;
    const now = Date.now();
    const cached = this.optionHysteresis.get(key);

    const currentFps = new Set(current.map((o) => o.fingerprint));
    const merged: RawOption[] = [...current];

    if (cached && now - cached.storedAt < OPTION_HYSTERESIS_MS) {
      for (const stale of cached.options) {
        if (!currentFps.has(stale.fingerprint)) {
          merged.push(stale);
        }
      }
    }

    this.optionHysteresis.set(key, { options: merged, storedAt: now });
    return merged;
  }

  // Returns the live ETA map, reusing a recent snapshot when possible so that
  // back-to-back plan requests see the same bus positions. Without this, two
  // queries seconds apart can produce different transfer choices as buses tick.
  private async getLiveEtaMap(
    routeStopsMap: Map<string, RouteStop[]>,
  ): Promise<Map<string, Map<string, BusEta[]>>> {
    const now = Date.now();
    if (
      this.liveEtaCache &&
      now - this.liveEtaCache.builtAt < LIVE_ETA_CACHE_TTL_MS
    ) {
      return this.liveEtaCache.map;
    }
    const map = await this.computeLiveEtaMap(routeStopsMap);
    this.liveEtaCache = { map, builtAt: now };
    return map;
  }

  // Coordinate Order Verification stub — historically logged a warning when
  // callers accidentally passed [lat, lng]. Kept as a no-op so callsites can
  // continue to declare their coordinate expectations at request boundaries.
  private assertCoords(_c: Coords, _label: string) {
    /* no-op */
  }

  private async getNetwork() {
    const now = Date.now();
    // Hot path: per-instance memory cache. Short TTL because we layer it over
    // a longer-lived Redis snapshot — even on a memory miss we usually hit
    // Redis rather than rebuilding from scratch.
    if (
      this.networkCache &&
      now - this.networkCache.builtAt < NETWORK_CACHE_TTL_MS
    ) {
      return this.networkCache;
    }

    // Coalesce: if a concurrent caller is already loading the network from
    // Redis or rebuilding it, await their promise instead of starting our own.
    // Critical when invalidation kicks off a background warm-up at the same
    // moment user plan requests arrive — without this each request would
    // launch its own Valhalla footpath rebuild.
    if (this.networkLoadInFlight) {
      return this.networkLoadInFlight;
    }

    this.networkLoadInFlight = (async () => {
      try {
        // Warm path: Redis-backed snapshot. Survives process restart and is
        // shared across instances; explicitly evicted by `invalidateNetworkCache`
        // on route/stop CRUD so a write is visible on the next plan request.
        const persisted = await this.readNetworkFromRedis();
        if (persisted) {
          this.networkCache = { ...persisted, builtAt: now };
          return this.networkCache;
        }

        // Cold path: rebuild from Mongo + Valhalla. First request after an
        // invalidation pays the full cost (Valhalla footpath matrix can be
        // tens of seconds on a large network); subsequent requests hit Redis.
        const built = await this.buildNetwork();
        this.networkCache = { ...built, builtAt: now };
        // Fire-and-forget write — a failed write means the next request rebuilds,
        // which is wasteful but not incorrect.
        void this.writeNetworkToRedis(built);
        return this.networkCache;
      } finally {
        // Always clear so the next memory-miss can start a fresh load.
        this.networkLoadInFlight = null;
      }
    })();

    return this.networkLoadInFlight;
  }

  /**
   * Network-build pipeline extracted from `getNetwork` so the Redis warm
   * path can short-circuit it. Footpath construction is the expensive step
   * because it issues batched Valhalla matrix calls; everything else is a
   * straight read from Mongo.
   */
  private async buildNetwork(): Promise<{
    stopInfoMap: Map<string, StopInfo>;
    routeInfoMap: Map<string, RouteInfo>;
    routeStopsMap: Map<string, RouteStop[]>;
    stopRoutes: Map<string, string[]>;
    footpaths: Map<string, Footpath[]>;
    validStopsCount: number;
  }> {
    const { stopInfoMap, routeInfoMap, routeStopsMap, validStopsCount } =
      await this.loadStopData();
    const { stopRoutes } = this.buildStopRouteIndex(routeStopsMap);
    const footpaths = await this.buildFootpaths(stopInfoMap, stopRoutes);

    return {
      stopInfoMap,
      routeInfoMap,
      routeStopsMap,
      stopRoutes,
      footpaths,
      validStopsCount,
    };
  }

  /**
   * Read a previously-persisted network snapshot from Redis and rehydrate
   * the Map structures. Returns null on any cache miss, deserialise error,
   * or missing field — callers fall back to rebuilding from source.
   */
  private async readNetworkFromRedis(): Promise<{
    stopInfoMap: Map<string, StopInfo>;
    routeInfoMap: Map<string, RouteInfo>;
    routeStopsMap: Map<string, RouteStop[]>;
    stopRoutes: Map<string, string[]>;
    footpaths: Map<string, Footpath[]>;
    validStopsCount: number;
  } | null> {
    try {
      const raw = await this.redisService.get<{
        stopInfo: [string, StopInfo][];
        routeInfo: [string, RouteInfo][];
        routeStops: [string, RouteStop[]][];
        stopRoutes: [string, string[]][];
        footpaths: [string, Footpath[]][];
        validStopsCount: number;
      }>(NETWORK_CACHE_REDIS_KEY);
      if (!raw || typeof raw.validStopsCount !== 'number') return null;
      return {
        stopInfoMap: new Map(raw.stopInfo),
        routeInfoMap: new Map(raw.routeInfo),
        routeStopsMap: new Map(raw.routeStops),
        stopRoutes: new Map(raw.stopRoutes),
        footpaths: new Map(raw.footpaths),
        validStopsCount: raw.validStopsCount,
      };
    } catch {
      return null;
    }
  }

  private async writeNetworkToRedis(net: {
    stopInfoMap: Map<string, StopInfo>;
    routeInfoMap: Map<string, RouteInfo>;
    routeStopsMap: Map<string, RouteStop[]>;
    stopRoutes: Map<string, string[]>;
    footpaths: Map<string, Footpath[]>;
    validStopsCount: number;
  }): Promise<void> {
    await this.redisService.set(
      NETWORK_CACHE_REDIS_KEY,
      {
        stopInfo: [...net.stopInfoMap.entries()],
        routeInfo: [...net.routeInfoMap.entries()],
        routeStops: [...net.routeStopsMap.entries()],
        stopRoutes: [...net.stopRoutes.entries()],
        footpaths: [...net.footpaths.entries()],
        validStopsCount: net.validStopsCount,
      },
      NETWORK_CACHE_REDIS_TTL_SECONDS,
    );
  }

  // ─── ETA Computation ──────────────────────────────────────────────────────

  private async computeLiveEtaMap(
    routeStopsMap: Map<string, RouteStop[]>,
  ): Promise<Map<string, Map<string, BusEta[]>>> {
    const etaMap = new Map<string, Map<string, BusEta[]>>();
    const now = Date.now();

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
          // Parked (scheduled) buses sit at stop 0 with a `notDepartingUntilMs`
          // timestamp set by the simulator. Add the remaining queue wait to
          // every projected ETA so the bus appears catchable only after its
          // turn comes — but it does appear, with its own busId, so the
          // frontend can render the "view bus details" button for it.
          const offsetMinutes = pos.notDepartingUntilMs
            ? Math.max(0, (pos.notDepartingUntilMs - now) / 60_000)
            : 0;
          const stopEtas = this.estimateStopEtasForBus(
            busCoords,
            stops,
            pos.currentStopIndex,
          );
          for (const [stopId, etaList] of stopEtas) {
            if (!routeEta.has(stopId)) routeEta.set(stopId, []);
            const target = routeEta.get(stopId)!;
            for (const eta of etaList) {
              target.push({
                eta: eta + offsetMinutes,
                busId: pos.busId,
                tripId: pos.tripId,
              });
            }
          }
        }

        for (const etas of routeEta.values()) {
          etas.sort((a, b) => a.eta - b.eta);
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
      .populate('stop', 'nameInKhmer nameInLatin location')
      .populate('route', 'code name color status headwayMinutes isLine')
      .sort({ route: 1, stopOrder: 1 })
      .lean()
      .exec();

    const validStops = rawStops.filter(
      (s) =>
        s.stop &&
        (s.stop as any).location?.coordinates &&
        s.route &&
        (s.route as any).status === 'active',
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
        nameInKhmer: place.nameInKhmer,
        nameInLatin: place.nameInLatin,
      });

      if (!routeInfoMap.has(routeId)) {
        routeInfoMap.set(routeId, {
          code: route.code,
          name: route.name,
          color: route.color ?? null,
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

      // Compute cumulative ride minutes from stop 0 across the (first lap of)
      // stops. Has to happen BEFORE circular doubling so the prefix represents
      // a single lap; second-lap lookups use `i % originalStopCount`.
      const info = routeInfoMap.get(routeId);
      if (info) {
        const originalLen = stops.length;
        const prefix: number[] = new Array<number>(originalLen);
        prefix[0] = 0;
        for (let i = 1; i < originalLen; i++) {
          prefix[i] = prefix[i - 1] + segTime(stops[i], stops[i - 1]);
        }
        info.ridePrefixMinutes = prefix;
        info.originalStopCount = originalLen;
      }

      // For circular routes (isLine === false), append the stop sequence again
      // so the RAPTOR forward scan can cross the terminal without special-casing.
      // e.g. [A,B,C,D] → [A,B,C,D,A,B,C,D]; a passenger at D can board toward A.
      if (info?.isLine === false) {
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

  private async buildFootpaths(
    stopInfoMap: Map<string, StopInfo>,
    stopRoutes: Map<string, string[]>,
  ): Promise<Map<string, Footpath[]>> {
    const footpaths = new Map<string, Footpath[]>();
    const stopIds = [...stopInfoMap.keys()];

    const stopRouteSets = new Map<string, Set<string>>();
    for (const [stopId, routes] of stopRoutes) {
      stopRouteSets.set(stopId, new Set(routes));
    }

    // First pass: identify candidate pairs via haversine prefilter +
    // route-share exclusion. We still need the haversine cutoff so we don't
    // ask Valhalla for routes between stops on opposite sides of the city.
    const candidatesBySource = new Map<
      string,
      { toStopId: string; distMeters: number }[]
    >();
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

        if (!candidatesBySource.has(aId)) candidatesBySource.set(aId, []);
        if (!candidatesBySource.has(bId)) candidatesBySource.set(bId, []);
        candidatesBySource.get(aId)!.push({ toStopId: bId, distMeters: d });
        candidatesBySource.get(bId)!.push({ toStopId: aId, distMeters: d });
      }
    }

    if (candidatesBySource.size === 0) return footpaths;

    // Second pass: batch Valhalla pedestrian matrix calls. Each batch is a
    // group of source stops (limited by VALHALLA_FOOTPATH_SOURCE_BATCH) and
    // the union of their candidate targets — fewer HTTP round-trips than
    // one-source-per-call without sending an N×N matrix.
    const sourceIds = [...candidatesBySource.keys()];

    for (
      let batchStart = 0;
      batchStart < sourceIds.length;
      batchStart += VALHALLA_FOOTPATH_SOURCE_BATCH
    ) {
      const batchSourceIds = sourceIds.slice(
        batchStart,
        batchStart + VALHALLA_FOOTPATH_SOURCE_BATCH,
      );
      const targetIdSet = new Set<string>();
      for (const sid of batchSourceIds) {
        for (const c of candidatesBySource.get(sid) ?? []) {
          targetIdSet.add(c.toStopId);
        }
      }
      const batchTargetIds = [...targetIdSet];
      const targetIndex = new Map<string, number>();
      batchTargetIds.forEach((id, idx) => targetIndex.set(id, idx));

      const sourceCoords = batchSourceIds.map(
        (id) => stopInfoMap.get(id)!.coordinates,
      );
      const targetCoords = batchTargetIds.map(
        (id) => stopInfoMap.get(id)!.coordinates,
      );

      const matrix = await this.valhallaService.getWalkMatrixFull(
        sourceCoords,
        targetCoords,
      );

      for (let i = 0; i < batchSourceIds.length; i++) {
        const fromId = batchSourceIds[i];
        const candidates = candidatesBySource.get(fromId) ?? [];
        for (const { toStopId, distMeters } of candidates) {
          const tIdx = targetIndex.get(toStopId);
          if (tIdx === undefined) continue;
          const cell = matrix[i]?.[tIdx];
          // Fall back to haversine + constant walk speed when Valhalla can't
          // route between a pair (e.g. unmapped path). Keeps the footpath
          // available rather than silently dropping it.
          const walk =
            cell?.durationSeconds != null
              ? cell.durationSeconds / 60
              : walkMinutes(distMeters, WALK_SPEED_KMH);
          if (!footpaths.has(fromId)) footpaths.set(fromId, []);
          footpaths.get(fromId)!.push({
            toStopId,
            walkMinutes: walk,
            distMeters,
          });
        }
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
    liveEtaMap: Map<string, Map<string, BusEta[]>>,
    stopRoutes: Map<string, string[]>,
    footpaths: Map<string, Footpath[]>,
    routeAnchors: Map<string, number>,
    destSeeds: Map<string, number>,
    nowMs: number,
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

    // Best-known TOTAL journey time (arrival + dest walk) across any stop seen
    // so far. Updated as labels are written. Used to decide whether to admit
    // a "secondary" transit label — a chain that doesn't improve a stop's
    // arrival but DOES produce a competitive total at this dest-walkable stop.
    let bestKnownTotal = Infinity;

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

      const destWalk = destSeeds.get(stopId);
      if (destWalk !== undefined && walkTime + destWalk < bestKnownTotal) {
        bestKnownTotal = walkTime + destWalk;
      }
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
            // Transfer boardings (round > 1) require a larger safety margin
            // before trusting a live ETA — see TRANSFER_UNCERTAINTY_BUFFER_MIN.
            // First boarding from origin (round === 1) uses only MIN_WAIT_MIN
            // because the user controls their own start time precisely.
            const uncertaintyBuffer =
              round > 1 ? TRANSFER_UNCERTAINTY_BUFFER_MIN : 0;
            const minCatchable =
              arrivalPrevRound + MIN_WAIT_MIN + uncertaintyBuffer;
            const busEtas = liveEtaMap.get(routeId)?.get(current.stopId) ?? [];
            const routeInfo = routeInfoMap.get(routeId);
            const headway = routeInfo?.headwayMinutes ?? 30;
            // Project the next-lap arrival from the route's departure anchor;
            // pickBoardTime prefers this over wall-clock projection because
            // the anchor doesn't slide with `now` between requests.
            const anchoredArrival = anchoredArrivalMinutes(
              routeAnchors.get(routeId),
              nowMs,
              headway,
              routeInfo?.ridePrefixMinutes,
              routeInfo?.originalStopCount,
              i,
            );
            const { boardTime: candidateTime, hasLiveEta: candidateLive } =
              pickBoardTime(busEtas, headway, minCatchable, anchoredArrival);

            if (boardedAtIndex === -1 || candidateTime < boardTime) {
              boardedAtIndex = i;
              boardedAtStopId = current.stopId;
              boardTime = candidateTime;
              boardHasLiveEta = candidateLive;
              rideMinutesFromBoard = 0;
            }
          }

          // Step 2 — propagate to stops strictly after the boarding stop.
          // Skipping i === boardedAtIndex avoids writing a stale arrival at the
          // boarding stop (its correct arrival is already in tau[round-1]).
          if (boardedAtIndex !== -1 && i > boardedAtIndex) {
            rideMinutesFromBoard += segTime(stops[i], stops[i - 1]);
            const arrivalOnBus = boardTime + rideMinutesFromBoard;
            const currentTauStar = tauStar.get(current.stopId) ?? Infinity;
            const improvesArrival = arrivalOnBus < currentTauStar;

            if (improvesArrival) {
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

              const destWalk = destSeeds.get(current.stopId);
              if (
                destWalk !== undefined &&
                arrivalOnBus + destWalk < bestKnownTotal
              ) {
                bestKnownTotal = arrivalOnBus + destWalk;
              }
            } else {
              // Secondary label: chain doesn't improve this stop's earliest
              // arrival, but if alighting here yields a competitive TOTAL
              // (arrival + dest walk) we still want the option surfaced so
              // reconstruction can build it. Only writes when this round has
              // no label here yet — a real improvement always wins.
              const destWalk = destSeeds.get(current.stopId);
              if (
                destWalk !== undefined &&
                !labels[round].has(current.stopId) &&
                arrivalOnBus + destWalk < bestKnownTotal
              ) {
                labels[round].set(current.stopId, {
                  type: 'transit',
                  routeId,
                  boardedAtStopId,
                  boardTime,
                  fromStopId: boardedAtStopId,
                  hasLiveEta: boardHasLiveEta,
                });
                bestKnownTotal = arrivalOnBus + destWalk;
              }
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
          const currentTauStar = tauStar.get(fp.toStopId) ?? Infinity;
          const improves = arrivalAtTo < currentTauStar;
          // Relaxation: accept footpath improvements that are slightly worse
          // than the current best arrival. Critical for transfers like
          // 2A → 1A where the via-bus arrival at the transfer stop is just
          // above the direct origin-walk arrival; without relaxation the
          // footpath is silently dropped and round 2 never explores 1A from
          // the transfer stop. We update tauStar to the BETTER of the two,
          // so the strict-improvement invariant for tauStar still holds.
          const relaxed =
            !improves && arrivalAtTo < currentTauStar + FOOTPATH_RELAXATION_MIN;

          if (improves || relaxed) {
            if (improves) {
              tau[round].set(fp.toStopId, arrivalAtTo);
              tauStar.set(fp.toStopId, arrivalAtTo);
            }
            // Always write the walk label so reconstruction has the chain.
            // For relaxed cases, tauStar stays at its better value but the
            // label captures the transfer path that round-2 boarding will
            // attempt from this stop.
            labels[round].set(fp.toStopId, {
              type: 'walk',
              fromStopId: stopId,
              distMeters: fp.distMeters,
            });
            footpathImprovements.add(fp.toStopId);

            const destWalk = destSeeds.get(fp.toStopId);
            if (
              destWalk !== undefined &&
              arrivalAtTo + destWalk < bestKnownTotal
            ) {
              bestKnownTotal = arrivalAtTo + destWalk;
            }
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
    liveEtaMap: Map<string, Map<string, BusEta[]>>,
    stopInfoMap: Map<string, StopInfo>,
    routeAnchors: Map<string, number>,
    nowMs: number,
    language: Language,
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
    // Each entry includes `stopId` (the Place._id) so the client can save the
    // chosen journey as a favorite skeleton without re-resolving stops by name.
    const stopSequence: Array<{
      stopId: string;
      name: string;
      coordinates: Coords;
    }> = [
      {
        stopId: boardedAtStopId,
        name: stopName(boardStop, language),
        coordinates: boardStop.coordinates,
      },
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
          stopId: curr.stopId,
          name: stopName(stopInfo, language),
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
    const routeInfo = routeInfoMap.get(routeId);
    const headway = routeInfo?.headwayMinutes ?? 30;
    // Cache the anchored next-lap arrival on the BoardEdge so the recheck
    // step in applyLiveEtaToOptions can keep using anchored projection
    // (stable across requests) instead of falling back to wall-clock.
    const anchoredArrival = anchoredArrivalMinutes(
      routeAnchors.get(routeId),
      nowMs,
      headway,
      routeInfo?.ridePrefixMinutes,
      routeInfo?.originalStopCount,
      boardIdx,
    );
    const boardEdge: BoardEdge = {
      type: 'board',
      to: onbusNodeId(routeId, boardedAtStopId),
      routeId,
      boardingStopId: boardedAtStopId,
      busEtas: liveEtaMap.get(routeId)?.get(boardedAtStopId) ?? [],
      headwayMinutes: headway,
      hasLiveEta,
      anchoredNextLapArrivalMinutes: anchoredArrival ?? null,
    };

    return {
      type: 'bus',
      route: {
        id: routeId,
        code: routeInfoMap.get(routeId)?.code ?? null,
        name: routeInfoMap.get(routeId)?.name ?? null,
        color: routeInfoMap.get(routeId)?.color ?? null,
      },
      boardAt: {
        stopId: boardedAtStopId,
        name: stopName(boardStop, language),
        coordinates: boardStop.coordinates,
      },
      alightAt: {
        stopId: alightStopId,
        name: stopName(alightStop, language),
        coordinates: alightStop.coordinates,
      },
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
    liveEtaMap: Map<string, Map<string, BusEta[]>>,
    routeAnchors: Map<string, number>,
    nowMs: number,
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
    language: Language,
    topK = 3,
  ): Promise<RawOption[]> {
    const roundLabels = labels[round];
    if (!roundLabels || roundLabels.size === 0) return [];

    type AltLabel = {
      routeId: string;
      boardedAtStopId: string;
      boardTime: number;
      hasLiveEta: boolean;
    };
    type Candidate = {
      stopId: string;
      total: number;
      walkMinutes: number;
      rideMinutes: number;
      // When set, this candidate is an intermediate alight along an existing
      // transit candidate's bus path. RAPTOR didn't write a transit label here
      // (a footpath in an earlier round reached this stop with a better time),
      // but the bus physically passes through, so it's a valid alight option.
      // Reconstruction uses this override to build the bus segment.
      altLabel?: AltLabel;
    };
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
        rideMinutes: getTotalRideMinutes(stopId, round, tau, labels),
      });
    }

    // Surface intermediate stops along each transit candidate's bus path as
    // additional alight options. RAPTOR's labels[round] only records stops
    // whose tauStar was strictly improved this round — stops the bus passes
    // but already had a better arrival from an earlier round (e.g. via a
    // round-1 footpath) won't have a transit label. For alight purposes the
    // user can step off anywhere the bus stops, so we re-scan each chosen
    // route's stop list and add every intermediate stop within destSeeds
    // as an alternate candidate, reusing the same boarding info.
    const labelBasedIds = new Set(candidates.map((c) => c.stopId));
    const intermediateBest = new Map<string, Candidate>();

    for (const cand of candidates) {
      const lbl = roundLabels.get(cand.stopId);
      if (lbl?.type !== 'transit') continue;

      const routeStops = routeStopsMap.get(lbl.routeId) ?? [];
      const boardIdx = routeStops.findIndex(
        (s) => s.stopId === lbl.boardedAtStopId,
      );
      const alightIdx = routeStops.findIndex(
        (s, i) => i > boardIdx && s.stopId === cand.stopId,
      );
      if (boardIdx < 0 || alightIdx <= boardIdx + 1) continue;

      const baseRideToBoard = getTotalRideMinutes(
        lbl.boardedAtStopId,
        round - 1,
        tau,
        labels,
      );

      let rideMin = 0;
      for (let i = boardIdx + 1; i < alightIdx; i++) {
        rideMin += segTime(routeStops[i], routeStops[i - 1]);
        const sid = routeStops[i].stopId;
        if (labelBasedIds.has(sid)) continue;
        const walk = destSeeds.get(sid);
        if (walk === undefined) continue;

        const total = lbl.boardTime + rideMin + walk;
        const existing = intermediateBest.get(sid);
        if (!existing || total < existing.total) {
          intermediateBest.set(sid, {
            stopId: sid,
            total,
            walkMinutes: walk,
            rideMinutes: baseRideToBoard + rideMin,
            altLabel: {
              routeId: lbl.routeId,
              boardedAtStopId: lbl.boardedAtStopId,
              boardTime: lbl.boardTime,
              hasLiveEta: lbl.hasLiveEta,
            },
          });
        }
      }
    }
    candidates.push(...intermediateBest.values());

    // Primary sort: total time. Tie-breaker: among candidates within
    // TIE_DELTA_MIN of the global best, prefer fewer bus-ride minutes —
    // this picks geographically direct transfers when timing is roughly equal.
    // Using a global best (rather than pairwise delta) keeps the comparator
    // transitive, which is required for a well-defined sort.
    if (candidates.length > 1) {
      const bestTotal = Math.min(...candidates.map((c) => c.total));
      candidates.sort((a, b) => {
        const aInTie = a.total - bestTotal <= TIE_DELTA_MIN;
        const bInTie = b.total - bestTotal <= TIE_DELTA_MIN;
        if (aInTie && bInTie) return a.rideMinutes - b.rideMinutes;
        return a.total - b.total;
      });
    }

    // Diagnostic: dump every stop RAPTOR reached by bus in this round, with
    // the destSeeds walk-to-destination (or EXCLUDED if Valhalla put it
    // outside the bestDur+10 window). Use this to figure out why a stop you
    // expected to alight at isn't a candidate.
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
        routeAnchors,
        nowMs,
        valhallaWalkCache,
        language,
        candidate.altLabel,
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
    liveEtaMap: Map<string, Map<string, BusEta[]>>,
    routeAnchors: Map<string, number>,
    nowMs: number,
    valhallaWalkCache: Map<
      string,
      { path: Coords[]; distanceMeters: number; durationSeconds: number } | null
    >,
    language: Language,
    // Used for intermediate-alight candidates where the bus passes through
    // bestStopId but labels[round][bestStopId] doesn't reflect that bus leg
    // (a prior round set a better arrival via a different path). When present,
    // the label lookup at the alight stop is replaced with this synthetic
    // transit label so the bus segment is built correctly.
    alightOverride?: {
      routeId: string;
      boardedAtStopId: string;
      boardTime: number;
      hasLiveEta: boolean;
    },
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

      // For intermediate-alight candidates, the alight stop has no transit
      // label in labels[round] (an earlier-round footpath wrote a better-time
      // walk label). Substitute the synthetic transit label so the first
      // iteration emits a proper bus segment. Subsequent iterations use real
      // labels because either the stop differs or the round has decremented.
      const label: JourneyLabel | undefined =
        currentStopId === bestStopId && currentRound === round && alightOverride
          ? {
              type: 'transit',
              routeId: alightOverride.routeId,
              boardedAtStopId: alightOverride.boardedAtStopId,
              boardTime: alightOverride.boardTime,
              fromStopId: alightOverride.boardedAtStopId,
              hasLiveEta: alightOverride.hasLiveEta,
            }
          : labels[currentRound].get(currentStopId);
      if (!label) break;

      if (label.type === 'walk') {
        const toStop = stopInfoMap.get(currentStopId);
        if (!toStop) return null;

        // Resolve the whole contiguous run of footpath walk labels in this
        // round up-front (by following fromStopId) BEFORE emitting anything.
        //
        // Why: two bus stops that share a name and sit a few dozen metres
        // apart (common for a market with several platforms) can end up with
        // footpath labels pointing at each other — labels[r][P1].from = P2 and
        // labels[r][P2].from = P1. Following them one hop at a time emits a
        // useless P1→P2→P1 "ping-pong" walk and, because the per-round visited
        // guard at the top of this loop trips on the second visit, the loop
        // breaks BEFORE it reaches the __ORIGIN__ label — so the real
        // origin→first-stop walk is dropped entirely. Resolving the run first
        // lets us distinguish a clean chain (ends at __ORIGIN__ or a bus
        // alight) from a cyclic/dead-end one and collapse the latter to a
        // single origin-access walk.
        const runSeen = new Set<string>([currentStopId]);
        let terminus = label.fromStopId; // '__ORIGIN__' | stopId
        let cyclic = false;
        for (;;) {
          if (terminus === '__ORIGIN__') break;
          if (runSeen.has(terminus)) {
            cyclic = true;
            break;
          }
          const next = labels[currentRound].get(terminus);
          if (!next || next.type !== 'walk') break; // bus alight or dead-end
          runSeen.add(terminus);
          terminus = next.fromStopId;
        }

        const terminusLabel =
          terminus === '__ORIGIN__'
            ? undefined
            : labels[currentRound].get(terminus);
        const isTransferWalk = !cyclic && terminusLabel?.type === 'transit';

        if (!isTransferWalk) {
          // Origin-access walk: the run reaches __ORIGIN__, cycles between
          // co-located stops, or dead-ends. In every case the rider simply
          // walks from their origin to this stop — there is no earlier bus on
          // this side of the journey. Emit one clean Valhalla walk and stop
          // the back-trace (dropping any cyclic footpath waypoints).
          const walk = await getWalk(origin, toStop.coordinates);
          const distMeters =
            walk?.distanceMeters ?? haversineMeters(origin, toStop.coordinates);
          const estMinutes = walk
            ? Math.round(walk.durationSeconds / 60) || 1
            : Math.round(walkMinutes(distMeters, WALK_SPEED_KMH)) || 1;
          segmentsRev.push({
            type: 'walk',
            from: { name: ui(language).yourLocation, coordinates: origin },
            to: {
              name: stopName(toStop, language),
              coordinates: toStop.coordinates,
            },
            path: walk?.path ?? [origin, toStop.coordinates],
            distanceMeters: Math.round(distMeters),
            estimatedMinutes: estMinutes,
            isTransfer: false,
          });
          break;
        }

        // Transfer walk: bridge the previous bus's alight stop (terminus) to
        // this stop in a single segment, skipping any intermediate footpath
        // waypoints (they are RAPTOR internals, not user-meaningful).
        const fromStop = stopInfoMap.get(terminus);
        if (!fromStop) return null;

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
          from: {
            name: stopName(fromStop, language),
            coordinates: fromStop.coordinates,
          },
          to: {
            name: stopName(toStop, language),
            coordinates: toStop.coordinates,
          },
          path: walk?.path ?? [fromStop.coordinates, toStop.coordinates],
          distanceMeters: Math.round(distMeters),
          estimatedMinutes: estMinutes,
          isTransfer: true,
        });

        currentStopId = terminus;
        // Do NOT decrement currentRound: footpath walk labels live in the same
        // round as the transit leg that enabled them; the transit branch is the
        // only place that decrements. Decrementing here would skip that bus leg
        // and make the first leg (e.g. Route 2A) disappear.
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
        routeAnchors,
        nowMs,
        language,
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
        name: stopName(destStop, language),
        coordinates: destStop.coordinates,
      },
      to: { name: ui(language).destination, coordinates: destination },
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
  // walk times. RAPTOR used approximate seed times; this is the authoritative
  // pass that decides which bus the user actually boards. Applies to every bus
  // leg in the journey, including ones reached via a transfer.
  private recheckBusCatchability(rawOptions: RawOption[]): void {
    for (const opt of rawOptions) {
      let cumulativeMinutes = 0; // real elapsed time for the user up to each point
      let totalRecalc = 0;
      let busSegmentsSeen = 0;

      for (const seg of opt.segments as any[]) {
        if (seg.type === 'walk') {
          cumulativeMinutes += seg.estimatedMinutes as number;
          totalRecalc += seg.estimatedMinutes as number;
          continue;
        }

        if (seg.type === 'bus') {
          busSegmentsSeen++;
          const boardEdge = seg._boardEdge as BoardEdge | undefined;
          if (boardEdge) {
            // Mirror runRaptor: transfer boardings (any bus after the first)
            // require a larger buffer before trusting a live ETA. The first
            // boarding stays at MIN_WAIT_MIN because the user controls the
            // start time.
            const uncertaintyBuffer =
              busSegmentsSeen > 1 ? TRANSFER_UNCERTAINTY_BUFFER_MIN : 0;
            const earliestBoard =
              cumulativeMinutes + MIN_WAIT_MIN + uncertaintyBuffer;
            const hw = boardEdge.headwayMinutes ?? 30;
            // The anchored next-lap arrival is captured at construction time
            // (in buildRaptorBusSegment) using the same nowMs as the rest of
            // the plan, so reusing it here keeps the recheck result stable
            // even when no live bus is catchable.
            const anchored =
              boardEdge.anchoredNextLapArrivalMinutes ?? undefined;
            const { boardTime, hasLiveEta, busId, tripId } = pickBoardTime(
              boardEdge.busEtas,
              hw,
              earliestBoard,
              anchored,
            );

            seg.waitMinutes = Math.round(
              Math.max(0, boardTime - cumulativeMinutes),
            );
            seg.totalLegMinutes =
              (seg.waitMinutes as number) + (seg.rideMinutes as number);
            seg.hasLiveEta = hasLiveEta;
            // Frontend wires the "view bus details" button to these IDs.
            // Only set on a live boarding — for estimated next-lap the
            // bus isn't yet assigned.
            if (busId !== undefined) seg.busId = busId;
            if (tripId !== undefined) seg.tripId = tripId;

            // Only expose ETAs the user can still catch. The uncatchable buses
            // RAPTOR saw (e.g. one arriving in 3 min when the user needs 9 min
            // to walk there) are useless to the client and confusing if shown
            // as "Bus in ~3 min". Sent as plain numbers — the bus/trip
            // identifiers belong on the segment, not buried per-ETA.
            seg.busEtas = boardEdge.busEtas
              .filter((e) => e.eta >= earliestBoard)
              .map((e) => e.eta);
            // boardTime is in minutes from `now`; this is the single number the
            // client should display as "Bus arrives in N min". Falls back to a
            // headway-projected next-lap arrival when no live bus is catchable.
            seg.nextBusInMinutes = Math.round(boardTime);
            delete seg._boardEdge;
          }

          cumulativeMinutes += seg.totalLegMinutes as number;
          totalRecalc += seg.totalLegMinutes as number;
        }
      }

      opt.totalEstimatedMinutes = Math.round(totalRecalc);
    }
  }

  private addLongWalkMetadata(options: RawOption[], language: Language) {
    for (const opt of options) {
      const firstLeg = opt.segments[0] as any;
      if (
        firstLeg?.type === 'walk' &&
        firstLeg.distanceMeters > LONG_WALK_WARNING_M
      ) {
        opt.warning = ui(language).significantWalkToFirstStop;
      }
    }
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

    // Final ordering: fastest first by actual travel time. The frontend
    // derives any "fastest/slower" labelling from this order itself.
    const display = [...topOptions].sort(
      (a, b) => a.totalEstimatedMinutes - b.totalEstimatedMinutes,
    );

    return {
      found: true as const,
      type: 'transit' as const,
      options: display.map((o) => ({
        totalEstimatedMinutes: o.totalEstimatedMinutes,
        totalDistanceMeters: o.totalDistanceMeters,
        totalWalkMeters: o.totalWalkMeters,
        transferCount: o.transferCount,
        warning: o.warning,
        segments: o.segments,
      })),
    };
  }

  async planRoute(
    origin: Coords,
    destination: Coords,
    type: 'walk' | 'transit' = 'transit',
    language: Language = Language.KHMER,
  ) {
    if (type === 'walk')
      return this.planWalkRoute(origin, destination, language);
    return this.planTransitRoute(origin, destination, language);
  }

  // ─── Favorite (skeleton-based) replan ───────────────────────────────────────
  // The user saved a journey as { origin, destination, legs:[{route, board, alight}] }.
  // On open we rebuild a fully-formed transit option from that skeleton: walk legs
  // are recomputed via Valhalla, ride times come from the live network, and bus
  // ETAs / wait times are derived from the current liveEtaMap + anchors.
  // Returns null when any referenced route/stop no longer exists on the route, so
  // the caller can surface a 410 Gone to prompt the user to re-save.
  async replanFromSkeleton(
    skeleton: {
      origin: Coords;
      destination: Coords;
      legs: Array<{
        routeId: string;
        boardStopId: string;
        alightStopId: string;
      }>;
    },
    language: Language = Language.KHMER,
  ): Promise<{
    totalEstimatedMinutes: number;
    totalDistanceMeters: number;
    totalWalkMeters: number;
    transferCount: number;
    warning?: string;
    segments: any[];
  } | null> {
    this.assertCoords(skeleton.origin, 'replanFromSkeleton: origin');
    this.assertCoords(skeleton.destination, 'replanFromSkeleton: destination');
    if (skeleton.legs.length === 0) return null;

    const network = await this.getNetwork();
    if (network.validStopsCount === 0 || network.routeStopsMap.size === 0) {
      return null;
    }

    // Validate every leg against the current network. Any miss → stale favorite.
    type ResolvedLeg = {
      routeId: string;
      boardStopId: string;
      alightStopId: string;
      boardIdx: number;
      alightIdx: number;
    };
    const resolved: ResolvedLeg[] = [];
    for (const leg of skeleton.legs) {
      const stops = network.routeStopsMap.get(leg.routeId);
      if (!stops || stops.length < 2) return null;
      const boardIdx = stops.findIndex((s) => s.stopId === leg.boardStopId);
      if (boardIdx < 0) return null;
      const alightIdx = stops.findIndex(
        (s, i) => i > boardIdx && s.stopId === leg.alightStopId,
      );
      if (alightIdx <= boardIdx) return null;
      resolved.push({
        ...leg,
        boardIdx,
        alightIdx,
      });
    }

    const liveEtaMap = await this.getLiveEtaMap(network.routeStopsMap);
    const nowMs = Date.now();
    const routeAnchors = await this.busLocationService.getRouteDepartureAnchors(
      [...network.routeStopsMap.keys()],
    );

    const walkCache = new Map<
      string,
      { path: Coords[]; distanceMeters: number; durationSeconds: number } | null
    >();
    const pairKey = (from: Coords, to: Coords) =>
      `${from[0].toFixed(5)},${from[1].toFixed(5)}→${to[0].toFixed(5)},${to[1].toFixed(5)}`;
    const getWalk = async (from: Coords, to: Coords) => {
      const key = pairKey(from, to);
      if (walkCache.has(key)) return walkCache.get(key)!;
      this.assertCoords(from, 'replanFromSkeleton: walk from');
      this.assertCoords(to, 'replanFromSkeleton: walk to');
      const result = await this.valhallaService.getWalkPath(from, to);
      walkCache.set(key, result);
      return result;
    };

    const buildWalkSegment = async (
      from: { name: string; coordinates: Coords },
      to: { name: string; coordinates: Coords },
      isTransfer: boolean,
    ) => {
      const walk = await getWalk(from.coordinates, to.coordinates);
      const distMeters =
        walk?.distanceMeters ??
        haversineMeters(from.coordinates, to.coordinates);
      const estMinutes = walk
        ? Math.round(walk.durationSeconds / 60) || 1
        : Math.round(walkMinutes(distMeters, WALK_SPEED_KMH)) || 1;
      return {
        seg: {
          type: 'walk' as const,
          from,
          to,
          path: walk?.path ?? [from.coordinates, to.coordinates],
          distanceMeters: Math.round(distMeters),
          estimatedMinutes: estMinutes,
          isTransfer,
        },
        minutes: estMinutes,
      };
    };

    const segments: any[] = [];
    let cumMinutes = 0;
    let totalDistanceMeters = 0;
    let totalWalkMeters = 0;

    // 1) Origin walk → first board stop.
    {
      const firstBoardId = resolved[0].boardStopId;
      const firstBoard = network.stopInfoMap.get(firstBoardId);
      if (!firstBoard) return null;
      const { seg, minutes } = await buildWalkSegment(
        { name: ui(language).yourLocation, coordinates: skeleton.origin },
        {
          name: stopName(firstBoard, language),
          coordinates: firstBoard.coordinates,
        },
        false,
      );
      segments.push(seg);
      cumMinutes += minutes;
      totalDistanceMeters += seg.distanceMeters;
      totalWalkMeters += seg.distanceMeters;
    }

    // 2) Per-leg: bus segment, then transfer walk to the next board stop.
    for (let i = 0; i < resolved.length; i++) {
      const leg = resolved[i];
      const stops = network.routeStopsMap.get(leg.routeId)!;
      const boardStop = network.stopInfoMap.get(leg.boardStopId);
      const alightStop = network.stopInfoMap.get(leg.alightStopId);
      if (!boardStop || !alightStop) return null;

      const routeInfo = network.routeInfoMap.get(leg.routeId);
      const headway = routeInfo?.headwayMinutes ?? 30;
      const busEtas = liveEtaMap.get(leg.routeId)?.get(leg.boardStopId) ?? [];

      // First leg is the user's own start — only MIN_WAIT_MIN buffer; subsequent
      // legs are transfers and need the uncertainty buffer.
      const uncertaintyBuffer = i > 0 ? TRANSFER_UNCERTAINTY_BUFFER_MIN : 0;
      const earliestBoardMinutes =
        cumMinutes + MIN_WAIT_MIN + uncertaintyBuffer;

      const anchoredArrival = anchoredArrivalMinutes(
        routeAnchors.get(leg.routeId),
        nowMs,
        headway,
        routeInfo?.ridePrefixMinutes,
        routeInfo?.originalStopCount,
        leg.boardIdx,
      );
      const { boardTime, hasLiveEta } = pickBoardTime(
        busEtas,
        headway,
        earliestBoardMinutes,
        anchoredArrival,
      );

      // Build ride: sum distance + minutes between consecutive stops, collect
      // intermediate stops, and concatenate per-segment polylines into busPath.
      let rideDistance = 0;
      let rideMinutes = 0;
      const stopSequence: Array<{
        stopId: string;
        name: string;
        coordinates: Coords;
      }> = [
        {
          stopId: leg.boardStopId,
          name: stopName(boardStop, language),
          coordinates: boardStop.coordinates,
        },
      ];
      const busPath: [number, number][] = [
        boardStop.coordinates as [number, number],
      ];
      for (let k = leg.boardIdx + 1; k <= leg.alightIdx; k++) {
        const prev = stops[k - 1];
        const curr = stops[k];
        rideDistance += bestDistMeters(curr, prev);
        rideMinutes += segTime(curr, prev);
        const info = network.stopInfoMap.get(curr.stopId);
        if (info) {
          stopSequence.push({
            stopId: curr.stopId,
            name: stopName(info, language),
            coordinates: info.coordinates,
          });
        }
        if (curr.segmentPathCoords && curr.segmentPathCoords.length > 1) {
          busPath.push(...curr.segmentPathCoords.slice(1));
        } else if (info) {
          busPath.push(info.coordinates as [number, number]);
        }
      }

      const waitMinutes = Math.max(0, boardTime - cumMinutes);
      const roundedWait = Math.round(waitMinutes);
      const roundedRide = Math.max(1, Math.round(rideMinutes));

      const boardEdge: BoardEdge = {
        type: 'board',
        to: onbusNodeId(leg.routeId, leg.boardStopId),
        routeId: leg.routeId,
        boardingStopId: leg.boardStopId,
        busEtas,
        headwayMinutes: headway,
        hasLiveEta,
        anchoredNextLapArrivalMinutes: anchoredArrival ?? null,
      };

      const busSeg = {
        type: 'bus' as const,
        route: {
          id: leg.routeId,
          code: routeInfo?.code ?? null,
          name: routeInfo?.name ?? null,
          color: routeInfo?.color ?? null,
        },
        boardAt: {
          stopId: leg.boardStopId,
          name: stopName(boardStop, language),
          coordinates: boardStop.coordinates,
        },
        alightAt: {
          stopId: leg.alightStopId,
          name: stopName(alightStop, language),
          coordinates: alightStop.coordinates,
        },
        intermediateStops: stopSequence.slice(1, -1),
        path: busPath,
        distanceMeters: Math.round(rideDistance),
        waitMinutes: roundedWait,
        rideMinutes: roundedRide,
        totalLegMinutes: roundedWait + roundedRide,
        estimatedMinutes: roundedRide,
        hasLiveEta,
        _boardEdge: boardEdge,
      };

      segments.push(busSeg);
      totalDistanceMeters += busSeg.distanceMeters;
      cumMinutes = boardTime + rideMinutes;

      // Transfer walk to the next leg's board stop.
      if (i < resolved.length - 1) {
        const nextBoard = network.stopInfoMap.get(resolved[i + 1].boardStopId);
        if (!nextBoard) return null;
        const { seg, minutes } = await buildWalkSegment(
          {
            name: stopName(alightStop, language),
            coordinates: alightStop.coordinates,
          },
          {
            name: stopName(nextBoard, language),
            coordinates: nextBoard.coordinates,
          },
          true,
        );
        segments.push(seg);
        cumMinutes += minutes;
        totalDistanceMeters += seg.distanceMeters;
        totalWalkMeters += seg.distanceMeters;
      }
    }

    // 3) Last-mile walk: last alight stop → destination.
    {
      const last = resolved[resolved.length - 1];
      const lastAlight = network.stopInfoMap.get(last.alightStopId);
      if (!lastAlight) return null;
      const { seg, minutes } = await buildWalkSegment(
        {
          name: stopName(lastAlight, language),
          coordinates: lastAlight.coordinates,
        },
        { name: ui(language).destination, coordinates: skeleton.destination },
        false,
      );
      segments.push(seg);
      cumMinutes += minutes;
      totalDistanceMeters += seg.distanceMeters;
      totalWalkMeters += seg.distanceMeters;
    }

    const warning =
      totalWalkMeters > LONG_WALK_WARNING_M
        ? ui(language).longWalkWarning(Math.round(totalWalkMeters))
        : undefined;

    return {
      totalEstimatedMinutes: Math.round(cumMinutes),
      totalDistanceMeters: Math.round(totalDistanceMeters),
      totalWalkMeters: Math.round(totalWalkMeters),
      transferCount: Math.max(0, resolved.length - 1),
      warning,
      segments,
    };
  }

  private async planWalkRoute(
    origin: Coords,
    destination: Coords,
    language: Language,
  ) {
    this.assertCoords(origin, 'planWalkRoute: origin');
    this.assertCoords(destination, 'planWalkRoute: destination');

    // Valhalla is required here — the fallback (straight-line haversine)
    // draws a path through buildings/rivers, which is worse than a clean
    // error. Throw so the frontend can show a proper outage state instead
    // of a broken map.
    const valhallaResult = await this.valhallaService.getWalkPath(
      origin,
      destination,
    );
    if (!valhallaResult) {
      throw new ServiceUnavailableException(
        'Walking route unavailable — routing engine did not respond.',
      );
    }

    const distanceMeters = valhallaResult.distanceMeters;
    const estimatedMinutes =
      Math.round(valhallaResult.durationSeconds / 60) || 1;

    return {
      found: true,
      type: 'walk',
      options: [
        {
          type: 'walk',
          label: ui(language).walking,
          totalEstimatedMinutes: estimatedMinutes,
          totalDistanceMeters: Math.round(distanceMeters),
          totalWalkMeters: Math.round(distanceMeters),
          transferCount: 0,
          segments: [
            {
              type: 'walk',
              from: { name: ui(language).yourLocation, coordinates: origin },
              to: { name: ui(language).destination, coordinates: destination },
              path: valhallaResult.path,
              distanceMeters: Math.round(distanceMeters),
              estimatedMinutes,
            },
          ],
        },
      ],
    };
  }

  private async planTransitRoute(
    origin: Coords,
    destination: Coords,
    language: Language,
  ) {
    this.assertCoords(origin, 'planTransitRoute: origin');
    this.assertCoords(destination, 'planTransitRoute: destination');

    // Distinguish "network can't load" (Mongo/Redis outage) from "no stops
    // seeded" (a data-state condition the frontend should treat as an empty
    // result). getNetwork throws when its DB / Valhalla footpath build fails;
    // rethrow as 503 so the client sees a clear service-availability error
    // instead of the "no route found" empty payload.
    let network;
    try {
      network = await this.getNetwork();
    } catch {
      throw new ServiceUnavailableException(
        'Transit network temporarily unavailable — try again shortly.',
      );
    }
    if (network.validStopsCount === 0 || network.routeStopsMap.size === 0) {
      return { found: false as const, type: 'transit' as const, options: [] };
    }

    const liveEtaMap = await this.getLiveEtaMap(network.routeStopsMap);
    // Capture a single `now` for the whole request — every relative-time
    // calculation downstream (live ETAs, anchor projections, RAPTOR labels)
    // must use the same epoch or anchored projections would drift mid-plan.
    const nowMs = Date.now();
    const routeAnchors = await this.busLocationService.getRouteDepartureAnchors(
      [...network.routeStopsMap.keys()],
    );

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
      return { found: false as const, type: 'transit' as const, options: [] };
    }

    // Expand search radius each attempt until a valid transit route is found
    // AND the result quality is "good enough" by network-shape signals.
    //
    // Stop conditions, in priority order:
    //   1. Final radius (Infinity) — nothing left to expand to.
    //   2. Monotonicity: this radius added zero new seed stops vs. the previous
    //      attempt. RAPTOR would explore the same network and return the same
    //      options, so further expansion is guaranteed pointless. Critical when
    //      the user is genuinely far from the network (e.g. closest stop 1200 m
    //      means every radius >= 2 km finds only that one stop).
    //   3. Quality good enough: at least one option is a direct route AND
    //      wait time is < 50 % of total. Wider radius unlikely to help.
    //
    // We accumulate the latest successful result in `lastResult` and return it
    // when the loop exits — each larger radius is a superset of the previous
    // exploration, so the latest non-empty result is at least as good as any
    // earlier one.
    let prevSeedSize = -1;
    let lastResult: RawOption[] | null = null;

    for (let attempt = 0; attempt < ORIGIN_RADII_M.length; attempt++) {
      const radiusM = ORIGIN_RADII_M[attempt];

      const originSeeds = await this.resolveAccessStop(
        origin,
        network.routeStopsMap,
        valhallaWalkCache,
        radiusM,
        'origin',
      );

      if (originSeeds.size === 0) continue;

      // Monotonicity stop: same-or-smaller seed set than the previous attempt
      // means this iteration is redundant. `ORIGIN_RADII_M` is monotonic so
      // size cannot shrink; equality means no new stops are reachable.
      if (prevSeedSize > 0 && originSeeds.size <= prevSeedSize) break;
      prevSeedSize = originSeeds.size;

      const { tau, labels } = this.runRaptor(
        originSeeds,
        network.routeStopsMap,
        network.stopInfoMap,
        network.routeInfoMap,
        liveEtaMap,
        network.stopRoutes,
        network.footpaths,
        routeAnchors,
        destSeeds,
        nowMs,
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
          routeAnchors,
          nowMs,
          destSeeds,
          valhallaWalkCache,
          language,
        );
        rawOptions.push(...opts);
      }

      if (rawOptions.length === 0) continue;

      this.recheckBusCatchability(rawOptions);

      const seen = new Set<string>();
      const finalOptions = rawOptions
        .filter((o) => {
          if (seen.has(o.fingerprint)) return false;
          seen.add(o.fingerprint);
          return true;
        })
        .filter((o) => o.segments.some((s) => s.type === 'bus'));

      if (finalOptions.length === 0) continue;

      lastResult = finalOptions;

      // Quality check: stop expanding once we have at least one option that
      // is direct (transferCount < 2) AND mostly motion (wait <= 50% of total).
      // Otherwise the wider radius might surface a more direct route or one
      // with denser coverage.
      const allNeedManyTransfers = finalOptions.every(
        (o) => o.transferCount >= 2,
      );
      const allHaveHighWait = finalOptions.every((o) => {
        const wait = (o.segments as any[])
          .filter((s) => s.type === 'bus')
          .reduce(
            (sum: number, s: any) => sum + ((s.waitMinutes as number) ?? 0),
            0,
          );
        const total = o.totalEstimatedMinutes;
        return total > 0 && wait / total > 0.5;
      });

      if (!(allNeedManyTransfers || allHaveHighWait)) break;
    }

    if (lastResult) {
      // Merge with recent options for the same origin/destination so options
      // that were just returned don't disappear because live-data jitter
      // pushed them out of qualification this tick. See OPTION_HYSTERESIS_MS.
      const stabilised = this.mergeOptionHysteresis(
        origin,
        destination,
        lastResult,
        language,
      );
      this.addLongWalkMetadata(stabilised, language);
      return this.mapTransitSuccessResponse(stabilised);
    }

    // All radii exhausted — no transit route reachable. Return found:false so
    // the frontend can handle this case (e.g. show "no nearby stops" message).
    // Never return a walk plan here: the user explicitly requested transit.
    return { found: false as const, type: 'transit' as const, options: [] };
  }
}
