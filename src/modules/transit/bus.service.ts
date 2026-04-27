import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Bus, BusDocument } from './entities/bus.schema';
import { CreateBusDto } from './dto/create-bus.dto';
import { UpdateBusDto } from './dto/update-bus.dto';

@Injectable()
export class BusService {
  constructor(
    @InjectModel(Bus.name)
    private readonly busModel: Model<BusDocument>,
  ) {}

  async create(dto: CreateBusDto): Promise<Bus> {
    return this.busModel.create(dto);
  }

  async findAll(): Promise<Bus[]> {
    return this.busModel.find().exec();
  }

  async findOne(id: Types.ObjectId): Promise<Bus> {
    const bus = await this.busModel.findById(id).exec();
    if (!bus) throw new NotFoundException(`Bus ${id.toString()} not found`);
    return bus;
  }

  async update(id: Types.ObjectId, dto: UpdateBusDto): Promise<Bus> {
    const bus = await this.busModel
      .findByIdAndUpdate(id, dto, { new: true })
      .exec();
    if (!bus) throw new NotFoundException(`Bus ${id.toString()} not found`);
    return bus;
  }

  async remove(id: Types.ObjectId): Promise<void> {
    const result = await this.busModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`Bus ${id.toString()} not found`);
  }
}
