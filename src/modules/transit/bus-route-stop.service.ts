import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  BusRouteStop,
  BusRouteStopDocument,
  GeoJsonLineString,
} from './entities/bus-route-stop.schema';
import { BusRoute, BusRouteDocument } from './entities/bus-route.schema';
import { Place, PlaceDocument } from '../places/entities/place.schema';
import { CreateBusRouteStopDto } from './dto/create-bus-route-stop.dto';
import { UpdateBusRouteStopDto } from './dto/update-bus-route-stop.dto';
import { BulkBusRouteStopsDto } from './dto/bulk-bus-route-stops.dto';
import { polylineLengthMeters } from '../../shared/helpers/helper-functions';

@Injectable()
export class BusRouteStopService {
  private readonly logger = new Logger(BusRouteStopService.name);

  constructor(
    @InjectModel(BusRouteStop.name)
    private readonly busRouteStopModel: Model<BusRouteStopDocument>,
    @InjectModel(BusRoute.name)
    private readonly busRouteModel: Model<BusRouteDocument>,
    @InjectModel(Place.name)
    private readonly placeModel: Model<PlaceDocument>,
  ) {}

  async create(dto: CreateBusRouteStopDto): Promise<BusRouteStop> {
    let segmentPath: GeoJsonLineString | undefined;

    if (dto.stopOrder > 1) {
      // Find previous stop (stopOrder - 1) on the same route, populated with place
      const prevStop = await this.busRouteStopModel
        .findOne({ route: dto.route, stopOrder: dto.stopOrder - 1 })
        .populate<{ stop: { location: { coordinates: [number, number] } } }>(
          'stop',
        )
        .exec();

      if (!prevStop) {
        throw new BadRequestException(
          `No stop found with stopOrder ${dto.stopOrder - 1} on this route. Add stops in order.`,
        );
      }

      const currentPlace = (await this.busRouteStopModel.db
        .model('Place')
        .findById(dto.stop)
        .select('location')
        .lean()
        .exec()) as { location: { coordinates: [number, number] } } | null;

      if (!currentPlace) {
        throw new BadRequestException(`Place ${dto.stop.toString()} not found`);
      }

      const prevCoords = prevStop.stop.location.coordinates;
      const currCoords = currentPlace.location.coordinates;
      const middle: [number, number][] = dto.waypoints ?? [];

      segmentPath = {
        type: 'LineString',
        coordinates: [prevCoords, ...middle, currCoords],
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { waypoints: _w, ...rest } = dto;
    return this.busRouteStopModel.create({ ...rest, segmentPath });
  }

  async findByRoute(routeId: Types.ObjectId): Promise<BusRouteStop[]> {
    return this.busRouteStopModel
      .find({ route: routeId })
      .sort({ stopOrder: 1 })
      .populate('stop')
      .exec();
  }

  async findRoutesByStop(stopId: Types.ObjectId): Promise<BusRouteStop[]> {
    return this.busRouteStopModel
      .find({ stop: stopId })
      .populate('route')
      .exec();
  }

  async findOne(id: Types.ObjectId): Promise<BusRouteStop> {
    const routeStop = await this.busRouteStopModel
      .findById(id)
      .populate('stop')
      .populate('route')
      .exec();
    if (!routeStop)
      throw new NotFoundException(`BusRouteStop ${id.toString()} not found`);
    return routeStop;
  }

  async update(
    id: Types.ObjectId,
    dto: UpdateBusRouteStopDto,
  ): Promise<BusRouteStop> {
    const routeStop = await this.busRouteStopModel
      .findByIdAndUpdate(id, dto, { new: true })
      .populate('stop')
      .exec();
    if (!routeStop)
      throw new NotFoundException(`BusRouteStop ${id.toString()} not found`);
    return routeStop;
  }

  async remove(id: Types.ObjectId): Promise<void> {
    const result = await this.busRouteStopModel.findByIdAndDelete(id).exec();
    if (!result)
      throw new NotFoundException(`BusRouteStop ${id.toString()} not found`);
  }

  /**
   * Bulk-create stops on a route from a sequence of (longitude, latitude, name)
   * triples picked by the admin on a map.
   *
   *   - If `routeId` is provided the new stops are appended after the existing
   *     ones; the first new stop's segmentPath routes from the previous last
   *     stop's location.
   *   - If `routeId` is omitted a new BusRoute is created from the metadata
   *     fields and stops start at stopOrder=1 with the first stop's
   *     segmentPath left null (no incoming segment).
   *
   * Each non-first stop's `segmentPath` is the road-snapped polyline from the
   * previous stop, fetched from Valhalla using `costing=auto`. On any failure
   * during the loop we roll back every doc this call created so the route is
   * never left in a half-applied state.
   */
  async bulkUpsert(dto: BulkBusRouteStopsDto): Promise<{
    routeId: string;
    createdStops: number;
    appended: boolean;
  }> {
    // Validate every placeId up-front before any writes — a missing Place
    // anywhere in the list should abort the whole call. Same placeId can
    // appear multiple times (loops); resolve to a map for O(1) lookup.
    const placeIds = dto.stops.map((s) => new Types.ObjectId(s.placeId));
    const uniqueIds = [
      ...new Map(placeIds.map((id) => [id.toString(), id])).values(),
    ];
    const places = await this.placeModel
      .find({ _id: { $in: uniqueIds } })
      .select('location')
      .lean()
      .exec();
    const placeById = new Map<
      string,
      { location: { coordinates: [number, number] } }
    >(
      places.map((p) => [
        p._id.toString(),
        p as unknown as { location: { coordinates: [number, number] } },
      ]),
    );
    for (const id of uniqueIds) {
      if (!placeById.has(id.toString())) {
        throw new BadRequestException(`Place ${id.toString()} not found`);
      }
    }

    const createdStopIds: Types.ObjectId[] = [];
    let createdRouteId: Types.ObjectId | null = null;

    let routeId: Types.ObjectId;
    let startOrder: number;
    let prevCoords: [number, number] | null = null;
    const appending = Boolean(dto.routeId);

    if (dto.routeId) {
      routeId = new Types.ObjectId(dto.routeId);
      const route = await this.busRouteModel.findById(routeId).exec();
      if (!route) throw new NotFoundException(`Route ${dto.routeId} not found`);

      // Anchor the first new stop's segment at the existing tail of the route.
      const last = await this.busRouteStopModel
        .findOne({ route: routeId })
        .sort({ stopOrder: -1 })
        .populate<{
          stop: { location: { coordinates: [number, number] } };
        }>('stop', 'location')
        .exec();

      if (last) {
        startOrder = (last.stopOrder ?? 0) + 1;
        prevCoords = last.stop.location.coordinates;
      } else {
        startOrder = 1;
      }
    } else {
      const route = await this.busRouteModel.create({
        name: dto.name ?? null,
        code: dto.code ?? null,
        isLine: dto.isLine ?? false,
      });
      routeId = route._id;
      createdRouteId = route._id;
      startOrder = 1;
    }

    try {
      for (let i = 0; i < dto.stops.length; i++) {
        const item = dto.stops[i];
        const place = placeById.get(item.placeId)!;
        const coords: [number, number] = place.location.coordinates;
        const stopOrder = startOrder + i;
        let segmentPath: GeoJsonLineString | undefined;
        let distanceFromPrevious: number | null = null;

        // First stop in a brand-new route has no incoming segment. Every
        // subsequent stop carries the polyline the admin drew on the map.
        // We don't snap or re-route — what the admin sent is what's stored.
        if (!prevCoords) {
          if (item.segmentFromPrevious) {
            throw new BadRequestException(
              `First stop (stopOrder ${stopOrder}) must not include segmentFromPrevious`,
            );
          }
        } else {
          if (
            !item.segmentFromPrevious ||
            item.segmentFromPrevious.length < 2
          ) {
            throw new BadRequestException(
              `Stop ${stopOrder} requires segmentFromPrevious with at least 2 points`,
            );
          }
          segmentPath = {
            type: 'LineString',
            coordinates: item.segmentFromPrevious,
          };
          distanceFromPrevious = polylineLengthMeters(item.segmentFromPrevious);
        }

        const routeStop = await this.busRouteStopModel.create({
          route: routeId,
          stop: new Types.ObjectId(item.placeId),
          stopOrder,
          segmentPath,
          distanceFromPrevious,
        });
        createdStopIds.push(routeStop._id);

        prevCoords = coords;
      }

      return {
        routeId: routeId.toString(),
        createdStops: createdStopIds.length,
        appended: appending,
      };
    } catch (err) {
      this.logger.warn(
        `bulkUpsert failed, rolling back ${createdStopIds.length} stops: ${(err as Error).message}`,
      );
      if (createdStopIds.length > 0) {
        await this.busRouteStopModel
          .deleteMany({ _id: { $in: createdStopIds } })
          .exec();
      }
      if (createdRouteId) {
        await this.busRouteModel.findByIdAndDelete(createdRouteId).exec();
      }
      throw err;
    }
  }
}
