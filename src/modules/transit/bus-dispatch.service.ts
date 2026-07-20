import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { BusRoute, BusRouteDocument } from './entities/bus-route.schema';
import { Bus, BusDocument } from './entities/bus.schema';
import { BusTrip, BusTripDocument } from './entities/bus-trip.schema';
import {
  BusLocation,
  BusLocationDocument,
} from './entities/bus-location.schema';
import { BusLocationService } from './bus-location.service';
import { RedisService } from '../../shared/redis/redis.service';
import { AppSettingsService } from '../app-settings/app-settings.service';
import { TransitMode } from '../app-settings/enums/transit-mode.enum';

/**
 * Automated bus dispatching that maintains a per-route "queue":
 *
 *   - Every active route has ≥ 1 in-progress trip and exactly 1 scheduled
 *     trip waiting at stop 0.
 *   - Every `headwayMinutes`, the scheduled trip is promoted to in-progress
 *     (the next bus departs) and a new scheduled trip is queued behind it.
 *   - When an in-progress trip completes (bus reaches the last stop), that
 *     bus is re-queued onto the same route IF no other bus is already
 *     scheduled — otherwise the bus goes idle until needed.
 *
 * The fleet grows until completed buses begin filling the scheduled slot
 * on their own, at which point the system self-stabilises (steady-state
 * fleet size ≈ ceil(loopDuration / headway)).
 *
 * Driven from `BusSimulationService.syncActiveTrips` so it runs only on the
 * lock-holding simulator instance.
 */
@Injectable()
export class BusDispatchService {
  private readonly logger = new Logger(BusDispatchService.name);

  constructor(
    @InjectModel(BusRoute.name)
    private readonly busRouteModel: Model<BusRouteDocument>,
    @InjectModel(Bus.name)
    private readonly busModel: Model<BusDocument>,
    @InjectModel(BusTrip.name)
    private readonly busTripModel: Model<BusTripDocument>,
    @InjectModel(BusLocation.name)
    private readonly busLocationModel: Model<BusLocationDocument>,
    private readonly busLocationService: BusLocationService,
    private readonly redisService: RedisService,
    private readonly appSettings: AppSettingsService,
  ) {}

  /**
   * DEV ONLY: wipe every bus, trip, and bus-location record in Mongo, plus
   * every Redis key the simulator/router keeps for these entities. Intended
   * for resetting a local environment back to "route exists, no fleet" so
   * dispatch's bootstrap path runs fresh.
   *
   * Keeps `BusRoute` and `BusRouteStop` collections intact — the network
   * graph survives so plan requests still know what exists; only the fleet
   * is reset.
   */
  async resetAllFleet(): Promise<{
    mongoDeleted: { trips: number; buses: number; busLocations: number };
    redisDeleted: number;
  }> {
    const [trips, buses, busLocations] = await Promise.all([
      this.busTripModel.deleteMany({}).exec(),
      this.busModel.deleteMany({}).exec(),
      this.busLocationModel.deleteMany({}).exec(),
    ]);

    const redisDeleted =
      (await this.redisService.deleteByPattern('bus:trip:*:location')) +
      (await this.redisService.deleteByPattern('bus:route:*:geo')) +
      (await this.redisService.deleteByPattern('trip:live:*')) +
      (await this.redisService.deleteByPattern('route:lastDeparture:*'));
    // Also clear the BusTripService's shared geo set.
    await this.redisService.del('bus:locations');

    this.logger.warn(
      `Fleet reset: deleted ${trips.deletedCount} trips, ${buses.deletedCount} buses, ${busLocations.deletedCount} bus_locations from Mongo and ${redisDeleted} Redis keys`,
    );

    return {
      mongoDeleted: {
        trips: trips.deletedCount ?? 0,
        buses: buses.deletedCount ?? 0,
        busLocations: busLocations.deletedCount ?? 0,
      },
      redisDeleted,
    };
  }

