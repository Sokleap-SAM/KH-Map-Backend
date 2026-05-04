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
// import { Place, PlaceSchema } from '../places/entities/place.schema';
import { TransitController } from './transit.controller';
import { BusRouteService } from './bus-route.service';
import { BusRouteStopService } from './bus-route-stop.service';
import { BusService } from './bus.service';
import { BusTripService } from './bus-trip.service';
import { BusLocationService } from './bus-location.service';
// import { TransitRoutingService } from './transit-routing.service';
import { BusSimulationService } from './bus-simulation.service';
import { OsrmService } from './osrm.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BusRoute.name, schema: BusRouteSchema },
      { name: BusRouteStop.name, schema: BusRouteStopSchema },
      { name: Bus.name, schema: BusSchema },
      { name: BusTrip.name, schema: BusTripSchema },
      { name: BusLocation.name, schema: BusLocationSchema },
      // { name: Place.name, schema: PlaceSchema },
    ]),
  ],
  controllers: [TransitController],
  providers: [
    BusRouteService,
    BusRouteStopService,
    BusService,
    BusTripService,
    BusLocationService,
    // TransitRoutingService,
    BusSimulationService,
    OsrmService,
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
