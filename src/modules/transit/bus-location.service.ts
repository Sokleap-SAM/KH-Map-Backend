import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { RedisService } from '../../shared/redis/redis.service';
import { BusLocation } from './entities/bus-location.schema';
import { ReportBusLocationDto } from './dto/report-bus-location.dto';

/** TTL for bus location data in Redis — slightly longer than MAX_LOCATION_AGE_MS */
const BUS_LOCATION_TTL_SECONDS = 360; // 6 minutes

/** Redis key: latest ping metadata per trip */
const tripKey = (tripId: string) => `bus:trip:${tripId}:location`;
/** Redis geo set: all active bus positions keyed by tripId, grouped per route */
const routeGeoKey = (routeId: string) => `bus:route:${routeId}:geo`;

export interface LiveBusPosition {
  tripId: string;
  routeId: string;
  longitude: number;
  latitude: number;
  heading: number | null;
  speed: number | null;
  recordedAt: string; // ISO string
  /** Index of the last stop the bus departed from — used to prevent "already passed" boarding. */
  currentStopIndex?: number;
}

@Injectable()
export class BusLocationService {
  constructor(
    @InjectModel(BusLocation.name)
    private readonly busLocationModel: Model<BusLocation>,
    private readonly redisService: RedisService,
  ) {}

  async reportLocation(dto: ReportBusLocationDto): Promise<BusLocation> {
    const now = new Date();

    const doc = await this.busLocationModel.create({
      bus: new Types.ObjectId(dto.busId),
      trip: new Types.ObjectId(dto.tripId),
      route: new Types.ObjectId(dto.routeId),
      location: { type: 'Point', coordinates: [dto.longitude, dto.latitude] },
      heading: dto.heading ?? null,
      speed: dto.speed ?? null,
      recordedAt: now,
    });

    const payload: LiveBusPosition = {
      tripId: dto.tripId,
      routeId: dto.routeId,
      longitude: dto.longitude,
      latitude: dto.latitude,
      heading: dto.heading ?? null,
      speed: dto.speed ?? null,
      recordedAt: now.toISOString(),
      currentStopIndex: dto.currentStopIndex,
    };
    await Promise.all([
      this.redisService.set(
        tripKey(dto.tripId),
        payload,
        BUS_LOCATION_TTL_SECONDS,
      ),
      this.redisService
        .geoadd(
          routeGeoKey(dto.routeId),
          dto.longitude,
          dto.latitude,
          dto.tripId,
        )
        .then(() =>
          this.redisService.expire(
            routeGeoKey(dto.routeId),
            BUS_LOCATION_TTL_SECONDS,
          ),
        ),
    ]);

    return doc;
  }

  async getLivePosition(tripId: string): Promise<LiveBusPosition | null> {
    return this.redisService.get<LiveBusPosition>(tripKey(tripId));
  }

  async getLivePositionsByRoute(routeId: string): Promise<LiveBusPosition[]> {
    // Get all tripIds currently in the geo set for this route
    const tripIds = await this.redisService.geosearch(
      routeGeoKey(routeId),
      // search from an arbitrary centre that covers the whole country (~1000 km radius)
      104.99,
      12.56, // Cambodia centroid
      1_000_000, // metres
    );

    if (tripIds.length === 0) return [];

    const results = await Promise.all(
      tripIds.map((id) => this.redisService.get<LiveBusPosition>(tripKey(id))),
    );

    // Filter out any entries whose TTL has already expired
    return results.filter((r): r is LiveBusPosition => r !== null);
  }
}
