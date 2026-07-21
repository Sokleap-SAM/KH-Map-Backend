import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/enums/role.enum';
import { AppSettingsService } from '../app-settings/app-settings.service';
import { TransitMode } from '../app-settings/enums/transit-mode.enum';
import { SetTransitModeDto } from './dto/set-transit-mode.dto';
import { BusRouteService } from './bus-route.service';
import { BusRouteStopService } from './bus-route-stop.service';
import { BusService } from './bus.service';
import { BusTripService } from './bus-trip.service';
import { CreateBusRouteDto } from './dto/create-bus-route.dto';
import { UpdateBusRouteDto } from './dto/update-bus-route.dto';
import { CreateBusRouteStopDto } from './dto/create-bus-route-stop.dto';
import { UpdateBusRouteStopDto } from './dto/update-bus-route-stop.dto';
import { BulkBusRouteStopsDto } from './dto/bulk-bus-route-stops.dto';
import { SuggestPathDto } from './dto/suggest-path.dto';
import { DashboardQueryDto } from './dto/dashboard-query.dto';
import { ValhallaService } from './valhalla.service';
import { AdminDashboardService } from './admin-dashboard.service';
import { CreateBusDto } from './dto/create-bus.dto';
import { UpdateBusDto } from './dto/update-bus.dto';
import { CreateBusTripDto } from './dto/create-bus-trip.dto';
import { UpdateBusTripDto } from './dto/update-bus-trip.dto';
import { TransitRoutingService } from './transit-routing.service';
import { BusLocationService } from './bus-location.service';
import { BusSimulationService } from './bus-simulation.service';
import { BusDispatchService } from './bus-dispatch.service';
import { FavoriteTransitRouteService } from './favorite-transit-route.service';
import { PlanRouteDto } from './dto/plan-route.dto';
import { ReportBusLocationDto } from './dto/report-bus-location.dto';
import { CreateFavoriteTransitRouteDto } from './dto/create-favorite-transit-route.dto';

@Controller('transit')
export class TransitController {
  constructor(
    private readonly busRouteService: BusRouteService,
    private readonly busRouteStopService: BusRouteStopService,
    private readonly busService: BusService,
    private readonly busTripService: BusTripService,
    private readonly transitRoutingService: TransitRoutingService,
    private readonly busLocationService: BusLocationService,
    private readonly busSimulationService: BusSimulationService,
    private readonly busDispatchService: BusDispatchService,
    private readonly favoriteTransitRouteService: FavoriteTransitRouteService,
    private readonly appSettings: AppSettingsService,
    private readonly valhallaService: ValhallaService,
    private readonly adminDashboardService: AdminDashboardService,
  ) {}

  // ─── Admin: global transit mode ───────────────────────────────────────────

  /** GET /transit/admin/settings/mode → { mode } */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('admin/settings/mode')
  getMode() {
    return { mode: this.appSettings.getMode() };
  }

  /**
   * One-shot snapshot for the admin dashboard's overview cards.
   * `?period=day|week|month|year` (default `day`) scopes the in-period
   * trip and route counts; the current-state counts are always live.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('admin/dashboard')
  getDashboard(@Query() query: DashboardQueryDto) {
    return this.adminDashboardService.getDashboard(query.period);
  }

  /**
   * Flip the global transit mode. Orchestrates the side-effects so the
   * system is consistent the moment the response returns:
   *   - to `live`: cancel every scheduled/in-progress sim trip, stop the
   *     simulator loop. Drivers can now start their own assigned trips.
   *   - to `simulation`: restart the simulator loop. Dispatch will bootstrap
   *     fresh trips on its next sync tick.
   *
   * PATCH /transit/admin/settings/mode  { mode: 'live' | 'simulation' }
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch('admin/settings/mode')
  async setMode(@Body() dto: SetTransitModeDto) {
    const previous = this.appSettings.getMode();
    if (previous === dto.mode) {
      return { mode: dto.mode, changed: false };
    }

    // Flip the flag first so downstream services see the new mode.
    await this.appSettings.setMode(dto.mode);

    try {
      if (dto.mode === TransitMode.LIVE) {
        this.busSimulationService.stop();
        const cancelled = await this.busDispatchService.cancelAllActiveTrips();
        return { mode: dto.mode, changed: true, ...cancelled };
      }
      // simulation
      await this.busSimulationService.start();
      return { mode: dto.mode, changed: true };
    } catch (err) {
      // The mode flag is already flipped but the side-effect failed —
      // revert so the flag reflects reality. Then surface a 503 so the
      // admin can retry rather than assuming the flip succeeded.
      await this.appSettings.setMode(previous);
      throw new ServiceUnavailableException(
        `Failed to apply mode change; reverted to ${previous}. Original error: ${(err as Error).message}`,
      );
    }
  }

  // ─── Route Planning ────────────────────────────────────────

  /**
   * Plan a route from origin to destination.
   *
   * type=walk   — returns a single walking-only path (no transit)
   * type=transit — returns up to 3 walking+bus options (must include a bus)
   *
   * GET /transit/plan?originLng=104.928&originLat=11.556&destLng=104.934&destLat=11.572&type=transit
   */
  @Get('plan')
  planRoute(@Query() query: PlanRouteDto): Promise<unknown> {
    return this.transitRoutingService.planRoute(
      [query.originLng, query.originLat],
      [query.destLng, query.destLat],
      query.type,
      query.language,
    );
  }

