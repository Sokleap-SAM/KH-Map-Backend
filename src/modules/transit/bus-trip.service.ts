/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { BusTrip, BusTripDocument } from './entities/bus-trip.schema';
import { CreateBusTripDto } from './dto/create-bus-trip.dto';
import { UpdateBusTripDto } from './dto/update-bus-trip.dto';
import { BusRouteStopService } from './bus-route-stop.service';
import { BusLocationService } from './bus-location.service';
import { RedisService } from '../../shared/redis/redis.service';
import { haversineMeters } from '../../shared/helpers/helper-functions';
import {
  BUS_SIMULATION_SPEED_KMH,
  BUS_ROUTING_SPEED_KMH,
  DWELL_TIME_MIN,
} from '../../shared/constants/constants';

// Redis key conventions:
//   trip:live:{tripId}  → Hash { currentStopIndex, nextStopIndex, passengerCount, lng, lat }
//   bus:locations        → Geo set with tripId as member

/** TTL (seconds) for simulation trip live data — refreshed on every position update */
const TRIP_LIVE_TTL_SECONDS = 14_400; // 4 hours

export interface TripLiveData {
  currentStopIndex: number;
  nextStopIndex: number;
  passengerCount: number;
  longitude: number;
  latitude: number;
  heading: number;
  busImage: string;
  mirrored: boolean;
}

@Injectable()
export class BusTripService {
  private readonly GEO_KEY = 'bus:locations';

  constructor(
    @InjectModel(BusTrip.name)
    private readonly busTripModel: Model<BusTripDocument>,
    private readonly busRouteStopService: BusRouteStopService,
    private readonly busLocationService: BusLocationService,
    private readonly redisService: RedisService,
  ) {}

  private tripLiveKey(tripId: string): string {
    return `trip:live:${tripId}`;
  }

  async setLiveData(tripId: string, data: TripLiveData): Promise<void> {
    const key = this.tripLiveKey(tripId);
    await this.redisService.hset(key, {
      currentStopIndex: String(data.currentStopIndex),
      nextStopIndex: String(data.nextStopIndex),
      passengerCount: String(data.passengerCount),
      longitude: String(data.longitude),
      latitude: String(data.latitude),
      heading: String(data.heading || 0),
      busImage: data.busImage || 'bus_go_right.png',
      mirrored: String(data.mirrored || false),
    });
    // Refresh TTL on every write so abandoned trips eventually expire
    await this.redisService.expire(key, TRIP_LIVE_TTL_SECONDS);
    await this.redisService.geoadd(
      this.GEO_KEY,
      data.longitude,
      data.latitude,
      tripId,
    );
  }

  async getLiveData(tripId: string): Promise<TripLiveData | null> {
    const data = await this.redisService.hgetall(this.tripLiveKey(tripId));
    if (!data) return null;
    return {
      currentStopIndex: Number(data.currentStopIndex),
      nextStopIndex: Number(data.nextStopIndex),
      passengerCount: Number(data.passengerCount),
      longitude: Number(data.longitude),
      latitude: Number(data.latitude),
      heading: Number(data.heading || 0),
      busImage: data.busImage || 'bus_go_right.png',
      mirrored: data.mirrored === 'true',
    };
  }

  async clearLiveData(tripId: string): Promise<void> {
    await this.redisService.hdel(this.tripLiveKey(tripId));
    await this.redisService.georemove(this.GEO_KEY, tripId);
    // Also clear bus-location's namespace (separate keys consumed by the
    // routing service's `getLivePositionsByRoute`). Without this, ending a
    // trip via the API only cleans this service's keys and the routing layer
    // continues to see the bus as live until the 24h Redis TTL expires.
    await this.busLocationService.clearLocation(tripId);
  }

