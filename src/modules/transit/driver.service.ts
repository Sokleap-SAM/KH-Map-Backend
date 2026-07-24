/* eslint-disable @typescript-eslint/no-unsafe-return */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { BusTrip, BusTripDocument } from './entities/bus-trip.schema';
import { BusTripService } from './bus-trip.service';
import { UsersService } from '../users/user.service';
import { UserRole, UserStatus } from '../users/enums/role.enum';
import { AppSettingsService } from '../app-settings/app-settings.service';
import { TransitMode } from '../app-settings/enums/transit-mode.enum';

@Injectable()
export class DriverService {
  private readonly logger = new Logger(DriverService.name);

  constructor(
    @InjectModel(BusTrip.name)
    private readonly busTripModel: Model<BusTripDocument>,
    private readonly busTripService: BusTripService,
    private readonly usersService: UsersService,
    private readonly appSettings: AppSettingsService,
    private readonly config: ConfigService,
  ) {}

  // ─── profile ───────────────────────────────────────────────────────────────

  /**
   * Returns the driver's full profile, including the assigned bus (populated)
   * — drives the dashboard header (status pill, "your bus" label) and lets
   * the frontend filter trips by the bus before fetching detail screens.
   * Strips the password fields before responding.
   */
  async getProfile(driverId: string) {
    const driver = await this.requireDriver(driverId);
    const obj = driver.toObject() as unknown as Record<string, unknown>;
    delete obj.password;
    delete obj.mqttPasswordHash;

    let assignedBus: unknown = null;
    if (driver.assignedBusId) {
      assignedBus = await this.busTripModel.db
        .collection('buses')
        .findOne({ _id: driver.assignedBusId });
    }
    return { ...obj, assignedBus };
  }

  /**
   * Every trip this driver has ever operated — scoped by `trip.driver`, not by
   * current bus assignment, so history survives admin reassigning the driver
   * to a different bus.
   *
   * Split today vs history on `startedAt` (the moment the driver actually
   * started it). Returns route + bus populated so the Trips screen can render
   * the card without a second fetch.
   *
   * Note: scheduled trips don't appear here because `driver` is stamped only
   * on start. The "what should I start next" view lives behind a separate
   * upcoming-trips query against the current bus.
   */
  async listMyTrips(driverId: string) {
    await this.requireDriver(driverId);
    const driverObjId = new Types.ObjectId(driverId);

    const trips = await this.busTripModel
      .find({ driver: driverObjId })
      .populate('route', 'name code isLine')
      .populate('bus', 'plateNumber code')
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startMs = startOfToday.getTime();

    const today: typeof trips = [];
    const history: typeof trips = [];
    for (const trip of trips) {
      const ref = trip.startedAt ?? (trip as { createdAt?: Date }).createdAt;
      const t = ref ? new Date(ref).getTime() : 0;
      if (t >= startMs) today.push(trip);
      else history.push(trip);
    }

    return { today, history };
  }

  // ─── MQTT credentials ──────────────────────────────────────────────────────

  /**
   * Issue a fresh MQTT password and broker connection info for the driver.
   * Rotates on every call — any previously-handed-out password is immediately
   * invalid. The driver app should call this once after login and store the
   * result; if the broker rejects them later they re-issue.
   *
   * Returns the only allowed publish topic so the app can't accidentally
   * publish elsewhere (the broker ACL is the actual enforcement).
   */
  async issueMqttCredentials(driverId: string) {
    this.requireLiveMode();
    const driver = await this.requireDriver(driverId);
    if (!driver.assignedBusId) {
      throw new ForbiddenException(
        'Driver must be assigned to a bus before MQTT credentials are issued',
      );
    }
    const password = await this.usersService.rotateMqttPassword(
      new Types.ObjectId(driverId),
    );
    return {
      host: this.config.get<string>('MQTT_BROKER_PUBLIC_HOST') ?? 'localhost',
      port: Number(this.config.get<string>('MQTT_BROKER_PUBLIC_PORT') ?? 1883),
      username: driverId,
      password,
      publishTopic: `driver/${driverId}/location`,
    };
  }

