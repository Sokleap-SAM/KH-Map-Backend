import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { MqttService } from '../../shared/mqtt/mqtt.service';
import { BusLocationService } from './bus-location.service';
import { BusTripService } from './bus-trip.service';
import { BusTrip, BusTripDocument } from './entities/bus-trip.schema';
import { UsersService } from '../users/user.service';
import { UserRole, UserStatus } from '../users/enums/role.enum';
import { AppSettingsService } from '../app-settings/app-settings.service';
import { TransitMode } from '../app-settings/enums/transit-mode.enum';

// Largest accepted clock skew between driver-device timestamp and server.
// Bigger windows let stale/replayed publishes through; smaller windows reject
// legitimate publishes from devices with poor clock sync. 60 s is a common
// pragmatic floor for fleet tracking.
const MAX_RECORDED_AT_SKEW_MS = 60_000;

// Minimum interval between accepted publishes from one driver. Stops a
// buggy/malicious driver app from saturating the broker even after auth.
const MIN_PUBLISH_INTERVAL_MS = 500;

interface DriverLocationPayload {
  longitude: number;
  latitude: number;
  heading?: number;
  speed?: number;
  recordedAt?: string;
  sequence?: number;
}

@Injectable()
export class DriverLocationSubscriberService implements OnModuleInit {
  private readonly logger = new Logger(DriverLocationSubscriberService.name);

  // Per-driver guard against out-of-order and too-frequent publishes. Kept
  // in-process — single source of truth is fine because driver auth pins
  // each driver to one MQTT session at a time.
  private readonly lastSequenceByDriver = new Map<string, number>();
  private readonly lastPublishAtByDriver = new Map<string, number>();

  constructor(
    @InjectModel(BusTrip.name)
    private readonly busTripModel: Model<BusTripDocument>,
    private readonly mqtt: MqttService,
    private readonly busLocationService: BusLocationService,
    private readonly busTripService: BusTripService,
    private readonly usersService: UsersService,
    private readonly appSettings: AppSettingsService,
  ) {}

  onModuleInit(): void {
    this.mqtt.subscribe('driver/+/location', (topic, payload) => {
      void this.handleMessage(topic, payload);
    });
  }

