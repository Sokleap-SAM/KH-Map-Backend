import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { BusTrip, BusTripDocument } from './entities/bus-trip.schema';
import { BusRouteStopService } from './bus-route-stop.service';
import { BusLocationService } from './bus-location.service';
import { BusTripService, TripLiveData } from './bus-trip.service';
import { BusRouteStop } from './entities/bus-route-stop.schema';
import { privateEncrypt } from 'crypto';

// ─── Tunable constants ────────────────────────────────────────────────────────

/**
 * Wall-clock interval between position updates (ms).
 * setInterval gives a fixed period independent of processing duration.
 * Use the \processing\ guard to drop overlapping ticks when load is high.
 */
const TICK_MS = 1_000;

/**
 * Simulated bus speed (km/h).
 * 30 km/h is a realistic urban city-bus average.
 * Metres moved per tick = (30 × 1000 / 3600) × 1 s ≈ 8.3 m
 */
const BUS_SPEED_KMH = 30;
const SPEED_M_PER_TICK = (BUS_SPEED_KMH * 1_000) / 3_600; // ≈ 8.3 m

/**
 * Re-sync the active-trip list from MongoDB every N ticks.
 * Picks up newly started trips without querying DB on every single tick.
 */
const SYNC_EVERY_N_TICKS = 5;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Live movement state kept in memory for each active trip. */
interface TripSimState {
  tripId: string;
  busId: string;
  routeId: string;
  pos: [number, number]; // current [lng, lat]
  currentStopIdx: number;
  nextStopIdx: number;
  passengerCount: number;
  waypointIdx: number; // index into segmentCoords the bus is heading toward
  segmentCoords: [number, number][]; // road waypoints for the current inter-stop segment
  currentPos: [number, number];
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

/** Extract [lng, lat] from a populated stop document. */
function stopCoords(stop: BusRouteStop['stop']): [number, number] {
  const place = stop as unknown as {
    location: { coordinates: [number, number] };
  };
  return place.location.coordinates;
}

function haversineMeters(
  [lng1, lat1]: [number, number],
  [lng2, lat2]: [number, number],
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function computeHeading(
  [lng1, lat1]: [number, number],
  [lng2, lat2]: [number, number],
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class BusSimulationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BusSimulationService.name);

  /** Live movement state per active trip (keyed by tripId). */
  private readonly trips = new Map<string, TripSimState>();

  /** Route stop lists — loaded once per route and reused across ticks. */
  private readonly routeStopCache = new Map<string, BusRouteStop[]>();

  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  /** Prevents a slow tick from stacking behind a queued setInterval callback. */
  private processing = false;
  private _running = false;

  constructor(
    @InjectModel(BusTrip.name)
    private readonly busTripModel: Model<BusTripDocument>,
    private readonly busRouteStopService: BusRouteStopService,
    private readonly busLocationService: BusLocationService,
    private readonly busTripService: BusTripService,
  ) { }

  onModuleInit(): void {
    this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /** Start the simulation loop. No-op if already running. */
  start(): void {
    if (this._running) return;
    this._running = true;
    this.tickCount = 0;
    this.intervalHandle = setInterval(() => void this.runTick(), TICK_MS);
    this.logger.log(
      `Simulation started — tick=${TICK_MS} ms, speed=${BUS_SPEED_KMH} km/h (${SPEED_M_PER_TICK.toFixed(1)} m/tick)`,
    );
  }

  /** Stop the loop and clear all in-memory state. No-op if already stopped. */
  stop(): void {
    if (!this._running) return;
    this._running = false;
    clearInterval(this.intervalHandle!);
    this.intervalHandle = null;
    this.trips.clear();
    this.routeStopCache.clear();
    this.logger.log('Simulation stopped');
  }

  get running(): boolean {
    return this._running;
  }

  get activeTripCount(): number {
    return this.trips.size;
  }

  // ─── Tick ──────────────────────────────────────────────────────────────────

  private async runTick(): Promise<void> {
    if (this.processing) return; // drop tick if previous still in-flight
    this.processing = true;
    this.tickCount++;

    try {
      if (this.tickCount % SYNC_EVERY_N_TICKS === 1) {
        await this.syncActiveTrips();
      }
      if (this.trips.size === 0) return;
      await Promise.all(
        Array.from(this.trips.values()).map((s) => this.advanceBus(s)),
      );
    } catch (err) {
      this.logger.error('Tick error', err);
    } finally {
      this.processing = false;
    }
  }

  // ─── Trip registry ─────────────────────────────────────────────────────────

  /**
   * Pull the current `in-progress` trip list from DB.
   * Evict trips that are no longer active; initialise any that are new.
   */
  private async syncActiveTrips(): Promise<void> {
    const active = await this.busTripModel
      .find({ status: 'in-progress' })
      .lean()
      .exec();

    const activeIds = new Set(active.map((t) => String(t._id)));

    // Evict trips no longer in-progress
    for (const id of this.trips.keys()) {
      if (!activeIds.has(id)) {
        this.trips.delete(id);
        this.logger.verbose(`Evicted trip ${id}`);
      }
    }

    // Initialise newly discovered trips
    await Promise.all(
      active
        .filter((t) => !this.trips.has(String(t._id)))
        .map((t) =>
          this.initTrip(
            t as unknown as BusTripDocument & { _id: Types.ObjectId },
          ),
        ),
    );

    if (active.length > 0) {
      this.logger.debug(`Tracking ${this.trips.size}/${active.length} trips`);
    }
  }

  /**
   * Build the in-memory state for a trip.
   * Resumes from Redis if live data exists; otherwise starts from the first stop.
   */
  private async initTrip(
    trip: BusTripDocument & { _id: Types.ObjectId },
  ): Promise<void> {
    const tripId = String(trip._id);
    const routeId = String(trip.route);
    const stops = await this.getRouteStops(routeId);

    if (stops.length === 0) {
      this.logger.warn(
        `Route ${routeId} has no stops — skipping trip ${tripId}`,
      );
      return;
    }

    const live = await this.busTripService.getLiveData(tripId);
    // Treat live data as stale if indices are out-of-bounds (e.g. after a reset)
    const isStale = !live || live.nextStopIndex >= stops.length;

    let pos: [number, number];
    let currentStopIdx: number;
    let nextStopIdx: number;
    let passengerCount: number;

    if (isStale) {
      pos = stopCoords(stops[0].stop);
      currentStopIdx = 0;
      nextStopIdx = stops.length > 1 ? 1 : 0;
      passengerCount = 0;
      const meta = this.getLiveMetadata(pos);
      // Seed Redis so the bus is visible before the first tick fires
      await this.busTripService.setLiveData(tripId, {
        currentStopIndex: currentStopIdx,
        nextStopIndex: nextStopIdx,
        passengerCount,
        longitude: pos[0],
        latitude: pos[1],
        ...meta
      });
    } else {
      pos = [live.longitude, live.latitude];
      currentStopIdx = live.currentStopIndex;
      nextStopIdx = live.nextStopIndex;
      passengerCount = live.passengerCount;
    }

    this.trips.set(tripId, {
      tripId,
      busId: String(trip.bus),
      routeId: String(trip.route),
      pos: pos as [number, number],
      currentStopIdx,
      nextStopIdx,
      passengerCount,
      waypointIdx: 1,
      segmentCoords: this.buildSegmentCoords(stops, nextStopIdx, pos as [number, number]),
      currentPos: pos as [number, number],
    });

    this.logger.verbose(
      `Trip ${tripId} initialised at stop ${currentStopIdx}→${nextStopIdx}${isStale ? ' (reset)' : ''}`,
    );
  }

  // ─── Per-bus movement ──────────────────────────────────────────────────────

  private async advanceBus(state: TripSimState): Promise<void> {
    // Skip if this trip was evicted during a concurrent tick
    if (!this.trips.has(state.tripId)) return;

    const stops = this.routeStopCache.get(state.routeId);
    if (!stops) return;

    const oldPos = [...state.pos] as [number, number];

    if (state.nextStopIdx >= stops.length) {
      await this.completeTrip(state, stops);
      return;
    }

    // Move the bus along the waypoint chain by SPEED_M_PER_TICK metres
    let { pos, waypointIdx } = state;
    const { segmentCoords } = state;
    let remaining = SPEED_M_PER_TICK;

    while (remaining > 0) {
      if (waypointIdx >= segmentCoords.length) {
        await this.arriveAtStop(state, stops);
        return;
      }

      const heading = this.headingFromState(segmentCoords, pos, waypointIdx);
      const busImage = pos[0] < oldPos[0] ? 'bus_go_left.png' : 'bus_go_right.png';

      state.pos = pos;
      state.waypointIdx = waypointIdx; 
      const target = segmentCoords[waypointIdx];
      const dist = haversineMeters(pos, target);

      if (dist <= remaining) {
        // Reached this waypoint — continue toward the next
        pos = target;
        remaining -= dist;
        waypointIdx++;
      } else {
        // Partial move toward this waypoint
        const ratio = remaining / dist;
        pos = [
          pos[0] + (target[0] - pos[0]) * ratio,
          pos[1] + (target[1] - pos[1]) * ratio,
        ];
        remaining = 0;
      }
    }

    const heading = this.headingFromState(segmentCoords, pos, waypointIdx);

    state.pos = pos;
    state.waypointIdx = waypointIdx;
    const meta = this.getLiveMetadata(pos);

    // Publish to Redis
    const liveData: TripLiveData = {
      currentStopIndex: state.currentStopIdx,
      nextStopIndex: state.nextStopIdx,
      passengerCount: state.passengerCount,
      longitude: pos[0],
      latitude: pos[1],
      ...meta,
    };
    await this.busTripService.setLiveData(state.tripId, liveData);

    // Write GPS history (fire-and-forget — does not block the tick)
    this.busLocationService
      .reportLocation({
        busId: state.busId,
        tripId: state.tripId,
        routeId: state.routeId,
        longitude: pos[0],
        latitude: pos[1],
        heading,
        speed: Math.round(BUS_SPEED_KMH),
      })
      .catch((err: unknown) => this.logger.error('reportLocation failed', err));
  }

  /** Snap bus to the arrived stop, then load the next segment. */
  private async arriveAtStop(
    state: TripSimState,
    stops: BusRouteStop[],
  ): Promise<void> {
    const newCurrentStopIdx = state.nextStopIdx;
    const newNextStopIdx = newCurrentStopIdx + 1;

    if (newNextStopIdx >= stops.length) {
      state.currentStopIdx = newCurrentStopIdx;
      state.nextStopIdx = newNextStopIdx;
      await this.completeTrip(state, stops);
      return;
    }

    const stopPos = stopCoords(stops[newCurrentStopIdx].stop);
    state.currentPos = stopPos;

    state.currentStopIdx = newCurrentStopIdx;
    state.nextStopIdx = newNextStopIdx;

    state.segmentCoords = this.buildSegmentCoords(stops, newNextStopIdx, stopPos);
    state.waypointIdx = 1;

    const prevPos = state.currentPos;
    const pos = state.segmentCoords[state.waypointIdx];
    state.currentPos = pos;

    await this.busTripService.setLiveData(state.tripId, {
      currentStopIndex: newCurrentStopIdx,
      nextStopIndex: newNextStopIdx,
      passengerCount: state.passengerCount,
      longitude: pos[0],
      latitude: pos[1],
      heading: 0,
      busImage: pos[0] < (prevPos?.[0] ?? pos[0]) ? 'bus_go_left.png' : 'bus_go_right.png',
    });
  }

  /** Reset the trip to `scheduled`, clear Redis live data, and evict from memory. */
  private async completeTrip(
    state: TripSimState,
    stops: BusRouteStop[],
  ): Promise<void> {
    // Restart automatically from the first stop — no manual intervention needed.
    const pos = stopCoords(stops[0].stop);
    const nextStopIdx = stops.length > 1 ? 1 : 0;

    state.pos = pos;
    state.currentStopIdx = 0;
    state.nextStopIdx = nextStopIdx;
    state.waypointIdx = 1;
    state.passengerCount = 0;
    state.segmentCoords = this.buildSegmentCoords(stops, nextStopIdx, pos);

    const meta = this.getLiveMetadata(pos);

    await this.busTripService.setLiveData(state.tripId, {
      currentStopIndex: 0,
      nextStopIndex: nextStopIdx,
      passengerCount: 0,
      longitude: pos[0],
      latitude: pos[1],
      ...meta,
    });

    this.logger.log(`Trip ${state.tripId} completed — looping back to start`);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Calculate heading based on the next waypoint, or the last segment direction. */
  private headingFromState(
    coords: [number, number][],
    pos: [number, number],
    waypointIdx: number,
  ): number {
    if (waypointIdx < coords.length) {
      return computeHeading(pos, coords[waypointIdx]);
    }
    if (coords.length >= 2) {
      return computeHeading(
        coords[coords.length - 2],
        coords[coords.length - 1],
      );
    }
    return 0;
  }

  /** Return cached route stops, fetching from DB on first access. */
  private async getRouteStops(routeId: string): Promise<BusRouteStop[]> {
    const cached = this.routeStopCache.get(routeId);
    if (cached) return cached;
    const stops = await this.busRouteStopService.findByRoute(
      new Types.ObjectId(routeId),
    );
    this.routeStopCache.set(routeId, stops);
    return stops;
  }

  /**
   * Build the waypoint chain from `currentPos` to stop at `nextStopIdx`.
   * Uses the stored road geometry (`segmentPath`) if available; falls back to
   * a straight two-point line.
   */
  private buildSegmentCoords(
    stops: BusRouteStop[],
    nextStopIdx: number,
    currentPos: [number, number],
  ): [number, number][] {
    if (nextStopIdx >= stops.length) return [currentPos];

    const seg = stops[nextStopIdx].segmentPath;
    if (seg?.coordinates && seg.coordinates.length >= 2) {
      return seg.coordinates as unknown as [number, number][];
    }

    return [currentPos, stopCoords(stops[nextStopIdx].stop)];
  }

  private getLiveMetadata(currentPos: [number, number], prevPos?: [number, number]) {
    const lng = currentPos[0];
    const prevLng = prevPos ? prevPos[0] : lng;

    return {
      heading: 0,
      busImage: lng < prevLng ? 'bus_go_left.png' : 'bus_go_right.png'
    };
  }
}
