import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BusRoute, BusRouteSchema } from './entities/bus-route.schema';
import {
  BusRouteStop,
  BusRouteStopSchema,
} from './entities/bus-route-stop.schema';
import { Bus, BusSchema } from './entities/bus.schema';
import { BusTrip, BusTripSchema } from './entities/bus-trip.schema';
import { BusLocation, BusLocationSchema } from './entities/bus-location.schema';
import {
  FavoriteTransitRoute,
  FavoriteTransitRouteSchema,
} from './entities/favorite-transit-route.schema';
import { Place, PlaceSchema } from '../places/entities/place.schema';
import {
  PlaceCategory,
  PlaceCategorySchema,
} from '../places/entities/place-category.schema';
import { TransitController } from './transit.controller';
import { BusRouteService } from './bus-route.service';
import { BusRouteStopService } from './bus-route-stop.service';
import { BusService } from './bus.service';
import { BusTripService } from './bus-trip.service';
import { BusLocationService } from './bus-location.service';
import { TransitRoutingService } from './transit-routing.service';
import { BusSimulationService } from './bus-simulation.service';
import { BusDispatchService } from './bus-dispatch.service';
import { FavoriteTransitRouteService } from './favorite-transit-route.service';
import { OsrmService } from './osrm.service';
import { ValhallaService } from './valhalla.service';
import { AppSettingsModule } from '../app-settings/app-settings.module';
import { UsersModule } from '../users/user.module';
import { PlaceModule } from '../places/place.module';
import { DriverController } from './driver.controller';
import { DriverService } from './driver.service';
import { DriverLocationSubscriberService } from './driver-location-subscriber.service';
import { AdminDashboardService } from './admin-dashboard.service';
import { TransitSeedService } from './transit-seed.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BusRoute.name, schema: BusRouteSchema },
      { name: BusRouteStop.name, schema: BusRouteStopSchema },
      { name: Bus.name, schema: BusSchema },
      { name: BusTrip.name, schema: BusTripSchema },
      { name: BusLocation.name, schema: BusLocationSchema },
      { name: FavoriteTransitRoute.name, schema: FavoriteTransitRouteSchema },
      { name: Place.name, schema: PlaceSchema },
      { name: PlaceCategory.name, schema: PlaceCategorySchema },
    ]),
    AppSettingsModule,
    UsersModule,
    PlaceModule,
  ],
  controllers: [TransitController, DriverController],
  providers: [
    BusRouteService,
    BusRouteStopService,
    BusService,
    BusTripService,
    BusLocationService,
    TransitRoutingService,
    BusSimulationService,
    BusDispatchService,
    FavoriteTransitRouteService,
    OsrmService,
    ValhallaService,
    DriverService,
    DriverLocationSubscriberService,
    AdminDashboardService,
    TransitSeedService,
  ],
  exports: [
    BusRouteService,
    BusRouteStopService,
    BusService,
    BusTripService,
    BusSimulationService,
  ],
})
export class TransitModule {}