  private async handleMessage(topic: string, payload: Buffer): Promise<void> {
    // Bail fast if we're not in real-world mode. Belt-and-braces: the broker
    // ACL should already reject anyone other than the backend in simulation
    // mode, but this stops a misrouted publish from polluting Redis.
    if (this.appSettings.getMode() !== TransitMode.LIVE) return;

    // The driverId comes from the topic, NEVER the payload. The broker ACL
    // pinned the publisher to their own driverId topic, so trusting the
    // topic-derived value defeats payload spoofing.
    const driverId = extractDriverId(topic);
    if (!driverId) return;

    const now = Date.now();
    const lastPub = this.lastPublishAtByDriver.get(driverId) ?? 0;
    if (now - lastPub < MIN_PUBLISH_INTERVAL_MS) return;

    let data: DriverLocationPayload;
    try {
      data = JSON.parse(payload.toString('utf8')) as DriverLocationPayload;
    } catch {
      this.logger.warn(`Invalid JSON on ${topic}`);
      return;
    }
    if (!isValidPayload(data)) {
      this.logger.warn(`Invalid payload shape on ${topic}`);
      return;
    }

    // Time-skew window — rejects publishes that were too long ago (replay)
    // or claim to be from the future (clock drift exploit).
    if (data.recordedAt) {
      const ts = Date.parse(data.recordedAt);
      if (
        !Number.isFinite(ts) ||
        Math.abs(now - ts) > MAX_RECORDED_AT_SKEW_MS
      ) {
        this.logger.warn(
          `Stale/skewed recordedAt from driver ${driverId} on ${topic}`,
        );
        return;
      }
    }

    // Monotonic sequence check — drops out-of-order and replayed publishes.
    if (typeof data.sequence === 'number') {
      const lastSeq = this.lastSequenceByDriver.get(driverId) ?? -Infinity;
      if (data.sequence <= lastSeq) return;
      this.lastSequenceByDriver.set(driverId, data.sequence);
    }

    // Driver state checks. Each one is independently required — a stale
    // credential should NOT be enough on its own.
    let driverObjId: Types.ObjectId;
    try {
      driverObjId = new Types.ObjectId(driverId);
    } catch {
      return;
    }
    const driver = await this.usersService.findById(driverObjId);
    if (!driver) return;
    if (driver.role !== UserRole.DRIVER) return;
    if (driver.status !== UserStatus.ON) return;
    if (!driver.assignedBusId) return;

    const trip = await this.busTripModel
      .findOne({ bus: driver.assignedBusId, status: 'in-progress' })
      .exec();
    if (!trip) return;

    const tripId = trip._id.toString();
    const busId = driver.assignedBusId.toString();
    const routeId = trip.route.toString();

    this.lastPublishAtByDriver.set(driverId, now);

    // Persist live position into BOTH Redis layers the simulator writes to:
    //   1. BusLocationService — used by routing for live ETAs
    //   2. BusTripService.setLiveData — used by GET /transit/trips/active
    //      and findNearby. Without this the rider app sees the trip but no
    //      bus marker, because mergeLiveData returns currentLocation=null.
    // Stop indices are preserved from the previous tick (driver doesn't
    // signal stop arrivals yet) — first publish on a fresh trip starts at 0.
    try {
      await this.busLocationService.reportLocation({
        busId,
        tripId,
        routeId,
        longitude: data.longitude,
        latitude: data.latitude,
        heading: data.heading,
        speed: data.speed,
      });

      const previous = await this.busTripService.getLiveData(tripId);
      await this.busTripService.setLiveData(tripId, {
        currentStopIndex: previous?.currentStopIndex ?? 0,
        nextStopIndex: previous?.nextStopIndex ?? 1,
        passengerCount: previous?.passengerCount ?? 0,
        longitude: data.longitude,
        latitude: data.latitude,
        heading: data.heading ?? 0,
        busImage: previous?.busImage ?? 'bus_go_right.png',
      });
    } catch (err) {
      this.logger.warn(
        `reportLocation failed for driver ${driverId} trip ${tripId}: ${(err as Error).message}`,
      );
      return;
    }

    // Mirror to the public route-position topic so map clients see the bus
    // move regardless of whether the source is sim or live driver.
    this.mqtt.publish(
      `transit/route/${routeId}/position`,
      {
        tripId,
        busId,
        routeId,
        longitude: data.longitude,
        latitude: data.latitude,
        heading: data.heading ?? 0,
        speed: data.speed ?? 0,
        recordedAt: new Date(now).toISOString(),
        source: 'driver',
      },
      { qos: 0, retain: true },
    );

    this.logger.log(
      `[live] driver=${driverId} bus=${busId} trip=${tripId} route=${routeId} @ ${data.longitude.toFixed(5)},${data.latitude.toFixed(5)} spd=${data.speed ?? 0}`,
    );
  }
}

// Topic shape is `driver/<driverId>/location`. Validates length to keep
// pathological topic patterns out of downstream lookups.
function extractDriverId(topic: string): string | null {
  const parts = topic.split('/');
  if (parts.length !== 3 || parts[0] !== 'driver' || parts[2] !== 'location') {
    return null;
  }
  const id = parts[1];
  if (id.length < 12 || id.length > 64) return null;
  return id;
}

function isValidPayload(p: unknown): p is DriverLocationPayload {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  if (typeof o.longitude !== 'number' || !Number.isFinite(o.longitude))
    return false;
  if (typeof o.latitude !== 'number' || !Number.isFinite(o.latitude))
    return false;
  if (o.heading != null && typeof o.heading !== 'number') return false;
  if (o.speed != null && typeof o.speed !== 'number') return false;
  if (o.recordedAt != null && typeof o.recordedAt !== 'string') return false;
  if (o.sequence != null && typeof o.sequence !== 'number') return false;
  return true;
}
