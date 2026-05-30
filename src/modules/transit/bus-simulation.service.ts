/* eslint-disable @typescript-eslint/await-thenable */
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
import { BusDispatchService } from './bus-dispatch.service';
import { BusTripService, TripLiveData } from './bus-trip.service';
import { BusRouteStop } from './entities/bus-route-stop.schema';
import { RedisService } from '../../shared/redis/redis.service';
import { MqttService } from '../../shared/mqtt/mqtt.service';
import {
  TICK_MS,
  BUS_SIMULATION_SPEED_KMH,
  SIMULATION_SPEED_M_PER_TICK,
  SYNC_EVERY_N_TICKS,
  SIM_LOCK_TTL_SECONDS,
  STOP_ARRIVAL_RADIUS_M,
  DWELL_TIME_MIN,
} from '../../shared/constants/constants';
import {
  Coords,
  haversineMeters,
  computeHeading,
  pointToSegmentDistance,
} from '../../shared/helpers/helper-functions';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Live movement state kept in memory for each active trip. */
interface TripSimState {
  tripId: string;
  busId: string;
  routeId: string;
  pos: Coords;
  currentStopIdx: number;
  nextStopIdx: number;
  passengerCount: number;
  waypointIdx: number; // index into segmentCoords the bus is heading toward
  segmentCoords: Coords[]; // road waypoints for the current inter-stop segment
  /**
   * Wall-clock timestamp (ms) until which the bus is dwelling at its current
   * stop and should not move. Set when the bus arrives at an intermediate
   * stop so the on-map bus matches the dwell time baked into routing costs.
   * Undefined when the bus is in motion.
   */
  dwellUntilMs?: number;
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

/** Extract [lng, lat] from a populated stop document. */
function stopCoords(stop: BusRouteStop['stop']): Coords {
  const place = stop as unknown as {
    location: { coordinates: Coords };
  };
  return place.location.coordinates;
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

  /**
   * Unique ID for this process instance — stored in the Redis lock so only
   * the owning instance can renew or release it.
   */
  private readonly instanceId = Math.random().toString(36).slice(2);
  private static readonly LOCK_KEY = 'sim:master:lock';

  constructor(
    @InjectModel(BusTrip.name)
    private readonly busTripModel: Model<BusTripDocument>,
    private readonly busRouteStopService: BusRouteStopService,
    private readonly busLocationService: BusLocationService,
    private readonly busTripService: BusTripService,
    private readonly busDispatchService: BusDispatchService,
    private readonly redisService: RedisService,
    private readonly mqttService: MqttService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /** Start the simulation loop. No-op if already running. */
  async start(): Promise<void> {
    if (this._running) return;

    // Acquire a distributed lock so only one instance runs the simulation.
    // On single-instance deploys this is a no-op; on multi-instance it prevents
    // duplicate simulations that would advance buses 2×/3× too fast.
    const acquired = await this.redisService.setnx(
      BusSimulationService.LOCK_KEY,
      this.instanceId,
      SIM_LOCK_TTL_SECONDS,
    );
    if (!acquired) {
      this.logger.warn(
        `Simulation lock held by another instance — this instance (${this.instanceId}) will not start.`,
      );
      return;
    }

    this._running = true;
    this.tickCount = 0;
    this.intervalHandle = setInterval(() => void this.runTick(), TICK_MS);
    this.logger.log(
      `Simulation started (instance=${this.instanceId}) — tick=${TICK_MS} ms, speed=${BUS_SIMULATION_SPEED_KMH} km/h (${SIMULATION_SPEED_M_PER_TICK.toFixed(1)} m/tick)`,
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
    // Release the distributed lock so another instance can take over.
    void this.redisService.del(BusSimulationService.LOCK_KEY);
    this.logger.log('Simulation stopped');
  }

  get running(): boolean {
    return this._running;
  }

  get activeTripCount(): number {
    return this.trips.size;
  }

  /**
   * DEV ONLY: drop every in-memory trip and route-stop cache entry so the
   * simulator stops tracking any buses immediately. The next `syncActiveTrips`
   * tick reads from a clean Mongo collection. Used by the admin reset endpoint.
   */
  clearInMemoryState(): void {
    this.trips.clear();
    this.routeStopCache.clear();
  }

  // ─── Tick ──────────────────────────────────────────────────────────────────

  private async runTick(): Promise<void> {
    if (this.processing) return; // drop tick if previous still in-flight
    this.processing = true;
    this.tickCount++;

    try {
      // Run trip sync in the background — a slow Mongo query mustn't block
      // the per-tick bus advance. Worst case the simulator operates on the
      // previous trip list for one extra tick (~1 s), which is invisible
      // to clients; whereas an awaited sync that takes 3 s causes a visible
      // 3 s freeze in every bus on the map.
      if (this.tickCount % SYNC_EVERY_N_TICKS === 1) {
        this.syncActiveTrips().catch((err: unknown) =>
          this.logger.error('syncActiveTrips failed', err),
        );
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
   * Also renews the distributed lock TTL so it doesn't expire mid-operation.
   */
  private async syncActiveTrips(): Promise<void> {
    // Renew lock — fire-and-forget so a slow Redis call can't freeze the tick.
    // The TTL is 30 s and syncs happen every 5 s, so one missed renewal is safe.
    this.redisService
      .expire(BusSimulationService.LOCK_KEY, SIM_LOCK_TTL_SECONDS)
      .catch((err: unknown) => this.logger.warn('Lock renewal failed', err));

    const active = await this.busTripModel
      .find({ status: 'in-progress' })
      .lean()
      .exec();

    const activeIds = new Set(active.map((t) => String(t._id)));

    // Evict trips no longer in-progress, and clean their Redis live-position
    // keys so `getLivePositionsByRoute` stops returning them — otherwise the
    // routing service keeps treating the bus as live for up to 24 h after the
    // trip is removed from Mongo.
    for (const id of this.trips.keys()) {
      if (!activeIds.has(id)) {
        const evicted = this.trips.get(id);
        this.trips.delete(id);
        if (evicted) {
          this.busLocationService
            .clearLocation(id, evicted.routeId)
            .catch((err: unknown) =>
              this.logger.warn(
                `Failed to clear Redis location for trip ${id}`,
                err,
              ),
            );
        }
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

    // Dispatch: bootstrap empty routes, promote scheduled trips after
    // headway, and re-queue completed buses. Fire-and-forget so DB latency
    // doesn't block the simulator sync.
    this.busDispatchService
      .run()
      .catch((err: unknown) => this.logger.warn('Dispatch run failed', err));
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

    let pos: Coords;
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
        ...meta,
      });
      // Anchor the route's "last departure from first stop" to now so the
      // routing service can project deterministic next-lap arrivals.
      this.busLocationService
        .setRouteDepartureAnchor(routeId, Date.now())
        .catch((err: unknown) =>
          this.logger.warn(
            `Failed to set departure anchor for route ${routeId}`,
            err,
          ),
        );
    } else {
      pos = [live.longitude, live.latitude];
      currentStopIdx = live.currentStopIndex;
      nextStopIdx = live.nextStopIndex;
      passengerCount = live.passengerCount;
    }

    const segmentCoords = this.buildSegmentCoords(stops, nextStopIdx, pos);
    // When resuming mid-segment from Redis, find the waypoint the bus was
    // actually heading toward — not always waypoint[1]. Without this, the bus
    // would move BACKWARD through already-passed waypoints before continuing
    // forward, appearing frozen or going the wrong direction on the frontend.
    const waypointIdx = isStale
      ? 1
      : this.findResumeWaypointIdx(pos, segmentCoords);

    this.trips.set(tripId, {
      tripId,
      busId: String(trip.bus),
      routeId,
      pos,
      currentStopIdx,
      nextStopIdx,
      passengerCount,
      waypointIdx,
      segmentCoords,
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

    if (state.nextStopIdx >= stops.length) {
      await this.completeTrip(state, stops);
      return;
    }

    // Dwell handling: while the bus is dwelling at a stop it doesn't move,
    // but we MUST keep publishing the stationary position every tick.
    // Otherwise the frontend's MQTT stream goes silent and most clients drop
    // the bus from the map after a few seconds, then "respawn" it when motion
    // resumes — the visible disappearance bug.
    if (state.dwellUntilMs && Date.now() >= state.dwellUntilMs) {
      state.dwellUntilMs = undefined;
    }
    const isDwelling = state.dwellUntilMs !== undefined;

    // Move the bus along the waypoint chain by SIMULATION_SPEED_M_PER_TICK metres.
    // When the bus exhausts a segment it snaps to the stop and immediately continues
    // on the next segment with whatever distance remains — no movement is lost.
    let pos = state.pos;
    let waypointIdx = state.waypointIdx;
    let segCoords = state.segmentCoords;

    if (!isDwelling) {
      let remaining = SIMULATION_SPEED_M_PER_TICK;
      while (remaining > 0.01) {
        // Arrival detection: if we're within STOP_ARRIVAL_RADIUS_M of the
        // next stop's stored coordinates, treat as arrived and load the next
        // segment. This handles the case where the segmentPath's last
        // waypoint isn't exactly at the stop (data inconsistency) — without
        // this check the bus can sit a few metres short of the stop and the
        // segment-end branch below never triggers.
        const nextStopCoords = stopCoords(stops[state.nextStopIdx].stop);
        const distToNextStop = haversineMeters(pos, nextStopCoords);
        const reachedByProximity = distToNextStop <= STOP_ARRIVAL_RADIUS_M;
        const reachedByWaypoints = waypointIdx >= segCoords.length;

        if (reachedByProximity || reachedByWaypoints) {
          // Arrived at the next stop.
          const arrivedIdx = state.nextStopIdx;
          const newNextIdx = arrivedIdx + 1;

          if (newNextIdx >= stops.length) {
            // Last stop reached — commit position and reset trip.
            state.pos = pos;
            state.currentStopIdx = arrivedIdx;
            state.nextStopIdx = newNextIdx;
            state.waypointIdx = waypointIdx;
            state.segmentCoords = segCoords;
            await this.completeTrip(state, stops);
            return;
          }

          // Snap to stop and start the dwell window. We don't consume the
          // remaining tick budget on the next segment — doing so would skip
          // dwell and let the bus outrun routing's predictions. Break out
          // so the unified publish at the bottom still fires (Redis + MQTT)
          // and the frontend sees the bus parked at the stop.
          pos = nextStopCoords;
          state.currentStopIdx = arrivedIdx;
          state.nextStopIdx = newNextIdx;
          segCoords = this.buildSegmentCoords(stops, newNextIdx, pos);
          waypointIdx = 1;
          state.dwellUntilMs = Date.now() + DWELL_TIME_MIN * 60_000;
          break;
        }

        const target = segCoords[waypointIdx];
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
    }

    // Heading is meaningless while dwelling (the bus isn't moving), so we
    // publish 0; once dwell ends the next tick computes a real heading.
    const heading = isDwelling
      ? 0
      : this.headingFromState(segCoords, pos, waypointIdx);
    // Reported speed mirrors actual motion so live ETAs and the UI don't
    // imply the bus is still moving while it dwells.
    const reportedSpeed = isDwelling ? 0 : Math.round(BUS_SIMULATION_SPEED_KMH);

    state.pos = pos;
    state.waypointIdx = waypointIdx;
    state.segmentCoords = segCoords;
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
        speed: reportedSpeed,
        currentStopIndex: state.currentStopIdx,
      })
      .catch((err: unknown) => this.logger.error('reportLocation failed', err));

    // Push to MQTT subscribers. `retain: true` so a frontend that connects
    // after this tick still receives the last known position immediately on
    // subscribe (no need to hit the HTTP endpoint for initial state). QoS 0
    // because the next tick (~1 s) supersedes anything dropped in transit.
    this.mqttService.publish(
      `transit/route/${state.routeId}/position`,
      {
        tripId: state.tripId,
        busId: state.busId,
        routeId: state.routeId,
        longitude: pos[0],
        latitude: pos[1],
        heading,
        speed: reportedSpeed,
        currentStopIndex: state.currentStopIdx,
        recordedAt: new Date().toISOString(),
      },
      { qos: 0, retain: true },
    );
  }

  /**
   * Handle a trip reaching the last stop of its route. Under the new
   * dispatch model the bus does NOT automatically loop back — instead the
   * trip is marked completed, the bus is either re-queued or goes idle
   * (decided by {@link BusDispatchService.onTripCompleted}), and the
   * simulator drops it from in-memory state. The next dispatch tick will
   * promote a scheduled trip to in-progress when headway elapses and
   * `initTrip` will re-spawn the bus at stop 0 then.
   */
  private async completeTrip(
    state: TripSimState,
    _stops: BusRouteStop[],
  ): Promise<void> {
    const tripId = state.tripId;
    const routeId = state.routeId;
    const busId = state.busId;

    // Evict in-memory state first so the next tick doesn't try to advance a
    // bus whose trip is being marked completed.
    this.trips.delete(tripId);

    // Clear Redis live position so `getLivePositionsByRoute` immediately
    // stops returning this bus (otherwise routing keeps seeing a phantom
    // bus parked at the last stop until the 24 h TTL).
    this.busLocationService
      .clearLocation(tripId, routeId)
      .catch((err: unknown) =>
        this.logger.warn(`Failed to clear location for trip ${tripId}`, err),
      );

    // Mark trip completed in Mongo and let the dispatch service decide
    // whether to re-queue this bus or release it.
    try {
      await this.busDispatchService.onTripCompleted(tripId, busId, routeId);
    } catch (err) {
      this.logger.error(`Trip completion handling failed for ${tripId}`, err);
    }

    this.logger.log(
      `Trip ${tripId} completed — bus ${busId} handed off to dispatch`,
    );
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Calculate heading based on the next waypoint, or the last segment direction. */
  private headingFromState(
    coords: Coords[],
    pos: Coords,
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
   * Given the bus's current GPS position and the segment waypoint chain,
   * returns the index of the NEXT waypoint the bus should target.
   * Used when resuming from Redis to avoid forcing the bus backward through
   * waypoints it has already passed.
   */
  private findResumeWaypointIdx(pos: Coords, segCoords: Coords[]): number {
    if (segCoords.length <= 1) return 1;
    let bestIdx = 1;
    let minDist = Infinity;
    for (let i = 0; i < segCoords.length - 1; i++) {
      const d = pointToSegmentDistance(pos, segCoords[i], segCoords[i + 1]);
      if (d < minDist) {
        minDist = d;
        bestIdx = i + 1; // target the end-point of the closest sub-segment
      }
    }
    return bestIdx;
  }

  /**
   * Write live position to Redis with a hard timeout so a hanging Redis
   * connection never keeps `this.processing = true` indefinitely.
   * If the write fails or times out, the bus state is already updated in
   * memory and Redis will catch up on the next successful tick.
   */
  private async writeWithTimeout(
    tripId: string,
    liveData: TripLiveData,
  ): Promise<void> {
    let handle: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.busTripService.setLiveData(tripId, liveData),
        new Promise<never>(
          (_, reject) =>
            (handle = setTimeout(
              () => reject(new Error('Redis write timeout')),
              2_000,
            )),
        ),
      ]);
    } catch (err) {
      this.logger.warn(
        `Redis write skipped for trip ${tripId} — will retry next tick`,
        err,
      );
    } finally {
      clearTimeout(handle);
    }
  }

  /**
   * Build the waypoint chain from `currentPos` to stop at `nextStopIdx`.
   * Uses the stored road geometry (`segmentPath`) if available; falls back to
   * a straight two-point line.
   *
   * Data convention (matches what `TransitRoutingService.buildRaptorBusSegment`
   * assumes): `stops[i].segmentPath` is the road geometry from stop `i-1` to
   * stop `i` — the segment ARRIVING at this stop. To travel from the current
   * stop to `nextStopIdx`, we therefore read `stops[nextStopIdx].segmentPath`.
   */
  private buildSegmentCoords(
    stops: BusRouteStop[],
    nextStopIdx: number,
    currentPos: Coords,
  ): Coords[] {
    if (nextStopIdx >= stops.length) return [currentPos];

    const seg = stops[nextStopIdx].segmentPath;
    if (seg?.coordinates && seg.coordinates.length >= 2) {
      return seg.coordinates as unknown as Coords[];
    }

    return [currentPos, stopCoords(stops[nextStopIdx].stop)];
  }

  private getLiveMetadata(
    currentPos: [number, number],
    prevPos?: [number, number],
  ) {
    const lng = currentPos[0];
    const prevLng = prevPos ? prevPos[0] : lng;

    return {
      heading: 0,
      busImage: lng < prevLng ? 'bus_go_left.png' : 'bus_go_right.png',
    };
  }
}
