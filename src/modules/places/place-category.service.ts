import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  PlaceCategory,
  PlaceCategoryDocument,
} from './entities/place-category.schema';
import { CreatePlaceCategoryDto } from './dto/create-place-category.dto';
import { UpdatePlaceCategoryDto } from './dto/update-place-category.dto';

@Injectable()
export class PlaceCategoryService {
  constructor(
    @InjectModel(PlaceCategory.name)
    private readonly placeCategoryModel: Model<PlaceCategoryDocument>,
  ) {}

  async create(dto: CreatePlaceCategoryDto): Promise<PlaceCategory> {
    return this.placeCategoryModel.create(dto);
  }

  async findAll(): Promise<PlaceCategory[]> {
    return this.placeCategoryModel.find().exec();
  }

  async findOne(id: Types.ObjectId): Promise<PlaceCategory> {
    const category = await this.placeCategoryModel.findById(id).exec();
    if (!category)
      throw new NotFoundException(`PlaceCategory ${id.toString()} not found`);
    return category;
  }

  async update(
    id: Types.ObjectId,
    dto: UpdatePlaceCategoryDto,
  ): Promise<PlaceCategory> {
    const category = await this.placeCategoryModel
      .findByIdAndUpdate(id, dto, { new: true })
      .exec();
    if (!category)
      throw new NotFoundException(`PlaceCategory ${id.toString()} not found`);
    return category;
  }

  async remove(id: Types.ObjectId): Promise<void> {
    const result = await this.placeCategoryModel.findByIdAndDelete(id).exec();
    if (!result)
      throw new NotFoundException(`PlaceCategory ${id.toString()} not found`);
  }
}