  // ─── status ────────────────────────────────────────────────────────────────

  // Driver toggles their availability. Turning off auto-cancels any
  // in-progress trip so a driver going off-shift never leaves a ghost bus
  // moving on the map.
  async setStatus(driverId: string, status: UserStatus) {
    const driver = await this.requireDriver(driverId);

    if (status === UserStatus.OFF && driver.status === UserStatus.ON) {
      await this.cancelActiveTripIfAny(driverId);
    }

    const updated = await this.usersService.setStatus(
      new Types.ObjectId(driverId),
      status,
    );
    return { status: updated?.status ?? status };
  }

  // ─── start trip ────────────────────────────────────────────────────────────

  /**
   * Driver claims a pre-created trip and begins operating it. Refuses if:
   *   - system isn't in live mode (simulator owns trips)
   *   - driver status is off, or driver has no assigned bus
   *   - trip doesn't exist, isn't scheduled, or doesn't belong to the
   *     driver's assigned bus (admin assigns both bus and trip)
   *   - driver already has another in-progress trip
   *
   * On success the trip flips to `in-progress` and dispatch's idle queue
   * invariant is bypassed (it's disabled in live mode anyway).
   */
  async startTrip(driverId: string, tripId: string) {
    this.requireLiveMode();
    const driver = await this.requireDriver(driverId);

    if (driver.status !== UserStatus.ON) {
      throw new ForbiddenException('Driver must be on-shift to start a trip');
    }
    if (!driver.assignedBusId) {
      throw new ForbiddenException('Driver has no assigned bus');
    }

    const trip = await this.busTripModel.findById(tripId).exec();
    if (!trip) throw new NotFoundException('Trip not found');
    if (trip.status !== 'scheduled') {
      throw new BadRequestException(
        `Trip cannot be started — current status: ${trip.status}`,
      );
    }
    if (trip.bus.toString() !== driver.assignedBusId.toString()) {
      throw new ForbiddenException(
        'Trip belongs to a different bus than the one assigned to you',
      );
    }

    const conflicting = await this.busTripModel
      .findOne({
        bus: driver.assignedBusId,
        status: 'in-progress',
      })
      .exec();
    if (conflicting) {
      throw new ConflictException(
        'Your bus already has an in-progress trip — cancel it first',
      );
    }

    return this.busTripService.startTrip(
      new Types.ObjectId(tripId),
      new Types.ObjectId(driverId),
    );
  }

  // ─── cancel trip ───────────────────────────────────────────────────────────

  // Cancels the driver's currently-running trip. Idempotent: returns
  // `{ cancelled: false }` when there's nothing active to cancel.
  async cancelActiveTrip(driverId: string) {
    return this.cancelActiveTripIfAny(driverId);
  }

  // ─── helpers ───────────────────────────────────────────────────────────────

  private requireLiveMode() {
    if (this.appSettings.getMode() !== TransitMode.LIVE) {
      throw new ForbiddenException(
        'Transit is in simulation mode — driver actions are disabled',
      );
    }
  }

  private async requireDriver(driverId: string) {
    const user = await this.usersService.findById(new Types.ObjectId(driverId));
    if (!user) throw new NotFoundException('Driver not found');
    if (user.role !== UserRole.DRIVER) {
      throw new ForbiddenException('User is not a driver');
    }
    return user;
  }

  private async cancelActiveTripIfAny(driverId: string) {
    const driver = await this.requireDriver(driverId);
    if (!driver.assignedBusId) return { cancelled: false };

    const trip = await this.busTripModel
      .findOne({
        bus: driver.assignedBusId,
        status: 'in-progress',
      })
      .exec();
    if (!trip) return { cancelled: false };

    const tripId = trip._id.toString();
    await this.busTripModel
      .updateOne(
        { _id: trip._id },
        { status: 'cancelled', completedAt: new Date() },
      )
      .exec();
    await this.busTripService.clearLiveData(tripId);

    this.logger.log(`Driver ${driverId} cancelled trip ${tripId}`);
    return { cancelled: true, tripId };
  }
}
