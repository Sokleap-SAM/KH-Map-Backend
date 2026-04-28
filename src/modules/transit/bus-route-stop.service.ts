import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  BusRouteStop,
  BusRouteStopDocument,
  GeoJsonLineString,
} from './entities/bus-route-stop.schema';
import { CreateBusRouteStopDto } from './dto/create-bus-route-stop.dto';
import { UpdateBusRouteStopDto } from './dto/update-bus-route-stop.dto';

@Injectable()
export class BusRouteStopService {
  constructor(
    @InjectModel(BusRouteStop.name)
    private readonly busRouteStopModel: Model<BusRouteStopDocument>,
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

  async removeByRoute(routeId: Types.ObjectId): Promise<void> {
    await this.busRouteStopModel.deleteMany({ route: routeId }).exec();
  }
}