  private async mergeLiveData(trip: any, live: TripLiveData | null) {
    const routeId = trip.route?._id || trip.route;
    const stops = await this.busRouteStopService.findByRoute(routeId);

    const nextStop =
      (live && stops[live.nextStopIndex]
        ? (stops[live.nextStopIndex].stop as any)?.nameInKhmer
        : null) ?? 'ស្វែងរកចំណត...';

    const destination = trip.route?.name || 'មិនច្បាស់លាស់';

    const allStopNames = stops.map(
      (s) => (s.stop as any)?.nameInKhmer || 'Unknown',
    );

    return {
      ...trip,
      routeNumber: trip.route?.code || '??',
      nextStopName: nextStop,
      direction: destination,
      allStops: allStopNames,
      busNumber: trip.bus?.busNumber || 'N/A',
      currentStopIndex: live?.currentStopIndex ?? null,
      nextStopIndex: live?.nextStopIndex ?? 1,
      passengerCount: live?.passengerCount ?? null,
      heading: live?.heading ?? 0,
      busImage: live?.busImage ?? 'bus_go_right.png',
      currentLocation: live
        ? { type: 'Point', coordinates: [live.longitude, live.latitude] }
        : null,
    };
  }

  private calculateBusDirection(oldLng: number, newLng: number): string {
    return newLng < oldLng ? 'bus_go_left.png' : 'bus_go_right.png';
  }

  async create(dto: CreateBusTripDto) {
    const stops = await this.busRouteStopService.findByRoute(dto.route);
    if (stops.length === 0) {
      throw new BadRequestException('Route has no stops defined');
    }

    const firstStop = stops[0];
    const populatedStop = firstStop.stop as unknown as {
      location: { type: string; coordinates: [number, number] };
    };

    const trip = await this.busTripModel.create({
      ...dto,
      status: 'scheduled',
    });

    const tripId = trip._id.toString();
    const [lng, lat] = populatedStop.location.coordinates;

    await this.setLiveData(tripId, {
      currentStopIndex: 0,
      nextStopIndex: stops.length > 1 ? 1 : 0,
      passengerCount: 0,
      longitude: lng,
      latitude: lat,
      heading: 0,
      busImage: 'bus_go_right.png',
      mirrored: false,
    });

    const live = await this.getLiveData(tripId);
    return this.mergeLiveData(trip.toObject(), live);
  }

  private getIsometricBusImage(heading: number): string {
    // Normalize angle to handle negative numbers or wraps safely
    const angle = ((heading % 360) + 360) % 360;

    // Map to your 4 specific isometric asset files
    if (angle >= 0 && angle < 90) {
      return 'bus_up_right.png';
    } else if (angle >= 90 && angle < 180) {
      return 'bus_down_right.png';
    } else if (angle >= 180 && angle < 270) {
      return 'bus_down_left.png';
    } else {
      return 'bus_up_left.png';
    }
  }

  async findAll() {
    const trips = await this.busTripModel
      .find()
      .populate('route')
      .populate('bus')
      .lean()
      .exec();
    return Promise.all(
      trips.map(async (trip) => {
        const live = await this.getLiveData(trip._id.toString());
        return this.mergeLiveData(trip, live);
      }),
    );
  }

  async findActive() {
    const trips = await this.busTripModel
      .find({ status: { $in: ['scheduled', 'in-progress'] } })
      .populate('route')
      .populate('bus')
      .lean()
      .exec();
    return Promise.all(
      trips.map(async (trip) => {
        const live = await this.getLiveData(trip._id.toString());
        return await this.mergeLiveData(trip, live);
      }),
    );
  }

  async findOne(id: Types.ObjectId) {
    const trip = await this.busTripModel
      .findById(id)
      .populate('route')
      .populate('bus')
      .lean()
      .exec();
    if (!trip)
      throw new NotFoundException(`BusTrip ${id.toString()} not found`);
    const live = await this.getLiveData(trip._id.toString());
    return this.mergeLiveData(trip, live);
  }

