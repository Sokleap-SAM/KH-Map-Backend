import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { BusTrip, BusTripDocument } from './entities/bus-trip.schema';
import { BusRoute, BusRouteDocument } from './entities/bus-route.schema';
import { BusRouteStopService } from './bus-route-stop.service';
import { BusLocationService } from './bus-location.service';
import { BusDispatchService } from './bus-dispatch.service';
import { BusTripService, TripLiveData } from './bus-trip.service';
import { BusRouteStop } from './entities/bus-route-stop.schema';
import { RedisService } from '../../shared/redis/redis.service';
import { MqttService } from '../../shared/mqtt/mqtt.service';
import { AppSettingsService } from '../app-settings/app-settings.service';
import { TransitMode } from '../app-settings/enums/transit-mode.enum';
import {
  TICK_MS,
  BUS_SIMULATION_SPEED_KMH,
  BUS_ROUTING_SPEED_KMH,
  SIMULATION_SPEED_M_PER_TICK,
  SYNC_EVERY_N_TICKS,
  SIM_LOCK_TTL_SECONDS,
  STOP_ARRIVAL_RADIUS_M,
  DWELL_TIME_MIN,
  DETAIL_PUBLISH_EVERY_N_TICKS,
  TRIP_DETAIL_FORWARD_STOPS,
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
   * Trip status snapshot. `scheduled` buses are "parked" at stop 0 and don't
   * advance — `advanceBus` publishes their position with `notDepartingUntilMs`
   * (anchor + headway) so routing can include the queue wait in their ETA.
   * Transitions to `in-progress` when dispatch promotes the trip.
   */
  status: 'in-progress' | 'scheduled';
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
  /** Live movement state per active trip (keyed by tripId). */
  private readonly trips = new Map<string, TripSimState>();

  /** Route stop lists — loaded once per route and reused across ticks. */
  private readonly routeStopCache = new Map<string, BusRouteStop[]>();

  /** Per-route headway in minutes, refreshed lazily. Used by parked-bus
   *  position publication to compute `notDepartingUntilMs`. */
  private readonly routeHeadwayCache = new Map<string, number>();

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
    @InjectModel(BusRoute.name)
    private readonly busRouteModel: Model<BusRouteDocument>,
    private readonly busRouteStopService: BusRouteStopService,
    private readonly busLocationService: BusLocationService,
    private readonly busTripService: BusTripService,
    private readonly busDispatchService: BusDispatchService,
    private readonly redisService: RedisService,
    private readonly mqttService: MqttService,
    private readonly appSettings: AppSettingsService,
  ) {}

  /** Tracks whether the caller wants the simulator running, even if start
   *  hasn't actually succeeded yet (e.g. waiting for Redis to come up). */
  private wantedRunning = false;
  private startRetryHandle: ReturnType<typeof setTimeout> | null = null;

  async onModuleInit(): Promise<void> {
    // Don't await — start() may schedule retries (Redis warming up) and we
    // mustn't block the Nest bootstrap on that.
    void this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Start the simulation loop. No-op if already running. Safe to call before
   * Redis is connected — the lock acquisition is retried until it succeeds
   * (or {@link stop} cancels the intent).
   */
  async start(): Promise<void> {
    this.wantedRunning = true;
    await this.attemptStart();
  }

  private async attemptStart(): Promise<void> {
    if (!this.wantedRunning) return; // cancelled by stop() while retrying
    if (this._running) return;

    // Real-world mode: drivers run the buses, the simulator must not move
    // them. Refuse to start so a stale `await start()` from boot doesn't
    // resurrect the sim loop after admin flipped to live.
    if (this.appSettings.getMode() === TransitMode.LIVE) return;

    // Acquire a distributed lock so only one instance runs the simulation.
    // On single-instance deploys this is a no-op; on multi-instance it prevents
    // duplicate simulations that would advance buses 2×/3× too fast.
    let acquired = false;
    try {
      acquired = await this.redisService.setnx(
        BusSimulationService.LOCK_KEY,
        this.instanceId,
        SIM_LOCK_TTL_SECONDS,
      );
    } catch {
      /* swallow */
    }

    if (!acquired) {
      this.startRetryHandle = setTimeout(() => {
        this.startRetryHandle = null;
        void this.attemptStart();
      }, 5_000);
      return;
    }

    this._running = true;
    this.tickCount = 0;
    this.intervalHandle = setInterval(() => void this.runTick(), TICK_MS);
  }

  /** Stop the loop and clear all in-memory state. No-op if already stopped. */
  stop(): void {
    // Cancel any pending start retry first so we don't undo this stop.
    this.wantedRunning = false;
    if (this.startRetryHandle) {
      clearTimeout(this.startRetryHandle);
      this.startRetryHandle = null;
    }
    if (!this._running) return;
    this._running = false;
    clearInterval(this.intervalHandle!);
    this.intervalHandle = null;
    this.trips.clear();
    this.routeStopCache.clear();
    // Release the distributed lock so another instance can take over.
    void this.redisService.del(BusSimulationService.LOCK_KEY);
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
    this.routeHeadwayCache.clear();
  }

  /**
   * Drop one route's cached stops/headway and its in-flight trip states.
   * Called after admin edits route geometry (stop added/edited/deleted) so
   * running buses pick up the new segments instead of driving the old ones
   * until process restart. Trips re-initialise from their Redis live
   * positions on the next sync tick (~5 s) against the fresh stop list.
   */
  evictRoute(routeId: string): void {
    this.routeStopCache.delete(routeId);
    this.routeHeadwayCache.delete(routeId);
    for (const [tripId, state] of this.trips) {
      if (state.routeId === routeId) this.trips.delete(tripId);
    }
  }

  // ─── Tick ──────────────────────────────────────────────────────────────────

  private async runTick(): Promise<void> {
    if (this.processing) return; // drop tick if previous still in-flight
    // Defence-in-depth: stop() is called explicitly when admin flips to live,
    // but if a tick somehow fires after the flip (race with setInterval),
    // bail so the simulator never moves a real-world bus.
    if (this.appSettings.getMode() === TransitMode.LIVE) return;
    this.processing = true;
    this.tickCount++;

    try {
      // Run trip sync in the background — a slow Mongo query mustn't block
      // the per-tick bus advance. Worst case the simulator operates on the
      // previous trip list for one extra tick (~1 s), which is invisible
      // to clients; whereas an awaited sync that takes 3 s causes a visible
      // 3 s freeze in every bus on the map.
      if (this.tickCount % SYNC_EVERY_N_TICKS === 1) {
        this.syncActiveTrips().catch(() => {});
      }
      if (this.trips.size === 0) return;
      await Promise.all(
        Array.from(this.trips.values()).map((s) => this.advanceBus(s)),
      );
    } catch {
      /* swallow */
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
      .catch(() => {});

    // Pull both in-progress AND scheduled trips. Scheduled buses are tracked
    // so their position (at stop 0, with `notDepartingUntilMs`) is published
    // to Redis — routing then includes them in the live-ETA map with the
    // remaining queue wait baked in, so the frontend can show their bus ID
    // for the "view bus details" button just like any moving bus.
    const active = await this.busTripModel
      .find({ status: { $in: ['in-progress', 'scheduled'] } })
      .lean()
      .exec();

    const activeIds = new Set(active.map((t) => String(t._id)));

    // Evict trips no longer in-progress or scheduled (completed, cancelled,
    // removed). Clear their Redis live-position keys so `getLivePositionsByRoute`
    // stops returning them.
    for (const id of this.trips.keys()) {
      if (!activeIds.has(id)) {
        const evicted = this.trips.get(id);
        this.trips.delete(id);
        if (evicted) {
          this.busLocationService
            .clearLocation(id, evicted.routeId)
            .catch(() => {});
        }
      }
    }

    // Detect status transitions for already-tracked trips (most commonly:
    // dispatch promoted a scheduled bus to in-progress).
    for (const t of active) {
      const id = String(t._id);
      const existing = this.trips.get(id);
      if (!existing) continue;
      const newStatus = t.status as 'in-progress' | 'scheduled';
      if (existing.status !== newStatus) {
        existing.status = newStatus;
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

    // Dispatch: bootstrap empty routes, promote scheduled trips after
    // headway, and re-queue completed buses. Fire-and-forget so DB latency
    // doesn't block the simulator sync.
    this.busDispatchService.run().catch(() => {});
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
    const tripStatus = trip.status as 'in-progress' | 'scheduled';

    if (stops.length === 0) return;

    const live = await this.busTripService.getLiveData(tripId);
    // Treat live data as stale if indices are out-of-bounds (e.g. after a reset)
    const isStale = !live || live.nextStopIndex >= stops.length;

    let pos: Coords;
    let currentStopIdx: number;
    let nextStopIdx: number;
    let passengerCount: number;

    if (isStale) {
      currentStopIdx = 0;
      nextStopIdx = stops.length > 1 ? 1 : 0;
      passengerCount = 0;
      // Seed at the first ROAD vertex of the opening segment when one is
      // stored — the stop's own coordinates sit on the sidewalk and would
      // make the bus visibly hop onto the walk path on its first tick.
      const seedSeg = this.buildSegmentCoords(
        stops,
        nextStopIdx,
        stopCoords(stops[0].stop),
      );
      pos = seedSeg.length >= 2 ? seedSeg[0] : stopCoords(stops[0].stop);
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
      // Anchor the route's "last departure from first stop" only when the
      // bus actually started moving (in-progress). Scheduled buses are
      // still parked — their anchor was set by dispatch when the *previous*
      // bus on the route departed.
      if (tripStatus === 'in-progress') {
        this.busLocationService
          .setRouteDepartureAnchor(routeId, Date.now())
          .catch(() => {});
      }
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
      status: tripStatus,
    });
  }

  // ─── Per-bus movement ──────────────────────────────────────────────────────

  private async advanceBus(state: TripSimState): Promise<void> {
    // Skip if this trip was evicted during a concurrent tick
    if (!this.trips.has(state.tripId)) return;

    const stops = this.routeStopCache.get(state.routeId);
    if (!stops) return;

    // Parked (scheduled) bus: don't move, just publish a position at stop 0
    // with the expected departure timestamp so routing can include the
    // queue wait in its ETA at downstream stops. The dispatch service flips
    // this trip to 'in-progress' when its headway elapses.
    if (state.status === 'scheduled') {
      await this.advanceParkedBus(state, stops);
      return;
    }

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
        // Arrival detection: measured against the SEGMENT'S last waypoint,
        // not the stop's stored coordinates. Stops physically sit on the
        // sidewalk while segments are road-snapped — the bus arrives at the
        // road point beside the stop and must never hop onto the walk path.
        // The proximity check handles float drift where the bus lands a
        // hair short of the final waypoint.
        const segEnd = segCoords[segCoords.length - 1];
        const distToSegEnd = haversineMeters(pos, segEnd);
        const reachedByProximity = distToSegEnd <= STOP_ARRIVAL_RADIUS_M;
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

          // Snap to the segment's road endpoint and start the dwell window.
          // We don't consume the remaining tick budget on the next segment —
          // doing so would skip dwell and let the bus outrun routing's
          // predictions. Break out so the unified publish at the bottom
          // still fires (Redis + MQTT) and the frontend sees the bus parked
          // beside the stop.
          pos = segEnd;
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
      .catch(() => {});

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

    // Per-trip detail topic, throttled to DETAIL_PUBLISH_EVERY_N_TICKS. The
    // map-view subscribers only need position (above); the bus-detail card
    // wants richer data (ETAs to upcoming stops, passenger count). Different
    // cadence and payload size — separate topic keeps each audience lean.
    if (this.tickCount % DETAIL_PUBLISH_EVERY_N_TICKS === 0) {
      this.mqttService.publish(
        `transit/trip/${state.tripId}/detail`,
        this.buildTripDetail(state, stops, pos, heading, reportedSpeed),
        { qos: 0, retain: true },
      );
    }
  }

  /**
   * Build the per-trip detail payload published on `transit/trip/<tripId>/detail`.
   * Includes the bus's current position plus ETAs for the next few upcoming
   * stops. Returns null for the next-stop ETA when the trip has finished its
   * route (caller should suppress that case before invoking).
   *
   * ETA strategy:
   *   - Next stop: `haversine(currentPos, nextStop) / BUS_SIMULATION_SPEED_KMH`
   *     — matches what the user sees on the map.
   *   - Subsequent stops: routing speed + per-stop dwell. Keeps the detail
   *     ETAs consistent with what the planner displays in route plans, so a
   *     user comparing the two doesn't see contradictory minutes.
   */
  private buildTripDetail(
    state: TripSimState,
    stops: BusRouteStop[],
    pos: Coords,
    heading: number,
    reportedSpeed: number,
  ): Record<string, unknown> {
    const upcoming: Array<{
      stopId: string;
      name: string;
      etaMinutes: number;
    }> = [];
    let etaNextStopMin: number | null = null;

    if (state.nextStopIdx < stops.length) {
      const nextStop = stops[state.nextStopIdx];
      const nextCoords = stopCoords(nextStop.stop);
      const distToNextM = haversineMeters(pos, nextCoords);
      const nextEtaMin = (distToNextM / 1000 / BUS_SIMULATION_SPEED_KMH) * 60;
      etaNextStopMin = Math.max(0, Math.round(nextEtaMin * 10) / 10);

      const nextStopRef = nextStop.stop as unknown as {
        _id?: { toString(): string };
        name?: string;
      };
      let cumMin = nextEtaMin;
      upcoming.push({
        stopId: nextStopRef._id?.toString() ?? '',
        name: nextStopRef.name ?? '',
        etaMinutes: etaNextStopMin,
      });

      for (
        let i = state.nextStopIdx + 1;
        i < stops.length && upcoming.length < TRIP_DETAIL_FORWARD_STOPS;
        i++
      ) {
        const prev = stops[i - 1];
        const curr = stops[i];
        const segDist = haversineMeters(
          stopCoords(prev.stop),
          stopCoords(curr.stop),
        );
        cumMin +=
          (segDist / 1000 / BUS_ROUTING_SPEED_KMH) * 60 + DWELL_TIME_MIN;
        const currRef = curr.stop as unknown as {
          _id?: { toString(): string };
          name?: string;
        };
        upcoming.push({
          stopId: currRef._id?.toString() ?? '',
          name: currRef.name ?? '',
          etaMinutes: Math.max(0, Math.round(cumMin * 10) / 10),
        });
      }
    }

    return {
      tripId: state.tripId,
      busId: state.busId,
      routeId: state.routeId,
      longitude: pos[0],
      latitude: pos[1],
      heading,
      speed: reportedSpeed,
      currentStopIndex: state.currentStopIdx,
      nextStopIndex: state.nextStopIdx,
      etaNextStopMin,
      upcomingStops: upcoming,
      passengerCount: state.passengerCount,
      recordedAt: new Date().toISOString(),
    };
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
    this.busLocationService.clearLocation(tripId, routeId).catch(() => {});

    // Mark trip completed in Mongo and let the dispatch service decide
    // whether to re-queue this bus or release it.
    try {
      await this.busDispatchService.onTripCompleted(tripId, busId, routeId);
    } catch {
      /* swallow */
    }
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

  /**
   * Per-tick advance for parked (scheduled) buses. The bus doesn't move;
   * we just refresh its Redis position at stop 0 along with the projected
   * departure time. Routing reads `notDepartingUntilMs` and adds the
   * remaining wait to every downstream stop ETA so the parked bus shows
   * up as a live boarding candidate in plan responses (with the queue
   * delay baked in).
   *
   * Departure time = anchor + headway × queuePosition. With dispatch's
   * "exactly one scheduled at a time" invariant, the parked bus is always
   * queue position 1 — so departure = anchor + headway. If the anchor or
   * headway is unavailable we skip publication (the bus stays invisible
   * for that tick).
   */
  private async advanceParkedBus(
    state: TripSimState,
    stops: BusRouteStop[],
  ): Promise<void> {
    const headwayMin = await this.getRouteHeadway(state.routeId);
    if (headwayMin == null) return;

    const anchors = await this.busLocationService.getRouteDepartureAnchors([
      state.routeId,
    ]);
    const anchorMs = anchors.get(state.routeId);
    if (anchorMs === undefined) return;

    const stop0 = stopCoords(stops[0].stop);
    const notDepartingUntilMs = anchorMs + headwayMin * 60_000;
    state.pos = stop0;
    state.currentStopIdx = 0;

    // Publish to Redis (live ETA query reads this) + MQTT (frontend map).
    this.busLocationService
      .reportLocation({
        busId: state.busId,
        tripId: state.tripId,
        routeId: state.routeId,
        longitude: stop0[0],
        latitude: stop0[1],
        heading: 0,
        speed: 0,
        currentStopIndex: 0,
        notDepartingUntilMs,
      })
      .catch(() => {});

    this.mqttService.publish(
      `transit/route/${state.routeId}/position`,
      {
        tripId: state.tripId,
        busId: state.busId,
        routeId: state.routeId,
        longitude: stop0[0],
        latitude: stop0[1],
        heading: 0,
        speed: 0,
        currentStopIndex: 0,
        notDepartingUntilMs,
        status: 'scheduled',
        recordedAt: new Date().toISOString(),
      },
      { qos: 0, retain: true },
    );
  }

  /** Return cached headwayMinutes for a route. Returns null if the route is
   *  unknown or has no headway configured (in which case parked buses can't
   *  be published since departure time is undefined). */
  private async getRouteHeadway(routeId: string): Promise<number | null> {
    const cached = this.routeHeadwayCache.get(routeId);
    if (cached !== undefined) return cached;
    try {
      const route = await this.busRouteModel
        .findById(routeId, 'headwayMinutes')
        .lean()
        .exec();
      const hw = route?.headwayMinutes ?? null;
      if (hw != null) this.routeHeadwayCache.set(routeId, hw);
      return hw;
    } catch {
      return null;
    }
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