  /**
   * Cancel every scheduled and in-progress trip and clear their live-state
   * Redis keys. Used when admin flips to live mode — buses stay (drivers will
   * operate them) but the sim-generated queue must be wiped so the real-world
   * fleet starts from a clean slate.
   */
  async cancelAllActiveTrips(): Promise<{ cancelled: number }> {
    const result = await this.busTripModel
      .updateMany(
        { status: { $in: ['in-progress', 'scheduled'] } },
        { status: 'cancelled', completedAt: new Date() },
      )
      .exec();

    await this.redisService.deleteByPattern('bus:trip:*:location');
    await this.redisService.deleteByPattern('trip:live:*');
    await this.redisService.deleteByPattern('route:lastDeparture:*');
    await this.redisService.del('bus:locations');

    this.logger.warn(
      `Mode flip to live: cancelled ${result.modifiedCount} active trips and cleared sim Redis state`,
    );
    return { cancelled: result.modifiedCount ?? 0 };
  }

  /**
   * Visit every active route and apply the queue invariant. Idempotent and
   * fire-and-forget safe — running more often than necessary just means
   * extra DB queries.
   */
  async run(): Promise<void> {
    // Real-world mode: trips are created by admin and started by drivers —
    // dispatch must not auto-spawn or auto-promote anything.
    if (this.appSettings.getMode() === TransitMode.LIVE) return;

    const routes = await this.busRouteModel
      .find({ status: 'active' })
      .lean()
      .exec();

    for (const route of routes) {
      try {
        await this.dispatchForRoute(route);
      } catch (err) {
        this.logger.warn(
          `Dispatch failed for route ${String(route._id)}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Called by the simulator when a bus reaches the last stop of its route.
   * The trip is marked completed; if no scheduled trip exists for this
   * route, this bus is re-queued onto it as the new scheduled trip.
   *
   * If the route already has a scheduled bus waiting, this one goes idle
   * (DB has no further trip for it until a future dispatch tick adds one,
   * which only happens when the queue drains).
   */
  async onTripCompleted(
    tripId: string,
    busId: string,
    routeId: string,
  ): Promise<void> {
    await this.busTripModel
      .updateOne(
        { _id: new Types.ObjectId(tripId) },
        { status: 'completed', completedAt: new Date() },
      )
      .exec();

    const hasScheduled = await this.busTripModel.exists({
      route: new Types.ObjectId(routeId),
      status: 'scheduled',
    });

    if (!hasScheduled) {
      await this.busTripModel.create({
        route: new Types.ObjectId(routeId),
        bus: new Types.ObjectId(busId),
        status: 'scheduled',
      });
      this.logger.log(
        `Trip ${tripId} completed — re-queued bus ${busId} as scheduled on route ${routeId}`,
      );
    } else {
      this.logger.log(
        `Trip ${tripId} completed — bus ${busId} idle (another bus already scheduled on route ${routeId})`,
      );
    }
  }

  // ─── Per-route logic ───────────────────────────────────────────────────────

  private async dispatchForRoute(route: {
    _id: Types.ObjectId;
    code?: string | null;
    headwayMinutes?: number | null;
  }): Promise<void> {
    const routeId = String(route._id);
    const headway = route.headwayMinutes ?? 30;

    const trips = await this.busTripModel
      .find({
        route: route._id,
        status: { $in: ['scheduled', 'in-progress'] },
      })
      .sort({ createdAt: 1 })
      .lean()
      .exec();

    const inProgress = trips.filter((t) => t.status === 'in-progress');
    const scheduled = trips.filter((t) => t.status === 'scheduled');

    // Bootstrap: brand-new route, no trips at all → create the initial pair.
    if (inProgress.length === 0 && scheduled.length === 0) {
      await this.bootstrap(route);
      return;
    }

    // Headway promotion: if `headway` minutes have passed since the route's
    // last departure from stop 0, promote the oldest scheduled trip. The
    // anchor is set authoritatively in both `bootstrap()` and the promotion
    // branch below, so reading it here should always succeed once the route
    // has had at least one bootstrap. If the anchor is missing for any
    // reason (Redis flush, schema bump), treat it as "just now" so we don't
    // spuriously promote — better a one-tick delay than a runaway bus mint.
    const anchors = await this.busLocationService.getRouteDepartureAnchors([
      routeId,
    ]);
    const last = anchors.get(routeId);
    if (last === undefined) {
      // Self-heal: write an anchor at "now" so subsequent ticks have a
      // sane baseline. The bus that's currently in-progress has been
      // moving for some unknown duration, but pretending it just left is
      // safer than pretending an infinite amount of time has passed.
      await this.busLocationService.setRouteDepartureAnchor(
        routeId,
        Date.now(),
      );
    }
    const elapsedMin = last !== undefined ? (Date.now() - last) / 60_000 : 0;

    if (elapsedMin >= headway && scheduled.length > 0) {
      const next = scheduled[0];
      await this.busTripModel
        .updateOne(
          { _id: next._id },
          { status: 'in-progress', startedAt: new Date() },
        )
        .exec();
      // Set anchor synchronously here (not just from the simulator's
      // initTrip) so the next dispatch tick can read a fresh value. Without
      // this, the simulator's fire-and-forget anchor write can race against
      // the next dispatch.run(), making elapsedMin appear as Infinity and
      // triggering another spurious promotion → new bus every tick.
      await this.busLocationService.setRouteDepartureAnchor(
        routeId,
        Date.now(),
      );
      this.logger.log(
        `Promoted trip ${String(next._id)} to in-progress on route ${route.code ?? routeId}`,
      );
    }

    // Maintain the "exactly one scheduled" invariant. Re-read because the
    // promotion above may have just consumed the only scheduled trip.
    // const stillScheduled = await this.busTripModel.countDocuments({
    //   route: route._id,
    //   status: 'scheduled',
    // });

    // if (stillScheduled === 0) {
    //   // Prevent races where multiple dispatch ticks concurrently try to
    //   // create the single scheduled slot. Use Redis `SETNX` as a cheap
    //   // per-route guard so only one process mints a new scheduled trip.
    //   const scheduledLockKey = `dispatch:route:${routeId}:scheduled-lock`;
    //   const acquired = await this.redisService.setnx(scheduledLockKey, '1', 60);
    //   if (!acquired) {
    //     this.logger.log(
    //       `Another dispatcher already queued a scheduled trip for route ${route.code ?? routeId}`,
    //     );
    //     return;
    //   }

    //   try {
    //     const idleBusId = await this.findIdleBusForRoute(route._id);
    //     if (idleBusId) {
    //       await this.busTripModel.create({
    //         route: route._id,
    //         bus: idleBusId,
    //         status: 'scheduled',
    //       });
    //       this.logger.log(
    //         `Re-queued idle bus ${String(idleBusId)} on route ${route.code ?? routeId}`,
    //       );
    //     } else {
    //       const bus = await this.createNewBus(route);
    //       try {
    //         await this.busTripModel.create({
    //           route: route._id,
    //           bus: bus._id,
    //           status: 'scheduled',
    //         });
    //         this.logger.log(
    //           `Added new bus ${bus.busNumber} to queue on route ${route.code ?? routeId}`,
    //         );
    //       } catch (err) {
    //         // If creating the scheduled trip conflicted (rare race), remove
    //         // the orphaned bus we just created to avoid steady leakage.
    //         const e = err as { code?: number };
    //         if (e?.code === 11000) {
    //           await this.busModel.deleteOne({ _id: bus._id }).exec();
    //           this.logger.warn(
    //             `Scheduled-trip creation conflicted; removed orphaned bus ${bus.busNumber}`,
    //           );
    //         } else {
    //           throw err;
    //         }
    //       }
    //     }
    //   } finally {
    //     await this.redisService.del(scheduledLockKey);
    //   }
    // }
    // Maintain the "exactly one scheduled" invariant.
    const stillScheduled = await this.busTripModel.countDocuments({
      route: route._id,
      status: 'scheduled',
    });

    // NEW: Count total active physical buses on this specific route
    const totalActiveOnRoute = await this.busTripModel.countDocuments({
      route: route._id,
      status: { $in: ['scheduled', 'in-progress'] },
    });

    // NEW: Define a structural cap to prevent infinite minting.
    // Ideally ceil(loopDuration / headway). 10 is a safe fallback.
    const fleetCap = 10;

    if (stillScheduled === 0) {
      const scheduledLockKey = `dispatch:route:${routeId}:scheduled-lock`;
      const acquired = await this.redisService.setnx(scheduledLockKey, '1', 60);
      if (!acquired) {
        this.logger.log(
          `Another dispatcher already queued a scheduled trip for route ${route.code ?? routeId}`,
        );
        return;
      }

      try {
        const idleBusId = await this.findIdleBusForRoute(route._id);
        if (idleBusId) {
          await this.busTripModel.create({
            route: route._id,
            bus: idleBusId,
            status: 'scheduled',
          });
          this.logger.log(
            `Re-queued idle bus ${String(idleBusId)} on route ${route.code ?? routeId}`,
          );
        } else if (totalActiveOnRoute < fleetCap) {
          // FIX: ONLY mint a new physical bus if we haven't hit the route's steady-state capacity
          const bus = await this.createNewBus(route);
          try {
            await this.busTripModel.create({
              route: route._id,
              bus: bus._id,
              status: 'scheduled',
            });
            this.logger.log(
              `Added new bus ${bus.busNumber} to queue on route ${route.code ?? routeId}`,
            );
          } catch (err) {
            const e = err as { code?: number };
            if (e?.code === 11000) {
              await this.busModel.deleteOne({ _id: bus._id }).exec();
              this.logger.warn(
                `Scheduled-trip creation conflicted; removed orphaned bus ${bus.busNumber}`,
              );
            } else {
              throw err;
            }
          }
        } else {
          // The cap has been reached. We don't mint a new bus; we wait for an in-progress bus to finish.
          this.logger.debug(
            `Route ${route.code ?? routeId} is at fleet capacity (${totalActiveOnRoute}/${fleetCap}). Waiting for a trip to complete.`,
          );
        }
      } finally {
        await this.redisService.del(scheduledLockKey);
      }
    }
  }

  /**
   * Returns the ObjectId of a bus that has run on this route before
   * (i.e. has at least one completed trip on it) but has no current
   * scheduled or in-progress trip on any route. Such buses are sitting
   * idle and should be re-queued before minting a new one.
   *
   * Returns null if no idle candidate exists.
   */
  // private async findIdleBusForRoute(
  //   routeId: Types.ObjectId,
  // ): Promise<Types.ObjectId | null> {
  //   // Buses that have ever run this route (any trip status).
  //   const everOnRoute = (await this.busTripModel.distinct('bus', {
  //     route: routeId,
  //   })) as Types.ObjectId[];
  //   if (everOnRoute.length === 0) return null;

  //   // Of those, drop the ones that currently have an active trip ANYWHERE.
  //   // (Active = scheduled or in-progress on any route, in case a bus moved
  //   // to a different route — though the typical case is same-route.)
  //   const busyBusIds = new Set<string>(
  //     (
  //       (await this.busTripModel.distinct('bus', {
  //         bus: { $in: everOnRoute },
  //         status: { $in: ['scheduled', 'in-progress'] },
  //       })) as Types.ObjectId[]
  //     ).map((id) => String(id)),
  //   );

  //   for (const candidate of everOnRoute) {
  //     if (!busyBusIds.has(String(candidate))) return candidate;
  //   }
  //   return null;
  // }
  private async findIdleBusForRoute(
    routeId: Types.ObjectId,
  ): Promise<Types.ObjectId | null> {
    // 1. Get IDs of all buses currently busy on ANY route
    const busyBusIds = await this.busTripModel.distinct('bus', {
      status: { $in: ['scheduled', 'in-progress'] },
    });

    // 2. Find ANY bus not in that busy list
    const idleBus = await this.busModel
      .findOne({
        _id: { $nin: busyBusIds },
        status: 'in-service',
      })
      .lean()
      .exec();

    return idleBus ? (idleBus._id as Types.ObjectId) : null;
  }

  private async bootstrap(route: {
    _id: Types.ObjectId;
    code?: string | null;
  }): Promise<void> {
    const bus1 = await this.createNewBus(route);
    const bus2 = await this.createNewBus(route);

    await this.busTripModel.create({
      route: route._id,
      bus: bus1._id,
      status: 'in-progress',
      startedAt: new Date(),
    });
    await this.busTripModel.create({
      route: route._id,
      bus: bus2._id,
      status: 'scheduled',
    });

    // Anchor at bootstrap time. Same reason as in the promotion branch —
    // we can't depend on the simulator's initTrip to set it in time before
    // the next dispatch tick reads it.
    await this.busLocationService.setRouteDepartureAnchor(
      String(route._id),
      Date.now(),
    );

    this.logger.log(
      `Bootstrapped route ${route.code ?? String(route._id)} with buses ${bus1.busNumber} (in-progress) and ${bus2.busNumber} (scheduled)`,
    );
  }

  // ─── Bus creation ─────────────────────────────────────────────────────────

  /**
   * Mint a new bus document for this route. The bus number is
   * `{routeCode}-{NNN}` where NNN auto-increments by counting buses already
   * in the fleet whose number matches `{routeCode}-NNN`. The license plate
   * is `PPP-NNN` with NNN a random 3-digit number not already in use.
   *
   * We count `Bus` documents directly rather than counting via `BusTrip`,
   * because during bootstrap two buses are created *before* their trips
   * exist — counting via trips would return zero for both and produce a
   * `busNumber` collision. The retry loop covers any remaining races
   * (e.g. two dispatch ticks running simultaneously).
   */
  private async createNewBus(route: {
    _id: Types.ObjectId;
    code?: string | null;
  }): Promise<BusDocument> {
    const code = route.code ?? 'BUS';
    const codeRegex = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const numberPattern = new RegExp(`^${codeRegex}-\\d+$`);

    for (let attempt = 0; attempt < 10; attempt++) {
      const count = await this.busModel.countDocuments({
        busNumber: numberPattern,
      });
      const busNumber = `${code}-${String(count + 1 + attempt).padStart(3, '0')}`;

      // Generate a unique PPP-### plate. Re-rolled per attempt because a
      // duplicate plate (rare but possible) shouldn't waste a busNumber slot.
      const usedPlates = new Set<string>(
        (
          await this.busModel
            .find({ licensePlate: /^PPP-/ }, 'licensePlate')
            .lean()
            .exec()
        ).map((b) => b.licensePlate ?? ''),
      );
      let licensePlate = '';
      for (let plateAttempt = 0; plateAttempt < 100; plateAttempt++) {
        const n = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
        const candidate = `PPP-${n}`;
        if (!usedPlates.has(candidate)) {
          licensePlate = candidate;
          break;
        }
      }
      if (!licensePlate) {
        throw new Error(
          `Could not generate a unique PPP-### license plate after 100 attempts (${usedPlates.size} plates in use)`,
        );
      }

      try {
        return await this.busModel.create({
          busNumber,
          licensePlate,
          capacity: 25,
          status: 'in-service',
        });
      } catch (err) {
        // Duplicate-key on busNumber or licensePlate — retry with the next
        // counter value. Surfaces as MongoServerError code 11000.
        const e = err as { code?: number; message?: string };
        if (e?.code === 11000) {
          this.logger.warn(
            `createNewBus: duplicate "${busNumber}" on attempt ${attempt + 1}, retrying`,
          );
          continue;
        }
        throw err;
      }
    }

    throw new Error(
      `createNewBus: exhausted 10 attempts trying to mint a unique bus for route ${code}`,
    );
  }
}