  // ─── Bus Location (Live Tracking) ─────────────────────────────────

  /**
   * Called by the bus driver app at regular intervals to report the bus's
   * current GPS position. Used to compute real-time ETAs during route planning.
   *
   * POST /transit/buses/location
   */
  @Post('buses/location')
  reportBusLocation(@Body() dto: ReportBusLocationDto) {
    return this.busLocationService.reportLocation(dto);
  }

  // ─── Bus Routes ────────────────────────────────────────────

  @Post('routes')
  async createRoute(@Body() dto: CreateBusRouteDto) {
    const result = await this.busRouteService.create(dto);
    await this.transitRoutingService.invalidateNetworkCache();
    return result;
  }

  @Get('routes')
  findAllRoutes() {
    return this.busRouteService.findAll();
  }

  @Get('routes/active')
  findActiveRoutes() {
    return this.busRouteService.findActive();
  }

  /** Returns routes where isLine=true — used by frontend to draw corridor geometry */
  @Get('routes/lines')
  findLines() {
    return this.busRouteService.findLines();
  }

  @Get('routes/:id')
  findOneRoute(@Param('id') id: string) {
    return this.busRouteService.findOne(new Types.ObjectId(id));
  }

  @Patch('routes/:id')
  async updateRoute(@Param('id') id: string, @Body() dto: UpdateBusRouteDto) {
    const result = await this.busRouteService.update(
      new Types.ObjectId(id),
      dto,
    );
    await this.transitRoutingService.invalidateNetworkCache();
    return result;
  }

  @Delete('routes/:id')
  async removeRoute(@Param('id') id: string) {
    const result = await this.busRouteService.remove(new Types.ObjectId(id));
    await this.transitRoutingService.invalidateNetworkCache();
    return result;
  }

  // ─── Route Stops ───────────────────────────────────────────

