/* eslint-disable @typescript-eslint/no-unsafe-return */
import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { BusTrip, BusTripDocument } from './entities/bus-trip.schema';
import { CreateBusTripDto } from './dto/create-bus-trip.dto';
import { UpdateBusTripDto } from './dto/update-bus-trip.dto';
import { BusRouteStopService } from './bus-route-stop.service';
import { RedisService } from '../../shared/redis/redis.service';

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
}

@Injectable()
export class BusTripService {
  private readonly GEO_KEY = 'bus:locations';

  constructor(
    @InjectModel(BusTrip.name)
    private readonly busTripModel: Model<BusTripDocument>,
    private readonly busRouteStopService: BusRouteStopService,
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
      busImage: data.busImage || 'bus_go_right.png'
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
      busImage: data.busImage || 'bus_go_right.png'
    };
  }

  async clearLiveData(tripId: string): Promise<void> {
    await this.redisService.hdel(this.tripLiveKey(tripId));
    await this.redisService.georemove(this.GEO_KEY, tripId);
  }

  private async mergeLiveData(trip: any, live: TripLiveData | null) {
    const routeId = trip.route?._id || trip.route;
    const stops = await this.busRouteStopService.findByRoute(routeId);

    const nextStop = live && stops[live.nextStopIndex]
      ? (stops[live.nextStopIndex].stop as any).name
      : 'ស្វែងរកចំណត...';

    const destination = trip.route?.name ||
      'មិនច្បាស់លាស់';

    return {
      ...trip,
      routeNumber: trip.route?.code || '??',
      nextStopName: nextStop,
      direction: destination,
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
    });

    const live = await this.getLiveData(tripId);
    return this.mergeLiveData(trip.toObject(), live);
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

  async findByRoute(routeId: Types.ObjectId) {
    const trips = await this.busTripModel
      .find({ route: routeId })
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

      const newLng = dto.currentLocation?.coordinates[0] ?? currentLive?.longitude ?? 0;
      const busImage = this.calculateBusDirection(currentLive?.longitude ?? newLng, newLng)

      const updatedLive: TripLiveData = {
        currentStopIndex:
          dto.currentStopIndex ?? currentLive?.currentStopIndex ?? 0,
        nextStopIndex: dto.nextStopIndex ?? currentLive?.nextStopIndex ?? 0,
        passengerCount: dto.passengerCount ?? currentLive?.passengerCount ?? 0,
        longitude: newLng,
        latitude:
          dto.currentLocation?.coordinates[1] ?? currentLive?.latitude ?? 0,
        heading: 0,
        busImage: busImage,
      };
      await this.setLiveData(tripId, updatedLive);
    }

    // Clean up Redis when trip ends
    if (dto.status === 'completed' || dto.status === 'cancelled') {
      await this.clearLiveData(tripId);
    }

    return this.findOne(id);
  }

  async startTrip(id: Types.ObjectId) {
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
}
