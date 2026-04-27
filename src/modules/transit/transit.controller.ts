import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { BusRouteService } from './bus-route.service';
import { BusRouteStopService } from './bus-route-stop.service';
import { BusService } from './bus.service';
import { BusTripService } from './bus-trip.service';
import { CreateBusRouteDto } from './dto/create-bus-route.dto';
import { UpdateBusRouteDto } from './dto/update-bus-route.dto';
import { CreateBusRouteStopDto } from './dto/create-bus-route-stop.dto';
import { UpdateBusRouteStopDto } from './dto/update-bus-route-stop.dto';
import { CreateBusDto } from './dto/create-bus.dto';
import { UpdateBusDto } from './dto/update-bus.dto';
import { CreateBusTripDto } from './dto/create-bus-trip.dto';
import { UpdateBusTripDto } from './dto/update-bus-trip.dto';

@Controller('transit')
export class TransitController {
  constructor(
    private readonly busRouteService: BusRouteService,
    private readonly busRouteStopService: BusRouteStopService,
    private readonly busService: BusService,
    private readonly busTripService: BusTripService,
  ) {}

  // ─── Bus Routes ────────────────────────────────────────────

  @Post('routes')
  createRoute(@Body() dto: CreateBusRouteDto) {
    return this.busRouteService.create(dto);
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
  updateRoute(@Param('id') id: string, @Body() dto: UpdateBusRouteDto) {
    return this.busRouteService.update(new Types.ObjectId(id), dto);
  }

  @Delete('routes/:id')
  removeRoute(@Param('id') id: string) {
    return this.busRouteService.remove(new Types.ObjectId(id));
  }

  // ─── Route Stops ───────────────────────────────────────────

  @Post('route-stops')
  createRouteStop(@Body() dto: CreateBusRouteStopDto) {
    return this.busRouteStopService.create(dto);
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

  @Patch('route-stops/:id')
  updateRouteStop(@Param('id') id: string, @Body() dto: UpdateBusRouteStopDto) {
    return this.busRouteStopService.update(new Types.ObjectId(id), dto);
  }

  @Delete('route-stops/:id')
  removeRouteStop(@Param('id') id: string) {
    return this.busRouteStopService.remove(new Types.ObjectId(id));
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
}
