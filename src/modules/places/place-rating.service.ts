import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  PlaceRating,
  PlaceRatingDocument,
} from './entities/place-rating.schema';
import { CreatePlaceRatingDto } from './dto/create-place-rating.dto';
import { UpdatePlaceRatingDto } from './dto/update-place-rating.dto';

@Injectable()
export class PlaceRatingService {
  constructor(
    @InjectModel(PlaceRating.name)
    private readonly placeRatingModel: Model<PlaceRatingDocument>,
  ) {}

  async create(dto: CreatePlaceRatingDto): Promise<PlaceRating> {
    return this.placeRatingModel.create({
      ...dto,
      userId: dto.userId.toString(),
      placeId: dto.placeId.toString(),
    });
  }

  async findAllByPlace(placeId: Types.ObjectId): Promise<PlaceRating[]> {
    return this.placeRatingModel.find({ placeId: placeId.toString() }).exec();
  }

  async findOne(id: Types.ObjectId): Promise<PlaceRating> {
    const rating = await this.placeRatingModel.findById(id).exec();
    if (!rating)
      throw new NotFoundException(`PlaceRating ${id.toString()} not found`);
    return rating;
  }

  async update(
    id: Types.ObjectId,
    dto: UpdatePlaceRatingDto,
  ): Promise<PlaceRating> {
    const rating = await this.placeRatingModel
      .findByIdAndUpdate(id, dto, { new: true })
      .exec();
    if (!rating)
      throw new NotFoundException(`PlaceRating ${id.toString()} not found`);
    return rating;
  }

  async remove(id: Types.ObjectId): Promise<void> {
    const result = await this.placeRatingModel.findByIdAndDelete(id).exec();
    if (!result)
      throw new NotFoundException(`PlaceRating ${id.toString()} not found`);
  }
}
