import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { BusRoute, BusRouteDocument } from './entities/bus-route.schema';
import { CreateBusRouteDto } from './dto/create-bus-route.dto';
import { UpdateBusRouteDto } from './dto/update-bus-route.dto';

@Injectable()
export class BusRouteService {
  constructor(
    @InjectModel(BusRoute.name)
    private readonly busRouteModel: Model<BusRouteDocument>,
  ) {}

  async create(dto: CreateBusRouteDto): Promise<BusRoute> {
    return this.busRouteModel.create(dto);
  }

  async findAll(): Promise<BusRoute[]> {
    return this.busRouteModel.find().exec();
  }

  async findActive(): Promise<BusRoute[]> {
    return this.busRouteModel.find({ status: 'active' }).exec();
  }

  async findLines(): Promise<BusRoute[]> {
    return this.busRouteModel.find({ isLine: true }).exec();
  }

  async findOne(id: Types.ObjectId): Promise<BusRoute> {
    const route = await this.busRouteModel.findById(id).exec();
    if (!route)
      throw new NotFoundException(`BusRoute ${id.toString()} not found`);
    return route;
  }

  async update(id: Types.ObjectId, dto: UpdateBusRouteDto): Promise<BusRoute> {
    const route = await this.busRouteModel
      .findByIdAndUpdate(id, dto, { new: true })
      .exec();
    if (!route)
      throw new NotFoundException(`BusRoute ${id.toString()} not found`);
    return route;
  }

  async remove(id: Types.ObjectId): Promise<void> {
    const result = await this.busRouteModel.findByIdAndDelete(id).exec();
    if (!result)
      throw new NotFoundException(`BusRoute ${id.toString()} not found`);
  }
}
