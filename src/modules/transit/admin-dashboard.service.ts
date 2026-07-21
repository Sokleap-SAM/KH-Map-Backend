/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BusRoute, BusRouteDocument } from './entities/bus-route.schema';
import { Bus, BusDocument } from './entities/bus.schema';
import { BusTrip, BusTripDocument } from './entities/bus-trip.schema';
import { PlaceService } from '../places/place.service';
import { UsersService } from '../users/user.service';
import { UserRole, UserStatus } from '../users/enums/role.enum';
import { AppSettingsService } from '../app-settings/app-settings.service';
import { DashboardPeriod } from './dto/dashboard-query.dto';

@Injectable()
export class AdminDashboardService {
  constructor(
    @InjectModel(BusRoute.name)
    private readonly busRouteModel: Model<BusRouteDocument>,
    @InjectModel(Bus.name)
    private readonly busModel: Model<BusDocument>,
    @InjectModel(BusTrip.name)
    private readonly busTripModel: Model<BusTripDocument>,
    private readonly placeService: PlaceService,
    private readonly usersService: UsersService,
    private readonly appSettings: AppSettingsService,
  ) {}

  /**
   * Resolve a period enum into a [start, end] window anchored at "now".
   * Start is normalised to midnight so day/week/month/year buckets feel
   * natural to the admin (a "day" view always means since midnight, not
   * a rolling 24h).
   */
  private resolveWindow(period: DashboardPeriod): { start: Date; end: Date } {
    const end = new Date();
    const start = new Date();
    start.setHours(0, 0, 0, 0);

    switch (period) {
      case DashboardPeriod.WEEK:
        start.setDate(start.getDate() - 6);
        break;
      case DashboardPeriod.MONTH:
        start.setDate(start.getDate() - 29);
        break;
      case DashboardPeriod.YEAR:
        start.setFullYear(start.getFullYear() - 1);
        start.setDate(start.getDate() + 1);
        break;
      case DashboardPeriod.DAY:
      default:
        break;
    }
    return { start, end };
  }

  /**
   * One-shot snapshot for the admin dashboard's overview cards.
   *
   * Two groups of counts:
   *  - **current**: live state of the fleet, not bound by a time window
   *    (total routes, buses, drivers on shift, trips currently active…).
   *  - **inPeriod**: counts scoped to the selected window. Drives the
   *    "trips today vs this week vs this month" toggle on the dashboard.
   *
   * All queries run in parallel via Promise.all.
   */
  async getDashboard(period: DashboardPeriod = DashboardPeriod.DAY) {
    const { start, end } = this.resolveWindow(period);
    const createdInPeriod = { createdAt: { $gte: start, $lte: end } };

    const [
      routes,
      activeRoutes,
      buses,
      drivers,
      driversOnShift,
      stops,
      activeTrips,
      scheduledTrips,
      tripsInPeriod,
      completedTripsInPeriod,
      cancelledTripsInPeriod,
      newRoutesInPeriod,
    ] = await Promise.all([
      this.busRouteModel.countDocuments().exec(),
      this.busRouteModel.countDocuments({ status: 'active' }).exec(),
      this.busModel.countDocuments().exec(),
      this.usersService.countByRole(UserRole.DRIVER),
      this.usersService.countByRole(UserRole.DRIVER, UserStatus.ON),
      this.placeService.countStops(),
      this.busTripModel.countDocuments({ status: 'in-progress' }).exec(),
      this.busTripModel.countDocuments({ status: 'scheduled' }).exec(),
      this.busTripModel.countDocuments(createdInPeriod).exec(),
      this.busTripModel
        .countDocuments({ ...createdInPeriod, status: 'completed' })
        .exec(),
      this.busTripModel
        .countDocuments({ ...createdInPeriod, status: 'cancelled' })
        .exec(),
      this.busRouteModel.countDocuments(createdInPeriod).exec(),
    ]);

    return {
      mode: this.appSettings.getMode(),
      period,
      window: { start: start.toISOString(), end: end.toISOString() },
      current: {
        routes,
        activeRoutes,
        stops,
        buses,
        drivers,
        driversOnShift,
        activeTrips,
        scheduledTrips,
      },
      inPeriod: {
        trips: tripsInPeriod,
        completedTrips: completedTripsInPeriod,
        cancelledTrips: cancelledTripsInPeriod,
        newRoutes: newRoutesInPeriod,
      },
    };
  }
}
