import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { RedisService } from '../../shared/redis/redis.service';
import { BusLocation } from './entities/bus-location.schema';
import { ReportBusLocationDto } from './dto/report-bus-location.dto';
import { BUS_LOCATION_DB_WRITE_INTERVAL_MS } from '../../shared/constants/constants';
import { BUS_LOCATION_TTL_SECONDS } from '../../shared/constants/constants';

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
  /**
   * Per-trip timestamp of the last MongoDB write, used to throttle
   * persistence. Redis writes happen every tick regardless. Memory
   * footprint is bounded by the number of active trips.
   */
  private readonly lastDbWriteAt = new Map<string, number>();

  constructor(
    @InjectModel(BusLocation.name)
    private readonly busLocationModel: Model<BusLocation>,
    private readonly redisService: RedisService,
  ) {}

  async reportLocation(dto: ReportBusLocationDto): Promise<BusLocation | null> {
    const now = new Date();

    // Redis is updated on EVERY call — live ETAs and the route geo set
    // depend on this being fresh. Redis writes are cheap and bounded
    // by their TTL, so no throttle needed here.
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

    // Throttle MongoDB persistence. The simulation ticks every second; without
    // throttling that was inserting thousands of documents per bus per hour.
    // We persist at most every BUS_LOCATION_DB_WRITE_INTERVAL_MS, and we
    // upsert by trip so each trip occupies exactly one document that is
    // rewritten in place — old positions for the same bus disappear
    // automatically when the new one is written.
    const lastWrite = this.lastDbWriteAt.get(dto.tripId) ?? 0;
    if (Date.now() - lastWrite < BUS_LOCATION_DB_WRITE_INTERVAL_MS) {
      return null;
    }
    this.lastDbWriteAt.set(dto.tripId, Date.now());

    return this.busLocationModel.findOneAndUpdate(
      { trip: new Types.ObjectId(dto.tripId) },
      {
        $set: {
          bus: new Types.ObjectId(dto.busId),
          route: new Types.ObjectId(dto.routeId),
          location: {
            type: 'Point',
            coordinates: [dto.longitude, dto.latitude],
          },
          heading: dto.heading ?? null,
          speed: dto.speed ?? null,
          recordedAt: now,
        },
      },
      { upsert: true, new: true },
    );
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