  async update(id: Types.ObjectId, dto: UpdateBusTripDto) {
    const mongoUpdate: Record<string, unknown> = {};

    if (dto.status) {
      mongoUpdate.status = dto.status;
      if (dto.status === 'in-progress') {
        mongoUpdate.startedAt = new Date();
        mongoUpdate.completedAt = null;
      }
      if (dto.status === 'scheduled') {
        // Resetting a trip back to scheduled clears both run timestamps
        mongoUpdate.startedAt = null;
        mongoUpdate.completedAt = null;
      }
      if (dto.status === 'completed' || dto.status === 'cancelled') {
        mongoUpdate.completedAt = new Date();
      }
    }

    // Update MongoDB if there are persistent fields to change
    if (Object.keys(mongoUpdate).length > 0) {
      await this.busTripModel.findByIdAndUpdate(id, mongoUpdate).exec();
    }

    // Update Redis live data
    const tripId = id.toString();
    const currentLive = await this.getLiveData(tripId);

    if (
      dto.currentLocation ||
      dto.currentStopIndex != null ||
      dto.nextStopIndex != null ||
      dto.passengerCount != null
    ) {
      const newLng =
        dto.currentLocation?.coordinates[0] ?? currentLive?.longitude ?? 0;
      // Use the live heading value (defaulting to 0 if not set)
      const currentHeading = currentLive?.heading ?? 0;
      const busImage = this.getIsometricBusImage(currentHeading);
      const logger = new Logger(BusTripService.name);
      logger.log(
        `Updating live data for trip ${tripId}: lng=${newLng}, heading=${currentHeading}, busImage=${busImage}`,
      );

      const updatedLive: TripLiveData = {
        currentStopIndex:
          dto.currentStopIndex ?? currentLive?.currentStopIndex ?? 0,
        nextStopIndex: dto.nextStopIndex ?? currentLive?.nextStopIndex ?? 0,
        passengerCount: dto.passengerCount ?? currentLive?.passengerCount ?? 0,
        longitude: newLng,
        latitude:
          dto.currentLocation?.coordinates[1] ?? currentLive?.latitude ?? 0,
        heading: currentHeading,
        busImage: busImage,
        mirrored: false,
      };
      await this.setLiveData(tripId, updatedLive);
    }

    // Clean up Redis when trip ends
    if (dto.status === 'completed' || dto.status === 'cancelled') {
      await this.clearLiveData(tripId);
    }

    return this.findOne(id);
  }

  async startTrip(id: Types.ObjectId, driverId?: Types.ObjectId) {
    // Stamp the operating driver atomically with the status flip so the trip's
    // history is driver-scoped (survives later bus reassignment).
    if (driverId) {
      await this.busTripModel
        .findByIdAndUpdate(id, { driver: driverId })
        .exec();
    }
    return this.update(id, { status: 'in-progress' });
  }

  async advanceToNextStop(id: Types.ObjectId) {
    const trip = await this.busTripModel.findById(id).populate('route').exec();
    if (!trip)
      throw new NotFoundException(`BusTrip ${id.toString()} not found`);

    const tripId = id.toString();
    const live = await this.getLiveData(tripId);
    if (!live)
      throw new BadRequestException(
        `No live data found for trip ${tripId}. The trip may have expired from Redis.`,
      );
    const nextIndex = live.nextStopIndex;

    const stops = await this.busRouteStopService.findByRoute(trip.route._id);

    if (nextIndex >= stops.length) {
      return this.update(id, { status: 'completed' });
    }

    const nextStop = stops[nextIndex];
    const populatedStop = nextStop.stop as unknown as {
      location: { type: string; coordinates: [number, number] };
    };

    return this.update(id, {
      currentStopIndex: nextIndex,
      nextStopIndex: nextIndex + 1,
      currentLocation: {
        type: 'Point',
        coordinates: populatedStop.location.coordinates,
      },
    });
  }

  async findNearby(
    longitude: number,
    latitude: number,
    maxDistanceMeters = 5000,
  ) {
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      throw new BadRequestException(
        'longitude and latitude must be valid numbers',
      );
    }
    if (!Number.isFinite(maxDistanceMeters) || maxDistanceMeters <= 0) {
      throw new BadRequestException(
        'maxDistance must be a positive number (default: 5000 meters)',
      );
    }
    const tripIds = await this.redisService.geosearch(
      this.GEO_KEY,
      longitude,
      latitude,
      maxDistanceMeters,
    );

    if (tripIds.length === 0) return [];

    const objectIds = tripIds.map((id) => new Types.ObjectId(id));
    const trips = await this.busTripModel
      .find({ _id: { $in: objectIds }, status: 'in-progress' })
      .populate('route')
      .populate('bus')
      .lean()
      .exec();