  /**
   * Bulk-create stops on a route from a sequence of map clicks. If `routeId`
   * is omitted a fresh BusRoute is created from the metadata fields; if it's
   * provided the stops are appended after the existing tail.
   *
   * Segment geometry per non-first stop: provide `segmentFromPrevious`
   * (verbatim, from suggest-path) OR omit it and the backend computes the
   * road path via Valhalla — optionally steered through the item's `vias`.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post('admin/route-stops/bulk')
  async bulkCreateRouteStops(@Body() dto: BulkBusRouteStopsDto) {
    const result = await this.busRouteStopService.bulkUpsert(dto);
    await this.transitRoutingService.invalidateNetworkCache();
    this.busSimulationService.evictRoute(result.routeId);
    return result;
  }

  /**
   * Preview helper for the admin's route editor. Returns Valhalla's
   * road-snapped polyline between two coords using `costing=auto`,
   * optionally forced through `vias` — points the admin drops on the
   * specific road the bus takes when the default road is wrong. The admin
   * accepts the preview and the frontend submits it verbatim.
   *
   * POST /transit/admin/suggest-path
   * { from: [lng,lat], to: [lng,lat], vias?: [[lng,lat], ...] }
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post('admin/suggest-path')
  async suggestPath(@Body() dto: SuggestPathDto) {
    const result = await this.valhallaService.getAutoPath(
      dto.from,
      dto.to,
      dto.vias ?? [],
    );
    if (!result) {
      throw new ServiceUnavailableException(
        'Valhalla could not route between the given points',
      );
    }
    return {
      coordinates: result.path,
      distanceMeters: result.distanceMeters,
      durationSeconds: result.durationSeconds,
    };
  }

  @Post('route-stops')
  async createRouteStop(@Body() dto: CreateBusRouteStopDto) {
    const result = await this.busRouteStopService.create(dto);
    await this.transitRoutingService.invalidateNetworkCache();
    this.busSimulationService.evictRoute(dto.route.toString());
    return result;
  }

  @Get('routes/:routeId/stops')
  findStopsByRoute(@Param('routeId') routeId: string) {
    return this.busRouteStopService.findByRoute(new Types.ObjectId(routeId));
  }

  @Get('stops/:stopId/routes')
  findRoutesByStop(@Param('stopId') stopId: string) {
    return this.busRouteStopService.findRoutesByStop(
      new Types.ObjectId(stopId),
    );
  }

  @Get('route-stops/:id')
  findOneRouteStop(@Param('id') id: string) {
    return this.busRouteStopService.findOne(new Types.ObjectId(id));
  }

  /**
   * Fix a single stop: send `vias` (recompute the incoming segment through
   * them) or `waypoints` (verbatim replacement polyline), or a new `stop`
   * place (both adjacent segments recomputed). stopOrder/route changes are
   * rejected — delete + re-create instead.
   */
  @Patch('route-stops/:id')
  async updateRouteStop(
    @Param('id') id: string,
    @Body() dto: UpdateBusRouteStopDto,
  ) {
    const result = await this.busRouteStopService.update(
      new Types.ObjectId(id),
      dto,
    );
    await this.transitRoutingService.invalidateNetworkCache();
    if (result.route) {
      this.busSimulationService.evictRoute(String(result.route));
    }
    return result;
  }

  /**
   * Delete one stop and heal the chain: the next stop's segment is
   * recomputed from the previous stop directly, and later stopOrders are
   * shifted down to close the hole.
   */
  @Delete('route-stops/:id')
  async removeRouteStop(@Param('id') id: string) {
    const result = await this.busRouteStopService.remove(
      new Types.ObjectId(id),
    );
    await this.transitRoutingService.invalidateNetworkCache();
    this.busSimulationService.evictRoute(result.routeId);
    return result;
  }

  // ─── Buses ─────────────────────────────────────────────────

  @Post('buses')
  createBus(@Body() dto: CreateBusDto) {
    return this.busService.create(dto);
  }

  @Get('buses')
  findAllBuses() {
    return this.busService.findAll();
  }

  @Get('buses/:id')
  findOneBus(@Param('id') id: string) {
    return this.busService.findOne(new Types.ObjectId(id));
  }

  @Patch('buses/:id')
  updateBus(@Param('id') id: string, @Body() dto: UpdateBusDto) {
    return this.busService.update(new Types.ObjectId(id), dto);
  }

  @Delete('buses/:id')
  removeBus(@Param('id') id: string) {
    return this.busService.remove(new Types.ObjectId(id));
  }

  // ─── Trips (Simulation) ───────────────────────────────────

  @Post('trips')
  createTrip(@Body() dto: CreateBusTripDto) {
    return this.busTripService.create(dto);
  }

  @Get('trips')
  findAllTrips() {
    return this.busTripService.findAll();
  }

  @Get('trips/active')
  findActiveTrips() {
    return this.busTripService.findActive();
  }

  @Get('trips/nearby')
  findNearbyTrips(
    @Query('longitude') longitude: string,
    @Query('latitude') latitude: string,
    @Query('maxDistance') maxDistance?: string,
  ) {
    return this.busTripService.findNearby(
      Number(longitude),
      Number(latitude),
      maxDistance ? Number(maxDistance) : undefined,
    );
  }

  @Get('trips/:id')
  findOneTrip(@Param('id') id: string) {
    return this.busTripService.findOne(new Types.ObjectId(id));
  }

  /**
   * One-shot ETA + next-stop info for the bus detail screen. Called when the
   * client opens the detail card so it can render immediately; the same value
   * is then kept live on the client by recomputing from MQTT position ticks.
   *
   * GET /transit/trips/:id/eta
   */
  @Get('trips/:id/eta')
  getTripEta(@Param('id') id: string) {
    return this.busTripService.getEtaToNextStop(id);
  }

  @Patch('trips/:id')
  updateTrip(@Param('id') id: string, @Body() dto: UpdateBusTripDto) {
    return this.busTripService.update(new Types.ObjectId(id), dto);
  }

  @Post('trips/:id/start')
  startTrip(@Param('id') id: string) {
    return this.busTripService.startTrip(new Types.ObjectId(id));
  }

  @Post('trips/:id/advance')
  advanceTrip(@Param('id') id: string) {
    return this.busTripService.advanceToNextStop(new Types.ObjectId(id));
  }

  @Delete('trips/:id')
  removeTrip(@Param('id') id: string) {
    return this.busTripService.remove(new Types.ObjectId(id));
  }

  // ─── Simulation ───────────────────────────────────────────────────────────

  /**
   * Returns whether the bus simulation loop is currently active and the
   * number of trips it is tracking.
   *
   * GET /transit/simulation/status
   */
  @Get('simulation/status')
  async getSimulationStatus() {
    const activeTrips = await this.busTripService.findActive();
    return {
      running: this.busSimulationService.running,
      activeTrips: activeTrips.length,
    };
  }

  /**
   * Start the simulation loop (idempotent).
   *
   * POST /transit/simulation/start
   */
  @Post('simulation/start')
  async startSimulation() {
    await this.busSimulationService.start();
    return { running: this.busSimulationService.running };
  }

  /**
   * Stop the simulation loop (idempotent).
   *
   * POST /transit/simulation/stop
   */
  @Post('simulation/stop')
  stopSimulation() {
    this.busSimulationService.stop();
    return { running: this.busSimulationService.running };
  }

  // ─── Favorite Transit Routes ──────────────────────────────────────────────

  /**
   * Save the user's chosen plan option as a favorite. The body carries the
   * skeleton (origin, destination, ordered legs of {route, board, alight})
   * — everything else is recomputed on open from the live network.
   *
   * POST /transit/favorites
   */
  @Post('favorites')
  createFavorite(@Body() dto: CreateFavoriteTransitRouteDto) {
    return this.favoriteTransitRouteService.create(dto);
  }

  /**
   * List a user's saved favorites, newest first.
   *
   * GET /transit/favorites?user=<userId>
   */
  @Get('favorites')
  listFavorites(@Query('user') userId: string) {
    return this.favoriteTransitRouteService.findByUser(
      new Types.ObjectId(userId),
    );
  }

  /**
   * Return the saved favorite (user, label, origin, destination). The client
   * then calls `GET /transit/plan` with the returned origin/destination to get
   * fresh options.
   *
   * GET /transit/favorites/:id
   */
  @Get('favorites/:id')
  getFavorite(@Param('id') id: string) {
    return this.favoriteTransitRouteService.findOne(new Types.ObjectId(id));
  }

  @Delete('favorites/:id')
  removeFavorite(@Param('id') id: string) {
    return this.favoriteTransitRouteService.remove(new Types.ObjectId(id));
  }

  // ─── Dispatch (dev only) ──────────────────────────────────────────────────

  /**
   * DEV ONLY: wipe every bus, trip, and bus-location record (Mongo) and the
   * matching Redis keys, then clear the simulator's in-memory trip cache.
   * Routes and route-stops are preserved — only the fleet is reset, so the
   * dispatch service's bootstrap path runs fresh on the next sync.
   *
   * Refuses to run when `NODE_ENV === 'production'`. Useful in development
   * after schema changes or to start over with a clean queue.
   *
   * POST /transit/dispatch/reset
   */
  @Post('dispatch/reset')
  async resetDispatch() {
    if (process.env.NODE_ENV === 'production') {
      throw new ForbiddenException(
        'Fleet reset is disabled in production. Run this in dev only.',
      );
    }
    this.busSimulationService.clearInMemoryState();
    const result = await this.busDispatchService.resetAllFleet();
    return {
      ok: true,
      ...result,
      message:
        'Fleet wiped. Routes are intact; dispatch will bootstrap fresh buses on next sync.',
    };
  }
}