    return Promise.all(
      trips.map(async (trip) => {
        const live = await this.getLiveData(trip._id.toString());
        return this.mergeLiveData(trip, live);
      }),
    );
  }

  async remove(id: Types.ObjectId): Promise<void> {
    const result = await this.busTripModel.findByIdAndDelete(id).exec();
    if (!result)
      throw new NotFoundException(`BusTrip ${id.toString()} not found`);
    await this.clearLiveData(id.toString());
  }

  /**
   * One-shot ETA snapshot for the bus detail screen. Frontend calls this on
   * open so the card renders immediately, then keeps the value live by
   * recomputing locally from each MQTT position tick (same math).
   *
   * Throws `NotFoundException` when the trip has no live position in Redis
   * (simulator hasn't seeded it yet, trip evicted, or trip doesn't exist)
   * so the client can render an empty state or hide the ETA card without
   * ambiguity. For scheduled (parked) buses the response carries
   * `notDepartingUntilMs` so the client can render "Departs in N min"
   * instead of "Arrives in N min".
   */
  async getEtaToNextStop(tripId: string): Promise<{
    tripId: string;
    routeId: string;
    busId?: string;
    currentLocation: { longitude: number; latitude: number };
    speedKmh: number;
    currentStopIndex: number;
    nextStop: {
      id: string;
      name: string;
      longitude: number;
      latitude: number;
    } | null;
    etaSeconds: number;
    etaMinutes: number;
    notDepartingUntilMs?: number;
    isDwelling: boolean;
  }> {
    const pos = await this.busLocationService.getLivePosition(tripId);
    if (!pos) {
      throw new NotFoundException(
        `Trip ${tripId} has no live position yet.`,
      );
    }

    const stops = await this.busRouteStopService.findByRoute(
      new Types.ObjectId(pos.routeId),
    );
    if (stops.length === 0) {
      throw new NotFoundException(
        `Trip ${tripId} route has no stops configured.`,
      );
    }

    const currentIdx = pos.currentStopIndex ?? 0;
    // Last stop reached → no next stop; client should label as "Arrived".
    const hasNext = currentIdx + 1 < stops.length;
    const nextIdx = hasNext ? currentIdx + 1 : currentIdx;
    const nextStopDoc = stops[nextIdx];
    const nextStopCoords = (nextStopDoc.stop as any).location.coordinates as [
      number,
      number,
    ];
    const nextStopName = (nextStopDoc.stop as any).nameInKhmer as string;
    const nextStopId = (nextStopDoc.stop as any)._id.toString() as string;

    // Speed = 0 means the bus is dwelling or parked. Routing math falls
    // back to BUS_SIMULATION_SPEED_KMH so we still surface a sensible
    // "next departure ETA" even when motion is paused; client uses the
    // `isDwelling` flag to decide whether to render a static label instead.
    const isDwelling = (pos.speed ?? 0) <= 0;
    const speedKmh =
      pos.speed && pos.speed > 1 ? pos.speed : BUS_SIMULATION_SPEED_KMH;

    let etaSeconds: number;
    if (pos.notDepartingUntilMs && pos.notDepartingUntilMs > Date.now()) {
      // Parked bus: ETA is the remaining queue wait. Riding time to the
      // next stop is small relative to headway, so we report just the wait
      // and the client labels it "Departs in".
      etaSeconds = Math.round((pos.notDepartingUntilMs - Date.now()) / 1000);
    } else if (!hasNext) {
      etaSeconds = 0;
    } else {
      const remainingMeters = haversineMeters(
        [pos.longitude, pos.latitude],
        nextStopCoords,
      );
      etaSeconds = Math.round((remainingMeters / (speedKmh * 1000)) * 3600);
    }

    return {
      tripId,
      routeId: pos.routeId,
      busId: pos.busId,
      currentLocation: { longitude: pos.longitude, latitude: pos.latitude },
      speedKmh: pos.speed ?? 0,
      currentStopIndex: currentIdx,
      nextStop: hasNext
        ? {
            id: nextStopId,
            name: nextStopName,
            longitude: nextStopCoords[0],
            latitude: nextStopCoords[1],
          }
        : null,
      etaSeconds,
      etaMinutes: Math.max(0, Math.round(etaSeconds / 60)),
      notDepartingUntilMs: pos.notDepartingUntilMs,
      isDwelling,
    };
  }

  /**
   * Fresh ETA for a SPECIFIC target stop on the trip's route, keyed by
   * tripId + stopId. Where getEtaToNextStop only answers for the immediate
   * next stop, this answers for any stop ahead — the frontend uses it to
   * refresh the "arrive at your alight stop in N min" value once it stops
   * polling GET /transit/plan on a timer (see the route-tracking model).
   *
   * Cheap by design: reads the one live position and walks the route's stop
   * list. No plan re-solve.
   *
   * ETA composition mirrors buildTripDetail / the planner's segTime so the
   * number agrees with the per-trip detail topic and the plan response:
   *   - current pos → next stop: haversine / BUS_SIMULATION_SPEED_KMH
   *   - subsequent hops: segment distance / BUS_ROUTING_SPEED_KMH + dwell
   * A parked bus's remaining queue wait (notDepartingUntilMs) is added on top.
   *
   * `atStop` is true when the bus is currently at the target stop. A target
   * the bus has already passed returns etaSeconds 0 with atStop false — the
   * client reads that as "behind / missed".
   */
  async getEtaToStop(
    tripId: string,
    stopId: string,
  ): Promise<{
    tripId: string;
    stopId: string;
    etaSeconds: number;
    atStop: boolean;
  }> {
    if (!tripId || !stopId) {
      throw new BadRequestException('tripId and stopId are required.');
    }

    const pos = await this.busLocationService.getLivePosition(tripId);
    if (!pos) {
      throw new NotFoundException(`Trip ${tripId} has no live position yet.`);
    }

    const stops = await this.busRouteStopService.findByRoute(
      new Types.ObjectId(pos.routeId),
    );
    if (stops.length === 0) {
      throw new NotFoundException(
        `Trip ${tripId} route has no stops configured.`,
      );
    }

    const targetIdx = stops.findIndex(
      (s) => (s.stop as any)._id.toString() === stopId,
    );
    if (targetIdx === -1) {
      throw new NotFoundException(
        `Stop ${stopId} is not on trip ${tripId}'s route.`,
      );
    }

    const currentIdx = pos.currentStopIndex ?? 0;

    // Bus is sitting at the target stop right now.
    if (targetIdx === currentIdx) {
      return { tripId, stopId, etaSeconds: 0, atStop: true };
    }
    // Target already passed — nothing left to wait for.
    if (targetIdx < currentIdx) {
      return { tripId, stopId, etaSeconds: 0, atStop: false };
    }

    const speedKmh =
      pos.speed && pos.speed > 1 ? pos.speed : BUS_SIMULATION_SPEED_KMH;

    // Parked bus: add the remaining queue wait before it departs.
    const queueWaitSeconds =
      pos.notDepartingUntilMs && pos.notDepartingUntilMs > Date.now()
        ? (pos.notDepartingUntilMs - Date.now()) / 1000
        : 0;

    // Leg 1: current position → the immediate next stop (matches the map ETA).
    const nextIdx = currentIdx + 1;
    const nextCoords = (stops[nextIdx].stop as any).location.coordinates as [
      number,
      number,
    ];
    let etaSeconds =
      (haversineMeters([pos.longitude, pos.latitude], nextCoords) /
        (speedKmh * 1000)) *
      3600;

    // Legs 2..N: subsequent hops at routing speed + per-stop dwell, matching
    // the planner's segTime so this ETA agrees with plan/detail figures.
    for (let i = nextIdx + 1; i <= targetIdx; i++) {
      const prevCoords = (stops[i - 1].stop as any).location.coordinates as [
        number,
        number,
      ];
      const currCoords = (stops[i].stop as any).location.coordinates as [
        number,
        number,
      ];
      const segDist = haversineMeters(prevCoords, currCoords);
      etaSeconds +=
        (segDist / (BUS_ROUTING_SPEED_KMH * 1000)) * 3600 + DWELL_TIME_MIN * 60;
    }

    return {
      tripId,
      stopId,
      etaSeconds: Math.max(0, Math.round(etaSeconds + queueWaitSeconds)),
      atStop: false,
    };
  }
}
